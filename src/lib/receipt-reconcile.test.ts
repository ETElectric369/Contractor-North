import { describe, it, expect } from "vitest";
import { reconcileReceipt } from "./receipt-reconcile";

const L = (amount: number, description = "item") => ({ description, amount });

describe("reconcileReceipt — the check nobody was doing", () => {
  it("a receipt that adds up says nothing", () => {
    const r = reconcileReceipt(100, [L(60), L(40)]);
    expect(r).toMatchObject({ amount: 100, lineSum: 100, mismatch: false, note: "" });
  });

  it("ALWAYS records the printed total, never the line sum", () => {
    // The printed total is what was actually paid. Substituting the line sum would trade a rare
    // wrong number for a frequent one.
    expect(reconcileReceipt(412.88, [L(300)]).amount).toBe(412.88);
    expect(reconcileReceipt(50, [L(300)]).amount).toBe(50);
  });

  it("stays quiet about tax and delivery — the ordinary shortfall", () => {
    // $379.35 total, $350 of readable lines: 8% short, which is just sales tax.
    expect(reconcileReceipt(379.35, [L(200), L(150)]).mismatch).toBe(false);
  });

  it("speaks up when the lines fall far short of the total", () => {
    const r = reconcileReceipt(1000, [L(300), L(100)]);
    expect(r.mismatch).toBe(true);
    expect(r.note).toContain("$400.00");
    expect(r.note).toContain("$600.00 less");
    expect(r.note).toContain("the bill records $1000.00 either way");
  });

  it("is much less forgiving when the lines EXCEED the total", () => {
    // A real receipt's items cannot sum above what was paid. Either a line was double-counted or
    // the total was misread — and the total is the number that gets marked up and billed.
    const r = reconcileReceipt(100, [L(60), L(60)]);
    expect(r.mismatch).toBe(true);
    expect(r.note).toContain("CHECK THIS ONE");
    expect(r.note).toContain("$20.00 MORE");
  });

  it("the two directions have different thresholds, on purpose", () => {
    // 5% short: silent (tax). 5% over: flagged (impossible honestly).
    expect(reconcileReceipt(100, [L(95)]).mismatch).toBe(false);
    expect(reconcileReceipt(100, [L(105)]).mismatch).toBe(true);
  });

  it("ignores sub-dollar noise in either direction", () => {
    expect(reconcileReceipt(100, [L(99.5)]).mismatch).toBe(false);
    expect(reconcileReceipt(100, [L(100.5)]).mismatch).toBe(false);
  });

  it("no lines is not a disagreement — there is nothing to compare", () => {
    expect(reconcileReceipt(250, [])).toMatchObject({ mismatch: false, note: "", lineSum: 0 });
  });

  it("survives junk amounts without producing NaN in a note a person reads", () => {
    const r = reconcileReceipt(100, [L(NaN as unknown as number), L(40)]);
    expect(r.lineSum).toBe(40);
    expect(r.note).not.toContain("NaN");
  });

  it("reports the difference signed, so a caller can tell the directions apart", () => {
    expect(reconcileReceipt(100, [L(40)]).difference).toBe(60);
    expect(reconcileReceipt(100, [L(140)]).difference).toBe(-40);
  });
});
