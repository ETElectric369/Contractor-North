import { describe, it, expect } from "vitest";
import { payLine, payLineFromGross, payRateForEntry, aggregatePayrollEntries } from "@/lib/payroll-math";

describe("payLine (gross pay)", () => {
  it("gross = hours × rate, mileagePay = miles × rate, total = both", () => {
    expect(payLine(40, 25, 100, 0.65)).toEqual({ gross: 1000, mileagePay: 65, total: 1065 });
  });
  it("rounds to cents", () => {
    expect(payLine(7.5, 33.33, 0, 0).gross).toBe(249.98); // 249.975 → 249.98
  });
  it("zero hours/miles → zero", () => {
    expect(payLine(0, 25, 0, 0.65)).toEqual({ gross: 0, mileagePay: 0, total: 0 });
  });
  it("non-finite inputs coerce to 0 (no NaN wages)", () => {
    expect(payLine(NaN, 25, 10, 0.65)).toMatchObject({ gross: 0 });
    expect(payLine(8, NaN as any, 0, 0)).toMatchObject({ gross: 0, total: 0 });
  });
});

describe("aggregatePayrollEntries", () => {
  const entry = (over: Partial<any>) => ({
    profile_id: "p1",
    clock_in: "2026-06-01T08:00:00Z",
    clock_out: "2026-06-01T16:00:00Z", // 8h
    lunch_minutes: 0,
    miles: 0,
    paid_at: null,
    profiles: { full_name: "Brian", hourly_rate: 25 },
    ...over,
  });

  it("returns [] for no entries", () => {
    expect(aggregatePayrollEntries([])).toEqual([]);
  });

  it("aggregates one employee's unpaid hours + rate", () => {
    const [r] = aggregatePayrollEntries([entry({})]);
    expect(r).toMatchObject({ profileId: "p1", name: "Brian", rate: 25, unpaidHours: 8, paidHours: 0 });
  });

  it("deducts lunch and sums multiple entries for the same person", () => {
    const rows = aggregatePayrollEntries([entry({ lunch_minutes: 30 }), entry({ lunch_minutes: 60 })]); // 7.5 + 7
    expect(rows[0].unpaidHours).toBe(14.5);
  });

  it("splits paid vs unpaid by paid_at", () => {
    const rows = aggregatePayrollEntries([
      entry({ paid_at: "2026-06-10T00:00:00Z", miles: 20 }),
      entry({ miles: 10 }),
    ]);
    expect(rows[0]).toMatchObject({ paidHours: 8, paidMiles: 20, unpaidHours: 8, unpaidMiles: 10 });
  });

  it("one row per employee, sorted by unpaid hours desc", () => {
    const rows = aggregatePayrollEntries([
      entry({ profile_id: "a", profiles: { full_name: "A", hourly_rate: 20 } }), // 8h
      entry({ profile_id: "b", clock_out: "2026-06-01T20:00:00Z", profiles: { full_name: "B", hourly_rate: 20 } }), // 12h
    ]);
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
  });

  it("drops an employee with no countable hours (open/no-clock-out entry)", () => {
    expect(aggregatePayrollEntries([entry({ clock_out: null })])).toEqual([]);
  });

  it("a NaN miles value doesn't poison the row", () => {
    const [r] = aggregatePayrollEntries([entry({ miles: NaN })]);
    expect(r.unpaidMiles).toBe(0);
  });

  it("accumulates gross at the base rate when no override (8h × $25)", () => {
    const [r] = aggregatePayrollEntries([entry({})]);
    expect(r.unpaidGross).toBe(200);
  });

  it("BUG FIX: a mixed-rate week pays per entry, not one flat rate", () => {
    // 8h at the $25 base + 8h at a $60 supervisor override = 200 + 480 = 680, NOT 16×25=400.
    const [r] = aggregatePayrollEntries([entry({}), entry({ rate_override: 60 })]);
    expect(r.unpaidHours).toBe(16);
    expect(r.unpaidGross).toBe(680);
  });

  it("splits gross paid vs unpaid too", () => {
    const rows = aggregatePayrollEntries([
      entry({ paid_at: "2026-06-10T00:00:00Z" }), // 8h × 25 = 200 paid
      entry({ rate_override: 50 }), // 8h × 50 = 400 unpaid
    ]);
    expect(rows[0]).toMatchObject({ paidGross: 200, unpaidGross: 400 });
  });
});

describe("payRateForEntry — pay rate source of truth", () => {
  const e = (over: any, hourly?: number) => ({ rate_override: over, profiles: { hourly_rate: hourly } });
  it("rate_override wins when positive", () => {
    expect(payRateForEntry(e(60, 25))).toBe(60);
  });
  it("falls back to profile hourly_rate when no override", () => {
    expect(payRateForEntry(e(null, 25))).toBe(25);
    expect(payRateForEntry(e(0, 25))).toBe(25); // 0 = "no override"
  });
  it("uses an explicit fallback when the row carries no profile", () => {
    expect(payRateForEntry({ rate_override: null }, 30)).toBe(30);
  });
  it("never returns NaN", () => {
    expect(payRateForEntry({ rate_override: "x" } as any)).toBe(0);
  });
});

describe("payLineFromGross", () => {
  it("combines an accumulated gross with mileage, rounded to cents", () => {
    expect(payLineFromGross(680, 100, 0.65)).toEqual({ gross: 680, mileagePay: 65, total: 745 });
  });
});
