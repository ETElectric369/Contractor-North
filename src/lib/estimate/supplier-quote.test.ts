import { describe, it, expect } from "vitest";
import { effectiveMarkupPct } from "@/lib/pricing/markup";

/**
 * THE SUPPLIER-QUOTE MONEY RULES — pinned as pure arithmetic, because the action wraps a model
 * call and the model is never allowed near the money. The transcription is the model's; the
 * markup is code, off the same ladder as every other material line.
 */
describe("a supplier line's sell price", () => {
  const sell = (net: number, levelPct: number | null, orgDefaultPct: number) =>
    Math.round(net * (1 + effectiveMarkupPct({ levelPct, itemPct: 0, orgDefaultPct }) / 100) * 100) / 100;

  it("CED net + the customer's level markup", () => {
    // Erik's real shape: Normal level is 25%.
    expect(sell(414.83, 25, 25)).toBe(518.54);
  });

  it("falls to the org default when no level is picked", () => {
    expect(sell(100, null, 25)).toBe(125);
  });

  it("a zero markup passes the net through untouched — Vivian Builders' default", () => {
    expect(sell(88.4, null, 0)).toBe(88.4);
  });

  it("never a negative price from a negative net", () => {
    // The action clamps net at 0 before this arithmetic; pin the clamp's reason.
    const net = Math.max(0, Number("-12.50") || 0);
    expect(sell(net, 25, 25)).toBe(0);
  });
});

describe("the tax he paid is COST, not margin — landed-cost allocation", () => {
  // The supplier computed the tax proportionally to value; one factor on every net reproduces
  // that exactly, and the lines still sum to net + tax before markup.
  const landed = (net: number, extended: number, taxTotal: number) =>
    net * (1 + (extended > 0 && taxTotal > 0 ? taxTotal / extended : 0));

  it("spreads the printed tax across lines in proportion to their value", () => {
    // Two lines, $1000 extended, $80 tax (8%): each line's landed cost is net × 1.08.
    expect(landed(414.83, 1000, 80)).toBeCloseTo(448.02, 2);
    expect(landed(11.95, 1000, 80)).toBeCloseTo(12.91, 2);
  });

  it("the lines still reconcile to the quote's own total", () => {
    const lines = [
      { net: 414.83, qty: 2 },
      { net: 11.95, qty: 24 },
    ];
    const extended = lines.reduce((t, l) => t + l.net * l.qty, 0);
    const tax = 90.25;
    const rebuilt = lines.reduce((t, l) => t + landed(l.net, extended, tax) * l.qty, 0);
    expect(rebuilt).toBeCloseTo(extended + tax, 2);
  });

  it("no printed tax means nets pass through untouched — the resale-certificate case", () => {
    expect(landed(414.83, 1000, 0)).toBe(414.83);
  });

  it("a zero-markup org bills landed cost, never below it", () => {
    // Vivian Builders bills at 0% — without the tax share he would literally bill below cost on
    // every taxed line, which is the failure Erik was pointing at.
    const sell = landed(100, 1000, 80) * (1 + 0 / 100);
    expect(sell).toBeCloseTo(108, 2);
  });
});
