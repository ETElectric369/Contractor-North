import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TRIPWIRE FOR "ONE NUMBER PER BILL" (0383, task 3 2026-10-07): a bill knows how much of it is
 * paid (bills.amount_paid), and `isStillOwed` answers by that number. A reader that leaves the column
 * out of its select does not get 0 back; it gets no column at all (the projection law), and
 * `isStillOwed` then falls back to the status word — which is derived per purchase, so a part-paid
 * bill would read as owed in FULL on that screen and paid-in-full on the next. Source assertions, the
 * same shape as same-purchase-readers: every bills column list that names `status` (the mark of a
 * reader that asks whether a bill is owed) also names `amount_paid`, in each file that feeds the
 * figures; and every row mapping the figures read carries it through as `amountPaid`.
 */
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

/** Every quoted bills column list in the file: starts with `id, ` and names BOTH status and a bill's
 *  own mark (supplier or bill_number), so a jobs/quotes/invoices list with a status of its own is
 *  not mistaken for one. */
function billStatusLists(src: string): string[] {
  return [...src.matchAll(/["'`](id, [^"'`]*\bstatus\b[^"'`]*)["'`]/g)]
    .map((m) => m[1])
    .filter((s) => /\b(supplier|bill_number)\b/.test(s));
}

describe("every reader that asks whether a bill is owed reads amount_paid", () => {
  for (const file of [
    "src/lib/supplier-owed-read.ts",
    "src/lib/analytics/owner-money.ts",
    "src/app/(app)/reconcile/reconcile-read.ts",
    "src/lib/assistant-tools.ts",
  ]) {
    it(file, () => {
      const lists = billStatusLists(read(file));
      expect(lists.length, `${file} should read bills with status`).toBeGreaterThan(0);
      for (const s of lists) expect(s, `${file}: ${s}`).toContain("amount_paid");
    });
  }

  it("the job page reads it on its corrections rung, beside corrects_bill_id", () => {
    const src = read("src/app/(app)/jobs/[id]/page.tsx");
    expect(src).toContain('(withCorrects ? ", corrects_bill_id, amount_paid" : "")');
  });

  it("/bills reads it on the top rung of its missing-column ladder, beside corrects_bill_id", () => {
    const src = read("src/app/(app)/bills/page.tsx");
    expect(src).toContain('${o.corrects ? ", corrects_bill_id, amount_paid" : ""}');
    // The ladder's error test knows the column, so a database without it drops the rung in words.
    expect(src).toMatch(/isMissingColumn[\s\S]*amount_paid/);
  });

  it("every figure row the readers build carries the number through", () => {
    for (const file of ["src/app/(app)/bills/page.tsx", "src/lib/supplier-owed-read.ts", "src/lib/analytics/owner-money.ts"]) {
      expect(read(file), file).toMatch(/amountPaid: (b|r)\.amount_paid/);
    }
  });

  it("the still-owed rule answers by the number, and nothing reads the supplier's verdict as a state", () => {
    const owner = read("src/lib/supplier-owed.ts");
    expect(owner).toContain("export function isStillOwed");
    expect(owner).toContain("export function openOwed");
    // "Settled · X Says" retired with 0383: the supplier's closed paper over an open bill is a
    // disagreement Reconcile names, never a state a row wears.
    expect(owner).not.toContain("Settled · ${");
    expect(read("src/app/(app)/bills/supplier-balance.ts")).not.toContain("settledBySupplier");
  });
});
