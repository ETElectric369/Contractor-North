import { describe, it, expect } from "vitest";
import { hoursBetween, formatCurrency } from "@/lib/utils";

describe("hoursBetween", () => {
  const start = "2026-06-01T08:00:00Z";
  const plus = (h: number) => new Date(new Date(start).getTime() + h * 3_600_000).toISOString();

  it("counts the gap minus lunch", () => {
    expect(hoursBetween(start, plus(8))).toBe(8);
    expect(hoursBetween(start, plus(8), 30)).toBe(7.5);
    expect(hoursBetween(start, plus(8), 60)).toBe(7);
  });
  it("never goes negative when end precedes start", () => {
    expect(hoursBetween(plus(2), start)).toBe(0);
  });
  it("rounds to 2 decimals", () => {
    expect(hoursBetween(start, plus(67 / 60))).toBe(1.12); // 1h7m
  });
});

describe("formatCurrency", () => {
  it("formats USD with thousands + two decimals", () => {
    expect(formatCurrency(1000)).toBe("$1,000.00");
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
    expect(formatCurrency(0)).toBe("$0.00");
  });
  it("handles negatives (credit lines)", () => {
    expect(formatCurrency(-10000)).toBe("-$10,000.00");
  });
});
