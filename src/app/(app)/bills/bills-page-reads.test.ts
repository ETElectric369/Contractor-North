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
    expect(PAGE).toContain("const coveredBillIds = new Set<string>();");
    expect(PAGE).toContain("if (billAccount.get(billId) !== documentAccountId) return;");
    expect(PAGE).toContain("const noSupplierDocument = new Map<string, { total: number; bills: number; ids: string[] }>();");
    // Model B only: under model A an unpaid bill is already inside the balance.
    expect(PAGE).toContain("if (!accountId || !documentsOf.has(accountId)) continue;");
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

  it("the page builds it from the same rows, only once the links read, and hands it to every ledger row", () => {
    expect(PAGE).toContain("const settledBySupplierIds = linksErr");
    expect(PAGE).toContain("billsSettledBySupplier({ documents: (invoiceRows ?? []) as any[], bills: liveBills, coveringBills, billsCarrying })");
    expect(PAGE).toContain("settledBySupplier: settledBySupplierIds.has(String(b.id)),");
    // Read-side only: no write to bills.status rides along.
    expect(PAGE).not.toMatch(/from\("bills"\)\s*\.update\(/);
  });
});
