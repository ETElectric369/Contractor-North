import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { billsSettledBySupplier } from "./supplier-papers";

/**
 * THE FAILURE IS ALWAYS A SELECT LIST.
 *
 * /bills reads `bill_supplier_invoices` to work out which scanned bills already cover which
 * supplier invoices, then does `String(l.bill_id ?? "")` on every row. `bill_id` was not in the
 * projection, and a column left out of a select list does not arrive null - it is not there at
 * all, so the `?? ""` never fired and all 21 of his links collapsed to the nine-letter string
 * "undefined". The set that is supposed to hold WHICH BILLS cover an invoice held one sentinel,
 * so the "counts once" property its own comment promises could not hold, and no filter over
 * those ids could ever have been written.
 *
 * Source assertions, because this is a server component: there is no seam to call. They pin the
 * projection and the two facts that now depend on it.
 */
const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
/** The coverage reading moved here (Bills plan, Wave A) so My Day's cards read it too. */
const PAPERS = readFileSync(join(process.cwd(), "src/app/(app)/bills/supplier-papers.ts"), "utf8");

describe("the bills page asks for every column it reads", () => {
  it("selects bill_id on the supplier-invoice links it reads bill_id from", () => {
    expect(PAGE).toContain('.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id")');
    expect(PAPERS).toContain('.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id")');
    expect(PAPERS).toContain('cover(String(l.supplier_invoice_id ?? ""), String(l.bill_id ?? ""))');
    // And the page hands its links to that one reading, not a copy of it.
    expect(PAGE).toContain("links: (billLinkRows ?? []) as any[],");
  });

  /**
   * And with real ids in that set, the uncovered slice becomes writable at this layer: the bills
   * on a model-B account that no document from that supplier covers. $467.87 of his - the
   * Sunnyvale counter ticket bought on his Truckee account, which CED Truckee will never issue
   * paper for. It is named, never added to a balance.
   */
  it("works out which bills no supplier document covers, gated to that document's own account", () => {
    // ONE COVERING WALK, IN lib/supplier-owed.ts (8a982483). The page used to build its own, and
    // gate it on the stored column; it reads the walk's answer now and gates on the account each
    // paper RESOLVES to, which is the only way a ticket nobody filed can be reached at all.
    expect(PAGE).toContain("const coveredBillIds = coverage.covered;");
    expect(PAGE).toContain("const accountOfBill = (id: string) => supplierOf.get(String(id))?.accountId ?? null;");
    expect(PAGE).toContain("const noSupplierDocument = new Map<string, { total: number; bills: number; ids: string[] }>();");
    // Model B only: under model A an unpaid bill is already inside the balance.
    expect(PAGE).toContain("if (!accountId || !documentsOf.has(accountId)) continue;");
    expect(PAGE).toContain('const accountId = accountOfBill(String(b.id)) ?? "";');
    // And it reaches the card that has to say it.
    expect(PAGE).toContain("noSupplierDocument={Object.fromEntries(noSupplierDocument)}");
  });
});

/**
 * "$10k UNPAID" UNDER ALL BILLS OVER "$5k OWED" ON THE SUPPLIERS CARD (8a982483). Applying a CED
 * open list closes CED's documents (supplier_invoices.closed) and never a bill, so every ticket
 * ever bought on account read Unpaid forever. The page now reads, from the same covering walk
 * coveredBillIds uses, which on-account bills the supplier's own books call settled, and hands
 * that to the ledger's rows. bills.status is never written.
 */
describe("the bills the supplier's own closed papers cover are settled in the ledger", () => {
  const CED = "acct-ced";
  const bills = [
    { id: "b-closed", supplier_account_id: CED, status: "unpaid" },
    { id: "b-open", supplier_account_id: CED, status: "unpaid" },
    { id: "b-both", supplier_account_id: CED, status: "unpaid" },
    { id: "b-other-account", supplier_account_id: "acct-other", status: "unpaid" },
    { id: "b-counter", supplier_account_id: CED, status: "paid" },
    { id: "b-dup", supplier_account_id: CED, status: "unpaid", superseded_by_bill_id: "b-closed" },
    { id: "b-uncovered", supplier_account_id: CED, status: "unpaid" },
  ];
  const documents = [
    { id: "d-closed", supplier_account_id: CED, closed: true },
    { id: "d-open", supplier_account_id: CED, closed: false },
    { id: "d-closed-2", supplier_account_id: CED, closed: true },
  ];
  const coveringBills = new Map<string, Set<string>>([
    ["d-closed", new Set(["b-closed", "b-both", "b-other-account", "b-counter", "b-dup"])],
    ["d-open", new Set(["b-open"])],
  ]);
  // b-both is on the closed document by link and on the open one by its number: still open.
  const billsCarrying = new Map<string, string[]>([["d-open", ["b-both"]]]);

  it("one covered by a closed paper is settled; one covered by an open paper, or by both, still counts", () => {
    const settled = billsSettledBySupplier({ documents, bills, coveringBills, billsCarrying });
    expect([...settled].sort()).toEqual(["b-closed"]);
    expect(settled.has("b-open")).toBe(false);
    expect(settled.has("b-both")).toBe(false);
    // Another account's document can never settle it; a counter ticket and a set-aside duplicate
    // are not this question; an uncovered bill is not settled by anything.
    expect(settled.has("b-other-account")).toBe(false);
    expect(settled.has("b-counter")).toBe(false);
    expect(settled.has("b-dup")).toBe(false);
    expect(settled.has("b-uncovered")).toBe(false);
  });

  it("with no closed papers at all, nothing is settled (a document with no closed flag is open)", () => {
    const settled = billsSettledBySupplier({ documents: [{ id: "d-closed", supplier_account_id: CED }], bills, coveringBills, billsCarrying });
    expect(settled.size).toBe(0);
  });

  /**
   * A TICKET ON NO ACCOUNT CAN BE FOUND SETTLED NOW (8a982483).
   *
   * This is the gate that capped the first attempt at one reader of four: every covering walk
   * compared `bills.supplier_account_id` to the document's account, and `supplier_account_id` is
   * null on more than half his book - so those tickets were structurally unreachable, whatever the
   * predicate said. Identity decides now, so a ticket spelling the account's own name is on that
   * account and its closed paper can settle it.
   */
  it("reaches a ticket nobody filed, through the account's own name", () => {
    const loose = [{ id: "b-loose", supplier_account_id: null, supplier: "Northgate Electrical Distributors, Inc.", status: "unpaid" }];
    const docs = [{ id: "d-closed", supplier_account_id: CED, closed: true }];
    const covering = new Map<string, Set<string>>([["d-closed", new Set(["b-loose"])]]);
    const blind = billsSettledBySupplier({ documents: docs, bills: loose, coveringBills: covering, billsCarrying: new Map() });
    expect(blind.size).toBe(0);
    const seeing = billsSettledBySupplier({
      documents: docs,
      bills: loose,
      coveringBills: covering,
      billsCarrying: new Map(),
      accountRows: [{ id: CED, name: "Northgate Electrical Distributors" }],
    });
    expect([...seeing]).toEqual(["b-loose"]);
  });

  it("the page reads the one covering walk, only once the links read, and hands it to every ledger row", () => {
    expect(PAGE).toContain("const settledBySupplierIds: ReadonlySet<string> = linksErr ? new Set<string>() : coverage.settledBySupplier;");
    // ONE WALK, NOT FOUR: the page no longer builds its own `coverBill` loop, and it hands
    // supplierDocumentRows the accounts so a paper can be placed by the account's own name.
    expect(PAGE).toContain("const coveredBillIds = coverage.covered;");
    expect(PAGE).toContain("accountRows: (accountRows ?? []) as any[],");
    expect(PAGE).not.toContain("const coverBill = (billId: string, documentAccountId: string)");
    expect(PAGE).toContain("settledBySupplier: settledBySupplierIds.has(String(b.id)),");
    // Read-side only: no write to bills.status rides along.
    expect(PAGE).not.toMatch(/from\("bills"\)\s*\.update\(/);
  });
});

/**
 * THE LIST IS IN THE ORDER OF THE PAPER, NOT THE ORDER IT WAS TYPED (Erik, 2026-10-04).
 *
 * It ordered by `created_at`. He imported a run of old supplier invoices in one sitting and they
 * landed on top of everything recent: his first ten read Oct 1, Oct 1, Sep 29, Sep 28, Jun 29,
 * Jul 31, Sep 11, Jun 23, Jul 30, Aug 24. "all the bills were mixed and thats how i got confused af."
 *
 * A bill's own day is the only thing a person can navigate a supplier's book by, and it is the thing
 * every supplier statement is cut on ("everything has been paid and credits applied through 9/24").
 * Scrolling an entry-ordered list for what is still open is a search, not a read.
 */
describe("the bills list is ordered by the day on the paper", () => {
  it("orders by bill_date, newest first, with created_at only as the tie-break", () => {
    expect(PAGE).toContain('.order("bill_date", { ascending: false, nullsFirst: false })');
    // The tie-break still exists: several tickets dated the same day keep a stable order.
    expect(PAGE).toContain('.order("bill_date", { ascending: false, nullsFirst: false })\n      .order("created_at", { ascending: false })');
  });

  it("never orders the bills read by created_at alone again", () => {
    // The exact shape that shipped the mixing, pinned so it cannot come back on a refactor.
    expect(PAGE).not.toContain('.from("bills").select(columns(o)).order("created_at", { ascending: false })');
  });

  it("a paper nobody dated sorts LAST, never as the newest thing he owns", () => {
    expect(PAGE).toContain("nullsFirst: false");
  });
});
