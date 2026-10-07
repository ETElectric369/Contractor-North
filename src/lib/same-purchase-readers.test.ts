import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TRIPWIRE FOR "ONE PURCHASE" (0381, task 2 2026-10-07): every door that asks "is this purchase
 * already on the books?" reads a bill's corrects_bill_id, so an original and the corrections under it
 * are found, covered and offered TOGETHER by lib/same-purchase. A reader that leaves the column out
 * of its select does not get null back; it gets no column at all (the projection law), and that
 * door would offer a $95.99 correction as a purchase of its own while the $613.19 ticket under it
 * stayed "not in your books". Source assertions, the same shape as cost-scope-projection: every
 * bills column list that names supplier_invoice_number (the mark of a LedgerBill read) also names
 * corrects_bill_id, in each file that feeds the reading.
 */
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

/** Every double-quoted bills column list in the file: starts with `id, ` and names supplier_invoice_number. */
function billColumnLists(src: string): string[] {
  return [...src.matchAll(/"(id, [^"]*\bsupplier_invoice_number\b[^"]*)"/g)].map((m) => m[1]);
}

describe("every reader of 'is this purchase already on the books?' reads corrects_bill_id", () => {
  for (const file of [
    "src/app/(app)/bills/same-purchase-read.ts",
    "src/app/(app)/bills/supplier-papers.ts",
    "src/app/(app)/jobs/[id]/job-papers.ts",
    "src/lib/analytics/owner-money.ts",
    "src/lib/supplier-owed-read.ts",
  ]) {
    it(file, () => {
      const lists = billColumnLists(read(file));
      expect(lists.length, `${file} should read bills with supplier_invoice_number`).toBeGreaterThan(0);
      for (const s of lists) expect(s, `${file}: ${s}`).toContain("corrects_bill_id");
    });
  }

  it("/bills reads it on the top rung of its missing-column ladder, beside the number columns", () => {
    const src = read("src/app/(app)/bills/page.tsx");
    expect(src).toContain('", supplier_account_id, supplier_invoice_number, is_statement"');
    expect(src).toContain('${o.corrects ? ", corrects_bill_id, amount_paid" : ""}');
  });

  it("loadBooks asks for the column on every bills read, and again without it only when the database lacks it", () => {
    const src = read("src/app/(app)/organize/paperwork-core.ts");
    expect(src).toContain("const first = await q(`${cols}, corrects_bill_id`)");
    expect(src).not.toMatch(/safe<BookedBill>/);
    // Each bills column list in the file rides the ladder: none is read by `safe` alone.
    expect(billColumnLists(src).length).toBe(3);
    expect(src.match(/withCorrections<BookedBill>/g)?.length).toBe(3);
  });

  it("every LedgerBill the readers build carries the column through", () => {
    for (const file of ["src/app/(app)/bills/supplier-papers.ts", "src/app/(app)/jobs/[id]/job-papers.ts", "src/lib/analytics/owner-money.ts"]) {
      expect(read(file), file).toContain("corrects_bill_id: b.corrects_bill_id ?? null");
    }
    // same-purchase-read spreads the row (`...b`), so the column rides as read.
    const serverRead = read("src/app/(app)/bills/same-purchase-read.ts");
    expect(serverRead).toContain("...b,");
    expect(serverRead).toContain("supplier_account_id: identity.get(String(b.id))?.accountId ?? b.supplier_account_id ?? null");
  });
});
