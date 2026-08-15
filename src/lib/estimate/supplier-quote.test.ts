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
