import { describe, it, expect } from "vitest";
import { DEFAULT_DEPOSIT_CAP, DEFAULT_DEPOSIT_PERCENT, clampDepositRule, depositFor } from "./deposit-rule";

/**
 * THE DEPOSIT RULE (cn-v1177): a percent of the estimate's total under a dollar cap; the house default
 * is 10% up to $1,000 (the owner, 2026-11-21: "california has a 10% or $1000 cap so that should be
 * the default"). One function every reader comes through.
 */
describe("depositFor", () => {
  const ca = { percent: 10, cap: 1000 };
  const table: { why: string; total: unknown; rule: { percent: number; cap: number }; want: number }[] = [
    { why: "10% of a small job", total: 4200, rule: ca, want: 420 },
    { why: "the cap holds a big job at $1,000", total: 48_000, rule: ca, want: 1000 },
    { why: "exactly at the cap", total: 10_000, rule: ca, want: 1000 },
    { why: "rounds to the cent", total: 333.33, rule: ca, want: 33.33 },
    { why: "0 percent is no deposit (a company's choice)", total: 5000, rule: { percent: 0, cap: 1000 }, want: 0 },
    { why: "a cap of 0 is no cap", total: 48_000, rule: { percent: 10, cap: 0 }, want: 4800 },
    { why: "never more than the total", total: 50, rule: { percent: 100, cap: 0 }, want: 50 },
    { why: "a total of nothing is no deposit", total: 0, rule: ca, want: 0 },
    { why: "a negative total is no deposit", total: -200, rule: ca, want: 0 },
    { why: "a total as a string still reads", total: "2500", rule: ca, want: 250 },
    { why: "a total that is not a number is no deposit", total: "abc", rule: ca, want: 0 },
  ];
  for (const t of table) it(t.why, () => expect(depositFor(t.total, t.rule)).toBe(t.want));
});

describe("clampDepositRule — sanitize on read", () => {
  it("a company that never chose gets 10% up to $1,000", () => {
    expect(DEFAULT_DEPOSIT_PERCENT).toBe(10);
    expect(DEFAULT_DEPOSIT_CAP).toBe(1000);
    expect(clampDepositRule(null)).toEqual({ percent: 10, cap: 1000 });
    expect(clampDepositRule({})).toEqual({ percent: 10, cap: 1000 });
  });
  it("a stored 0 percent is a choice, kept", () => expect(clampDepositRule({ percent: 0 })).toEqual({ percent: 0, cap: 1000 }));
  it("clamps a percent outside 0..100 and a negative cap", () => {
    expect(clampDepositRule({ percent: 140, cap: -5 })).toEqual({ percent: 100, cap: 0 });
    expect(clampDepositRule({ percent: -3, cap: 250 })).toEqual({ percent: 0, cap: 250 });
  });
  it("a value that is not a number reads as the default; a numeric string reads as the number", () => {
    expect(clampDepositRule({ percent: "ten", cap: true })).toEqual({ percent: 10, cap: 1000 });
    expect(clampDepositRule({ percent: "12.5", cap: "750" })).toEqual({ percent: 12.5, cap: 750 });
    expect(clampDepositRule({ percent: null, cap: "" })).toEqual({ percent: 10, cap: 1000 });
  });
});
