import { describe, it, expect } from "vitest";
import { summarizeMileage } from "@/lib/mileage-math";

const TZ = "America/Los_Angeles";
// 9 AM Pacific on the given day (16:00 UTC in PDT).
const at = (day: string, miles: number) => ({ clock_in: `${day}T16:00:00Z`, miles });

describe("summarizeMileage (commute baseline per day)", () => {
  it("subtracts the baseline once per day, not per trip", () => {
    // Two trips on the SAME day (4 + 4 = 8) with a 6-mi baseline → 2 business, not 0.
    const s = summarizeMileage([at("2026-06-01", 4), at("2026-06-01", 4)], 6, TZ);
    expect(s.recorded).toBe(8);
    expect(s.daysDriven).toBe(1);
    expect(s.commute).toBe(6);
    expect(s.business).toBe(2);
  });

  it("sums business miles across multiple days", () => {
    const s = summarizeMileage([at("2026-06-01", 8), at("2026-06-02", 14)], 6, TZ);
    expect(s.recorded).toBe(22);
    expect(s.daysDriven).toBe(2);
    expect(s.business).toBe(10); // (8-6) + (14-6)
    expect(s.commute).toBe(12);
  });

  it("never goes negative — a day under the baseline is all commute", () => {
    const s = summarizeMileage([at("2026-06-01", 4)], 6, TZ);
    expect(s.business).toBe(0);
    expect(s.commute).toBe(4);
  });

  it("baseline 0 → everything is business", () => {
    const s = summarizeMileage([at("2026-06-01", 8), at("2026-06-02", 14)], 0, TZ);
    expect(s.business).toBe(22);
    expect(s.commute).toBe(0);
  });

  it("ignores entries with no miles", () => {
    const s = summarizeMileage([at("2026-06-01", 0), { clock_in: "2026-06-02T16:00:00Z" }], 6, TZ);
    expect(s.recorded).toBe(0);
    expect(s.daysDriven).toBe(0);
  });
});
