import { describe, expect, it } from "vitest";
import {
  billCategoryFor,
  describePaper,
  fileRefusal,
  findSameNumber,
  guessOf,
  isPicture,
  jobFromPaperMarks,
  normalizeDocNumber,
  NOT_FILED_YET,
  parseDestination,
  pickedBecause,
  readinessOf,
  shownDestination,
  streetKey,
  suggestedDestination,
  type MarkJob,
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

describe("where it goes: only the paper picks a job (Erik, 2026-09-24)", () => {
  it("a MARKED bill comes in with its job picked, and says why in a few words", () => {
    const marked = receipt({ proposal: { jobId: "job-1", jobFrom: "address", jobHint: "518 CRATER LAKE RD" } });
    expect(suggestedDestination(marked, ["job-1"])).toBe("job:job-1");
    expect(pickedBecause(marked)).toBe("Job picked from the address on the receipt");
    expect(pickedBecause(receipt({ doc_type: "bill", category: "Invoice", proposal: { jobId: "job-1", jobFrom: "po" } }))).toBe(
      "Job picked from the PO number on the invoice",
    );
    // A job no longer on the list is not picked.
    expect(suggestedDestination(marked, ["job-2"])).toBe("");
  });
  it("an UNMARKED bill picks nothing, not even the bucket a model liked, and has no reason line", () => {
    const unmarked = receipt({ proposal: { bucket: "Gas & Truck" } });
    expect(suggestedDestination(unmarked, ["job-1"])).toBe("");
    expect(shownDestination(null, unmarked, ["job-1"])).toBe("");
    expect(pickedBecause(unmarked)).toBeNull();
    // Both choices stay open: a job and a business cost can each be picked, and nothing files
    // until one is.
    expect(fileRefusal(unmarked, null)).toMatch(/Pick where it goes first: a job, or a business cost bucket/);
    expect(fileRefusal(unmarked, parseDestination("job:job-1"))).toBeNull();
    expect(fileRefusal(unmarked, parseDestination("cost:Gas & Truck"))).toBeNull();
  });
  it("a MODEL'S GUESS never pre-selects: it is a one-tap chip", () => {
    // The reader's own job_id, AI Suggest's pick, and a job a model wrote before marks existed.
    for (const proposal of [{ guessJobId: "job-1" }, { jobId: "job-1" }, { jobId: "job-1", jobFrom: null }]) {
      const guessed = receipt({ proposal });
      expect(suggestedDestination(guessed, ["job-1"])).toBe("");
      expect(shownDestination(null, guessed, ["job-1"])).toBe("");
      expect(guessOf(guessed, ["job-1"])).toBe("job:job-1");
    }
    // A bucket guess is a chip too, and Fees is never offered.
    expect(guessOf(receipt({ proposal: { bucket: "Gas & Truck" } }), [])).toBe("cost:Gas & Truck");
    expect(guessOf(receipt({ proposal: { bucket: "Fees" } }), [])).toBeNull();
    // A guess that is the job the paper already picked is not offered twice.
    expect(guessOf(receipt({ proposal: { jobId: "job-1", jobFrom: "address", guessJobId: "job-1" } }), ["job-1"])).toBeNull();
    // A guess that disagrees with the paper is offered beside it, and the paper's job stays picked.
    const both = receipt({ proposal: { jobId: "job-1", jobFrom: "job_number", guessJobId: "job-2" } });
    expect(suggestedDestination(both, ["job-1", "job-2"])).toBe("job:job-1");
    expect(guessOf(both, ["job-1", "job-2"])).toBe("job:job-2");
  });
  it("a paper that names two jobs picks neither", () => {
    const torn = receipt({ proposal: { jobId: "job-1", jobFrom: "address", jobConflict: "The paper points to more than one job." } });
    expect(suggestedDestination(torn, ["job-1"])).toBe("");
    expect(pickedBecause(torn)).toBeNull();
  });
  it("the picker FOLLOWS the paper until a person touches it (a row renders before it is read)", () => {
    const unread = receipt({ proposal: null });
    const read = receipt({ proposal: { jobId: "job-1", jobFrom: "job_number" } });
    // Untouched: nothing yet, then the paper's job the moment the read lands.
    expect(shownDestination(null, unread, ["job-1"])).toBe("");
    expect(shownDestination(null, read, ["job-1"])).toBe("job:job-1");
    // Touched: the person's pick wins, including picking nothing.
    expect(shownDestination("cost:Other", read, ["job-1"])).toBe("cost:Other");
    expect(shownDestination("", read, ["job-1"])).toBe("");
  });
  it("the picker's values round-trip, and a made-up bucket is nothing", () => {
    expect(parseDestination("job:abc")).toEqual({ type: "job", jobId: "abc" });
    expect(parseDestination("cost:Phone & Office")).toEqual({ type: "overhead", category: "Phone & Office" });
    expect(parseDestination("cost:Snacks")).toBeNull();
    expect(parseDestination("keep")).toEqual({ type: "keep" });
    expect(parseDestination("photo:abc")).toEqual({ type: "photo", jobId: "abc" });
    expect(parseDestination("")).toBeNull();
  });
});

describe("jobFromPaperMarks: exact, never fuzzy", () => {
  const JOBS: MarkJob[] = [
    { id: "j46", job_number: "J-046", name: "Jason Waldow", address: "518 Crater Lake", customerNames: ["Jason Waldow", null] },
    { id: "j50", job_number: "J-050", name: "Tao Zhu", address: "235 Timber Creek Rd, Truckee CA 96161", customerNames: ["Tao Zhu"] },
    { id: "j51", job_number: "J-051", name: "Tao Zhu Shop", address: "13631 Northwoods Blvd Truckee CA 96161", customerNames: ["Tao Zhu"] },
    { id: "j09", job_number: "J-009", name: "TTP #11", address: "300 W Lake Blvd, Tahoe City", customerNames: ["Tahoe Tavern Properties"] },
    { id: "j13", job_number: "J-013", name: "TTP #56", address: "300 West Lake Boulevard", customerNames: ["Tahoe Tavern Properties"] },
  ];

  it("an address on the paper finds its job, spelled any of the ways a street is spelled", () => {
    for (const address of ["518 Crater Lake Rd", "518 CRATER LAKE ROAD", "518 crater lake, Chilcoot CA"])
      expect(jobFromPaperMarks({ address }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "address" });
    expect(jobFromPaperMarks({ address: "235 TIMBER CREEK" }, JOBS)).toMatchObject({ kind: "one", jobId: "j50" });
  });
  it("a near address is NOT a match: a different house number, a different word, no house number", () => {
    expect(jobFromPaperMarks({ address: "13466 Northwoods Blvd" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ address: "518 Crater Lakeview Rd" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ address: "Crater Lake Rd" }, JOBS)).toEqual({ kind: "none" });
    expect(streetKey("Crater Lake Rd")).toBeNull();
  });
  it("a street shared by several jobs picks none of them", () => {
    expect(jobFromPaperMarks({ address: "300 W Lake Blvd #11" }, JOBS)).toEqual({ kind: "none" });
  });
  it("a job number or a PO number, however it is punctuated", () => {
    expect(jobFromPaperMarks({ jobNumber: "j046" }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "job_number" });
    expect(jobFromPaperMarks({ po: "J 050" }, JOBS)).toMatchObject({ kind: "one", jobId: "j50", from: "po" });
    // A PO this org wrote names its job.
    expect(jobFromPaperMarks({ po: "PO-0012" }, JOBS, [{ po_number: "PO-0012", job_id: "j51" }])).toMatchObject({ kind: "one", jobId: "j51", from: "po" });
    // A PO on a job that isn't open picks nothing.
    expect(jobFromPaperMarks({ po: "PO-0013" }, JOBS, [{ po_number: "PO-0013", job_id: "closed" }])).toEqual({ kind: "none" });
    // "46" is not J-046.
    expect(jobFromPaperMarks({ jobNumber: "46" }, JOBS)).toEqual({ kind: "none" });
  });
  it("a job name or a customer, exactly; a customer with two open jobs picks neither", () => {
    expect(jobFromPaperMarks({ jobName: "JASON WALDOW" }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "job_name" });
    expect(jobFromPaperMarks({ jobName: "Jason Waldo" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ customer: "jason waldow" }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "customer" });
    expect(jobFromPaperMarks({ customer: "Tao Zhu" }, JOBS)).toEqual({ kind: "none" });
    // ...unless another mark on the same paper settles which.
    expect(jobFromPaperMarks({ customer: "Tao Zhu", address: "13631 Northwoods Blvd" }, JOBS)).toMatchObject({ kind: "one", jobId: "j51", from: "address" });
  });
  it("two marks naming two different jobs pick nothing, and say so", () => {
    const r = jobFromPaperMarks({ jobNumber: "J-046", address: "235 Timber Creek Rd" }, JOBS);
    expect(r.kind).toBe("conflict");
    expect(r.kind === "conflict" && r.sentence).toContain("more than one job");
  });
  it("no marks, no pick", () => {
    expect(jobFromPaperMarks({}, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks(null, JOBS)).toEqual({ kind: "none" });
  });
});

describe("a plain picture asks what it is first", () => {
  const picture = (over: Partial<PaperItem> = {}): PaperItem => ({
    id: "p2",
    kind: "job_document",
    status: "needs_review",
    doc_type: "not_a_cost",
    title: "Panel, 200A main",
    category: "Photo",
    proposal: { picture: true },
    ...over,
  });
  it("a picture's row asks \"What is this?\", not where it goes", () => {
    expect(isPicture(picture())).toBe(true);
    expect(readinessOf(picture())).toEqual({ state: "picture", sentence: "What is this?" });
    expect(describePaper(picture())).toBe("Picture, Panel, 200A main");
    // A row read before the reader said "photo" is known by its category.
    expect(readinessOf(picture({ proposal: null }))).toMatchObject({ state: "picture" });
    // A permit is not a picture, and a receipt never is.
    expect(isPicture(picture({ category: "Permit", proposal: null }))).toBe(false);
    expect(isPicture(receipt({ category: "Photo" }))).toBe(false);
  });
  it("Job Photo files a picture on a job, and never a bill or receipt", () => {
    expect(fileRefusal(picture(), parseDestination("photo:job-1"))).toBeNull();
    expect(fileRefusal(picture(), parseDestination("cost:Other"))).toMatch(/Only a receipt or a bill can be a business cost/);
    expect(fileRefusal(receipt(), parseDestination("photo:job-1"))).toMatch(/not a picture/);
    expect(fileRefusal(picture({ status: "filed" }), parseDestination("photo:job-1"))).toMatch(/already filed/);
    expect(fileRefusal(picture(), null)).toMatch(/Pick where it goes first/);
  });
  it("Something Else keeps the picture on a job or in files, as any paper that isn't a cost", () => {
    expect(fileRefusal(picture(), parseDestination("keep"))).toBeNull();
    expect(fileRefusal(picture(), parseDestination("job:job-1"))).toBeNull();
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
    expect(m).toEqual([expect.objectContaining({ kind: "supplier_invoice", supplierInvoiceId: "si-1", invoiceNumber: "8802-1108330" })]);
    // Not a cost, so nothing to tie to: File It links the bill it makes.
    expect(m[0].sentence).toBe("On the CED documents list with no bill yet: 8802-1108330, $653.25. File It makes the bill and links it to that document.");
  });

  it("a CED document a bill already covers IS that bill's purchase: offered as a tie to the covering bill", () => {
    const m = findSameNumber(
      receipt({ vendor: "CED", doc_number: "8802-1108330", doc_type: "bill" }),
      {
        supplierInvoices: [
          {
            id: "si-1",
            invoice_number: "8802-1108330",
            supplier_account_id: "acct-ced",
            total: 653.25,
            covered_by: { id: "bill-7", job_id: "job-046", jobs: { job_number: "J-046", name: "Jason Waldow" } },
          },
        ],
      },
      aliases,
    );
    expect(m).toEqual([expect.objectContaining({ kind: "bill", billId: "bill-7", jobId: "job-046" })]);
    expect(m[0].sentence).toBe("Already on the books: CED document 8802-1108330, $653.25, covered by a bill on J-046 Jason Waldow.");
  });

  it("a covering bill that also carries the number is found once, not twice", () => {
    const m = findSameNumber(
      receipt({ vendor: "CED", doc_number: "8802-1108330", doc_type: "bill" }),
      {
        bills: [bill],
        supplierInvoices: [{ id: "si-1", invoice_number: "8802-1108330", supplier_account_id: "acct-ced", total: 653.25, covered_by: { id: "bill-1" } }],
      },
      aliases,
    );
    expect(m).toEqual([expect.objectContaining({ kind: "bill", billId: "bill-1" })]);
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
