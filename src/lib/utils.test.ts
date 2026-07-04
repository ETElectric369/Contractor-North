import { describe, it, expect } from "vitest";
import { hoursBetween, formatCurrency, formatCityStateZip, formatFullAddress } from "@/lib/utils";

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
    expect(formatFullAddress("10244 Schaffer Rd", "Truckee", "CA", "96161")).toBe("10244 Schaffer Rd, Truckee, CA 96161");
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
