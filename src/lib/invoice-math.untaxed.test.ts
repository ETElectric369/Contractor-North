import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRAW_KINDS, isDrawKind, lumpDrawAmount, lumpLineRule, recalcTotals, shouldBlockStandardImport, subtotalTaxTotal } from "./invoice-math";
import { fixedBillingsToNet } from "./unbilled-work";

/**
 * TAX IS ON THE WORK SOLD (cn-v1177). A payment request taken off a bill (a "prepaid_credit" line) is in
 * the bill's subtotal and never in its tax base: a deposit is not a discount. The third argument of
 * subtotalTaxTotal (and the sixth of recalcTotals) carries those lines; with none, EVERY figure is
 * what it was before, to the cent, for every caller.
 */
const before = (lineTotals: number[], taxRate: number) => {
  // The rollup as it stood before cn-v1177, copied: the regression's yardstick.
  const fin = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const cents = (n: number) => Math.round(n * 100) / 100;
  const subtotal = cents(lineTotals.reduce((s, n) => s + fin(n), 0));
  const tax = cents(subtotal * fin(taxRate));
  return { subtotal, tax, total: cents(subtotal + tax) };
};

describe("subtotalTaxTotal — the untaxed lines", () => {
  it("with no untaxed lines, every caller's figures are unchanged (a sweep of awkward cents and rates)", () => {
    const lines = [0.01, 2.01, 19.99, 100, 333.33, 1499.995, -250, 0.005, 12.345, -0.01, NaN as unknown as number];
    const rates = [0, 0.0725, 0.0825, 0.1, 0.0875, 0.06];
    for (let a = 0; a < lines.length; a++) {
      for (let b = a; b < lines.length; b++) {
        for (const r of rates) {
          const set = [lines[a], lines[b], lines[(a + b) % lines.length]];
          expect(subtotalTaxTotal(set, r)).toEqual(before(set, r));
          expect(subtotalTaxTotal(set, r, [])).toEqual(before(set, r));
        }
      }
    }
  });

  it("a request taken off is in the subtotal, never in the tax base; total = subtotal + tax still holds", () => {
    // $1,000 of work at 7.25%, a $300 deposit taken off: tax on $1,000, not on $700.
    const r = subtotalTaxTotal([1000], 0.0725, [-300]);
    expect(r).toEqual({ subtotal: 700, tax: 72.5, total: 772.5 });
    expect(Math.round((r.subtotal + r.tax) * 100) / 100).toBe(r.total);
  });

  it("a draw's 'Less previous billings' stays where it was: in lineTotals, in the tax base, as before", () => {
    expect(subtotalTaxTotal([1000, -300], 0.0725)).toEqual(before([1000, -300], 0.0725));
  });

  it("recalcTotals carries the same split, and its money and status follow the netted total", () => {
    const r = recalcTotals([1000], [772.5], 0.0725, "sent", [], [-300]);
    expect(r).toMatchObject({ subtotal: 700, tax: 72.5, total: 772.5, amountPaid: 772.5, status: "paid" });
    // …and with none, it is what it was.
    expect(recalcTotals([500, 49.99], [100], 0.0725, "sent")).toEqual(recalcTotals([500, 49.99], [100], 0.0725, "sent", [], []));
  });
});

describe("two pools, never mixed", () => {
  it("a payment request is not a draw: it never locks a job out of a standard invoice", () => {
    expect((DRAW_KINDS as readonly string[]).includes("prepayment")).toBe(false);
    expect(isDrawKind("prepayment")).toBe(false);
    expect(shouldBlockStandardImport("standard", false)).toBe(false);
    // activeDrawOnJob (billing/actions) reads ONLY the draw kinds, so a request never trips it, and
    // blockStandardCreateOnDrawJob is that read.
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/billing/actions.ts"), "utf8");
    const at = actions.indexOf("async function activeDrawOnJob(");
    const fn = actions.slice(at, actions.indexOf("\n}\n", at));
    expect(fn).toContain('.in("invoice_kind", [...DRAW_KINDS])');
    const block = actions.slice(actions.indexOf("async function blockStandardCreateOnDrawJob("), actions.indexOf("async function contractDrawGuard("));
    expect(block).toContain("const draw = await activeDrawOnJob(supabase, jobId);");
  });

  it("a request's money is never lump draw money, and a prepaid_credit line is never lump either", () => {
    const req = { status: "sent", invoice_kind: "prepayment", items: [{ import_source: "prepayment", line_total: 1000 }] };
    expect(lumpDrawAmount(req)).toBe(0);
    const isLump = lumpLineRule("deposit", [{ import_source: null }, { import_source: "prepaid_credit" }]);
    expect(isLump({ import_source: null })).toBe(true);
    expect(isLump({ import_source: "prepaid_credit" })).toBe(false);
    expect(isLump({ import_source: "draw_credit" })).toBe(false);
  });

  it("fixedBillingsToNet counts the draw pool only: a request is not netted by a draw, and its credit line is not a draw's", () => {
    const deposit = { id: "d", status: "paid", invoice_kind: "deposit", invoice_items: [{ import_source: null, line_total: 500 }] };
    const request = { id: "r", status: "paid", invoice_kind: "prepayment", invoice_items: [{ import_source: "prepayment", line_total: 1000 }] };
    const standard = { id: "s", status: "sent", invoice_kind: "standard", invoice_items: [{ import_source: "labor", line_total: 2000 }, { import_source: "prepaid_credit", line_total: -1000 }] };
    const draw = { id: "p", status: "sent", invoice_kind: "progress", invoice_items: [{ import_source: "labor", line_total: 900 }, { import_source: "draw_credit", line_total: -200 }] };
    expect(fixedBillingsToNet([deposit])).toBe(500);
    expect(fixedBillingsToNet([deposit, request])).toBe(500);
    expect(fixedBillingsToNet([deposit, request, standard])).toBe(500);
    expect(fixedBillingsToNet([deposit, request, standard, draw])).toBe(300);
  });
});
