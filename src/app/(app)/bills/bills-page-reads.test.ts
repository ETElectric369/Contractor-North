import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("the bills page asks for every column it reads", () => {
  it("selects bill_id on the supplier-invoice links it reads bill_id from", () => {
    expect(PAGE).toContain('.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id")');
    expect(PAGE).toContain('cover(String(l.supplier_invoice_id ?? ""), String(l.bill_id ?? ""))');
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
