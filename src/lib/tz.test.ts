import { describe, it, expect } from "vitest";
import { payPeriodBounds, payPeriodForOffset } from "@/lib/tz";

const ANCHOR = "2026-01-05"; // a Monday

describe("payPeriodBounds", () => {
  it("biweekly: the anchor day starts a period (end exclusive, +14d)", () => {
    expect(payPeriodBounds("biweekly", ANCHOR, "2026-01-05")).toEqual({ start: "2026-01-05", end: "2026-01-19" });
  });
  it("biweekly: a mid-period day maps to the same period", () => {
    expect(payPeriodBounds("biweekly", ANCHOR, "2026-01-18")).toEqual({ start: "2026-01-05", end: "2026-01-19" });
  });
  it("biweekly: the end day rolls into the next period", () => {
    expect(payPeriodBounds("biweekly", ANCHOR, "2026-01-19")).toEqual({ start: "2026-01-19", end: "2026-02-02" });
  });
  it("biweekly: a day before the anchor cascades backwards", () => {
    expect(payPeriodBounds("biweekly", ANCHOR, "2026-01-04")).toEqual({ start: "2025-12-22", end: "2026-01-05" });
  });
  it("weekly: 7-day periods from the anchor", () => {
    expect(payPeriodBounds("weekly", ANCHOR, "2026-01-06")).toEqual({ start: "2026-01-05", end: "2026-01-12" });
  });
  it("monthly: calendar month (end exclusive = 1st of next)", () => {
    expect(payPeriodBounds("monthly", ANCHOR, "2026-06-15")).toEqual({ start: "2026-06-01", end: "2026-07-01" });
  });
  it("semimonthly: splits at the 16th", () => {
    expect(payPeriodBounds("semimonthly", ANCHOR, "2026-06-15")).toEqual({ start: "2026-06-01", end: "2026-06-16" });
    expect(payPeriodBounds("semimonthly", ANCHOR, "2026-06-16")).toEqual({ start: "2026-06-16", end: "2026-07-01" });
  });
});

describe("payPeriodForOffset", () => {
  it("offset 0 is the current period, 1 the prior, 2 two back", () => {
    expect(payPeriodForOffset("biweekly", ANCHOR, "2026-01-20", 0)).toEqual({ start: "2026-01-19", end: "2026-02-02" });
    expect(payPeriodForOffset("biweekly", ANCHOR, "2026-01-20", 1)).toEqual({ start: "2026-01-05", end: "2026-01-19" });
    expect(payPeriodForOffset("biweekly", ANCHOR, "2026-01-20", 2)).toEqual({ start: "2025-12-22", end: "2026-01-05" });
  });
});
