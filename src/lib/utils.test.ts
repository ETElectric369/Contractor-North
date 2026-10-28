import { describe, it, expect } from "vitest";
import { hoursBetween, formatCurrency, formatCityStateZip, formatFullAddress, formatDate, formatDateTime } from "@/lib/utils";

describe("formatCityStateZip — the one canonical 'City, ST ZIP'", () => {
  it("joins city+state with a comma, ZIP after a SPACE (owner-chosen format)", () => {
    expect(formatCityStateZip("Truckee", "CA", "96161")).toBe("Truckee, CA 96161");
  });
  it("drops empty parts cleanly", () => {
    expect(formatCityStateZip("Truckee", "CA", null)).toBe("Truckee, CA");
    expect(formatCityStateZip(null, "CA", "96161")).toBe("CA 96161");
    expect(formatCityStateZip("Truckee", null, null)).toBe("Truckee");
    expect(formatCityStateZip(null, null, null)).toBe("");
  });
});

describe("formatFullAddress — 'Street, City, ST ZIP'", () => {
  it("prepends the street, comma-joined to the city/state/zip tail", () => {
    expect(formatFullAddress("10244 Snowbell Rd", "Truckee", "CA", "96161")).toBe("10244 Snowbell Rd, Truckee, CA 96161");
  });
  it("with no street, is just the tail", () => {
    expect(formatFullAddress(null, "Truckee", "CA", "96161")).toBe("Truckee, CA 96161");
  });
  it("empty everywhere → empty string", () => {
    expect(formatFullAddress(null, null, null, null)).toBe("");
  });
});

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

/**
 * THE SAME FIGURES IN SPANISH (cn-v1138): the trailing `lang` picks es-US; every caller that passes
 * none still reads en-US. The dollar assertions read the sign and the digits (ICU may set a
 * no-break space between them); the dates are asserted on the day, the month's Spanish name and
 * the order, never on ICU's exact punctuation.
 */
describe("the formatters in Spanish (es-US), and in English when no lang is passed", () => {
  const digits = (s: string) => s.replace(/[^\d.,$-]/g, "");

  it("money: the same dollars and cents, $ first, under es-US", () => {
    expect(digits(formatCurrency(1234.56, "es"))).toBe("$1,234.56");
    expect(digits(formatCurrency(-10000, "es"))).toBe("-$10,000.00");
    expect(formatCurrency(1234.56, "en")).toBe("$1,234.56");
    expect(formatCurrency(1234.56, null)).toBe("$1,234.56");
    // The old module const is a per-locale cache now: the same answer twice.
    expect(formatCurrency(5, "es")).toBe(formatCurrency(5, "es"));
  });

  it("a date: day first and the month's Spanish name under es-US; Oct 28, 2026 for everyone else", () => {
    expect(formatDate("2026-10-28", "America/Los_Angeles", "es")).toMatch(/^28 oct\.? (de )?2026$/);
    expect(formatDate("2026-10-28T17:15:00Z", "America/Los_Angeles", "es")).toMatch(/^28 oct\.? (de )?2026$/);
    expect(formatDate("2026-10-28")).toBe("Oct 28, 2026");
    expect(formatDate("2026-10-28", "America/Los_Angeles", undefined)).toBe("Oct 28, 2026");
    expect(formatDate("2026-10-28T17:15:00Z", "America/Los_Angeles", "en")).toBe("Oct 28, 2026");
  });

  it("a date and time: the business timezone either way, Spanish words under es-US", () => {
    const es = formatDateTime("2026-10-28T17:15:00Z", "America/Los_Angeles", "es");
    expect(es).toMatch(/^28 oct/);
    expect(es).toMatch(/10:15/);
    expect(es.toLowerCase()).toMatch(/a\.?\s?m/);
    expect(formatDateTime("2026-10-28T17:15:00Z", "America/Los_Angeles")).toBe("Oct 28, 10:15 AM");
    expect(formatDateTime("2026-10-28T17:15:00Z", "America/Los_Angeles", "en")).toBe("Oct 28, 10:15 AM");
  });
});
