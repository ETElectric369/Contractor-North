import { describe, it, expect } from "vitest";
import { payLine, aggregatePayrollEntries } from "@/lib/payroll-math";

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
});
