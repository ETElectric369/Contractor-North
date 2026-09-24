import { describe, expect, it } from "vitest";
import {
  billCategoryFor,
  describePaper,
  fileRefusal,
  findSameNumber,
  normalizeDocNumber,
  NOT_FILED_YET,
  parseDestination,
  readinessOf,
  suggestedDestination,
  type PaperItem,
} from "./paperwork";
import { indexSupplierAliases } from "./supplier-identity";

/**
 * PAPER THAT HAS BEEN READ AND NOT YET FILED (0295). The gate the File It button and the server
 * both ask, and the "already on the books" match that turns a second bill into a tie.
 */

const receipt = (over: Partial<PaperItem> = {}): PaperItem => ({
  id: "p1",
  kind: "receipt",
  status: "needs_review",
  doc_type: "receipt",
  vendor: "Home Depot",
  amount: 84.12,
  payment: "paid_at_purchase",
  ...over,
});

describe("describePaper: one line, what was read", () => {
  it("says type, vendor, total and how it was paid", () => {
    expect(describePaper(receipt())).toBe("Receipt, Home Depot, $84.12, paid at the counter");
  });
  it("a bill on account", () => {
    expect(describePaper(receipt({ doc_type: "bill", vendor: "CED", amount: 653.25, payment: "on_account" }))).toBe(
      "Bill, CED, $653.25, on account",
    );
  });
  it("says so when no total was read, rather than $0.00", () => {
    expect(describePaper(receipt({ amount: null }))).toBe("Receipt, Home Depot, no total read, paid at the counter");
  });
  it("CED documents found in a PDF", () => {
    expect(
      describePaper(receipt({ doc_type: "supplier_documents", proposal: { ced: { numbers: ["8802-1108330"], total: 653.25, kinds: ["invoice"], text: "x", name: "a.pdf" } } })),
    ).toBe("CED document, 8802-1108330, $653.25");
  });
});

describe("readinessOf / fileRefusal: nothing is filed by itself, and nothing half-read is filed", () => {
  const job = { type: "job" as const, jobId: "job-1" };
  it("a read receipt with a total and a destination may be filed", () => {
    expect(readinessOf(receipt()).state).toBe("ready");
    expect(fileRefusal(receipt(), job)).toBeNull();
  });
  it("no destination picked is a refusal, never a guess", () => {
    expect(fileRefusal(receipt(), null)).toMatch(/Pick where it goes/);
  });
  it("a placeholder nothing has read cannot be filed as a cost", () => {
    const unread: PaperItem = { id: "p2", kind: "job_document", status: "needs_review", title: "IMG_0412.jpg" };
    expect(readinessOf(unread).state).toBe("not_read");
    expect(fileRefusal(unread, job)).toMatch(/hasn't been read/);
  });
  it("a receipt with no total waits for a person to type it", () => {
    expect(fileRefusal(receipt({ amount: null }), job)).toMatch(/No total was read/);
  });
  it("statements, credit memos and POs are named, not filed", () => {
    for (const t of ["statement", "credit_memo", "purchase_order"]) {
      const item = receipt({ doc_type: t, kind: "job_document" });
      expect(readinessOf(item).state).toBe("later");
      expect(fileRefusal(item, job)).toBe(NOT_FILED_YET);
      expect(NOT_FILED_YET).toBe("Not filed: this kind of paper goes in a later update.");
    }
  });
  it("an already-filed paper must be undone first", () => {
    expect(fileRefusal(receipt({ status: "filed" }), job)).toMatch(/Undo it first/);
  });
  it("only a cost can be a business cost, and a cost can't be kept in files", () => {
    expect(fileRefusal(receipt({ doc_type: "not_a_cost", kind: "job_document" }), { type: "overhead", category: "Other" })).toMatch(/Only a receipt or a bill/);
    expect(fileRefusal(receipt(), { type: "keep" })).toMatch(/This is a cost/);
  });
  it("too big to read keeps its controls and says fill it in", () => {
    const big: PaperItem = { id: "p3", kind: "job_document", status: "needs_review", proposal: { tooBig: true } };
    expect(readinessOf(big)).toEqual({ state: "too_big", sentence: "Too big to read: fill it in yourself." });
  });
});

describe("the bill carries what the paper IS, never a hard-coded Receipt", () => {
  it("a bill is a Bill", () => {
    expect(billCategoryFor({ doc_type: "bill", category: "Receipt" })).toBe("Bill");
  });
  it("an old row with the reader's category keeps it", () => {
    expect(billCategoryFor({ doc_type: null, category: "Invoice" })).toBe("Invoice");
  });
  it("a bucket name left on the row after a business-cost filing does not become the paper's type", () => {
    expect(billCategoryFor({ doc_type: null, category: "Gas & Truck" })).toBe("Receipt");
  });
});

describe("suggestions are picked, never pressed", () => {
  it("the job the paper names, if it is on the list", () => {
    expect(suggestedDestination(receipt({ proposal: { jobId: "job-1" } }), ["job-1"])).toBe("job:job-1");
    expect(suggestedDestination(receipt({ proposal: { jobId: "job-9" } }), ["job-1"])).toBe("");
  });
  it("never suggests Fees", () => {
    expect(suggestedDestination(receipt({ proposal: { bucket: "Fees" } }), [])).toBe("");
    expect(suggestedDestination(receipt({ proposal: { bucket: "Gas & Truck" } }), [])).toBe("cost:Gas & Truck");
  });
  it("the picker's values round-trip, and a made-up bucket is nothing", () => {
    expect(parseDestination("job:abc")).toEqual({ type: "job", jobId: "abc" });
    expect(parseDestination("cost:Phone & Office")).toEqual({ type: "overhead", category: "Phone & Office" });
    expect(parseDestination("cost:Snacks")).toBeNull();
    expect(parseDestination("keep")).toEqual({ type: "keep" });
    expect(parseDestination("")).toBeNull();
  });
});

describe("findSameNumber: the same purchase already on the books", () => {
  const bill = {
    id: "bill-1",
    supplier: "Consolidated Electrical Dist.",
    bill_number: "8802-1108330",
    supplier_account_id: "acct-ced",
    amount: 653.25,
    bill_date: "2026-09-17",
    job_id: "job-046",
    jobs: { job_number: "J-046", name: "Jason Waldow" },
  };
  const aliases = indexSupplierAliases([
    { alias: "Consolidated Electrical Dist.", supplier_account_id: "acct-ced" },
    { alias: "CED", supplier_account_id: "acct-ced" },
  ]);

  it("normalises the printed number", () => {
    expect(normalizeDocNumber("#8802 1108330")).toBe("88021108330");
    expect(normalizeDocNumber(" No. 8802-1108330 ")).toBe("88021108330");
    expect(normalizeDocNumber("INV# 8802-1108330")).toBe(normalizeDocNumber("8802 1108330"));
  });

  it("same number, same account through an exact alias: offered as a tie", () => {
    const m = findSameNumber(receipt({ vendor: "CED", doc_number: "8802-1108330", doc_type: "bill" }), { bills: [bill] }, aliases);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "bill", billId: "bill-1" });
    expect(m[0].sentence).toContain("J-046");
    expect(m[0].sentence).toContain("$653.25");
  });

  it("same number from a DIFFERENT supplier is two purchases", () => {
    expect(findSameNumber(receipt({ vendor: "Home Depot", doc_number: "8802-1108330" }), { bills: [bill] }, aliases)).toEqual([]);
  });

  it("no alias and a different spelling is not guessed into a match (exact only)", () => {
    expect(findSameNumber(receipt({ vendor: "Consolidated Electric", doc_number: "8802-1108330" }), { bills: [bill] }, null)).toEqual([]);
  });

  it("a paper with no number matches nothing", () => {
    expect(findSameNumber(receipt({ doc_number: null }), { bills: [bill] }, aliases)).toEqual([]);
  });

  it("the bill this paper made is not a duplicate of itself", () => {
    expect(findSameNumber(receipt({ vendor: "CED", doc_number: "8802-1108330", bill_id: "bill-1" }), { bills: [bill] }, aliases)).toEqual([]);
  });

  it("a supplier document with a long number matches even before it has an account", () => {
    const m = findSameNumber(
      receipt({ vendor: "Contractors Electrical Distributors", doc_number: "8802-1108330" }),
      { supplierInvoices: [{ id: "si-1", invoice_number: "8802-1108330", supplier_account_id: null, total: 653.25 }] },
      aliases,
    );
    expect(m).toEqual([expect.objectContaining({ kind: "supplier_invoice", supplierInvoiceId: "si-1" })]);
  });

  it("a short number is not matched on number alone", () => {
    expect(
      findSameNumber(receipt({ vendor: "Swigard's", doc_number: "1234" }), {
        supplierInvoices: [{ id: "si-2", invoice_number: "1234", supplier_account_id: null, total: 10 }],
      }),
    ).toEqual([]);
  });

  it("another paper still waiting with the same number is named", () => {
    const m = findSameNumber(receipt({ id: "p1", vendor: "Home Depot", doc_number: "H-77" }), {
      papers: [{ id: "p2", vendor: "home depot", doc_number: "h-77", status: "needs_review", bill_id: null, title: "IMG_2.jpg" }],
    });
    expect(m).toEqual([expect.objectContaining({ kind: "paper", itemId: "p2" })]);
  });
});
