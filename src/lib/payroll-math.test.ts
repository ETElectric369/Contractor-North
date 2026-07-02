import { describe, it, expect } from "vitest";
import { payLine, payLineFromGross, payRateForEntry, aggregatePayrollEntries } from "@/lib/payroll-math";

describe("payLine (gross pay)", () => {
  it("gross = hours × rate, mileagePay = miles × rate — SEPARATE figures, no combined total", () => {
    // toEqual is exact: a `total` key reappearing here means the buckets got re-fused.
    expect(payLine(40, 25, 100, 0.65)).toEqual({ gross: 1000, mileagePay: 65 });
  });
  it("rounds to cents", () => {
    expect(payLine(7.5, 33.33, 0, 0).gross).toBe(249.98); // 249.975 → 249.98
  });
  it("zero hours/miles → zero", () => {
    expect(payLine(0, 25, 0, 0.65)).toEqual({ gross: 0, mileagePay: 0 });
  });
  it("non-finite inputs coerce to 0 (no NaN wages)", () => {
    expect(payLine(NaN, 25, 10, 0.65)).toMatchObject({ gross: 0 });
    expect(payLine(8, NaN as any, 0, 0)).toMatchObject({ gross: 0, mileagePay: 0 });
  });
});

describe("payLineFromGross", () => {
  it("rounds an accumulated gross, mileage alongside — never one combined number", () => {
    expect(payLineFromGross(680, 100, 0.65)).toEqual({ gross: 680, mileagePay: 65 });
  });
});

describe("aggregatePayrollEntries — two buckets", () => {
  const entry = (over: Partial<any>) => ({
    profile_id: "p1",
    clock_in: "2026-06-01T08:00:00Z",
    clock_out: "2026-06-01T16:00:00Z", // 8h
    lunch_minutes: 0,
    miles: 0,
    paid_at: null,
    mileage_paid_at: null,
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

  it("splits paid vs unpaid hours + gross by paid_at", () => {
    const rows = aggregatePayrollEntries([
      entry({ paid_at: "2026-06-10T00:00:00Z" }),
      entry({ rate_override: 50 }),
    ]);
    expect(rows[0]).toMatchObject({ paidHours: 8, paidGross: 200, unpaidHours: 8, unpaidGross: 400 });
  });

  it("BASE PAYMENT DOES NOT MOVE MILES: paid_at leaves miles held (the vanishing-debt fix)", () => {
    // Base marked paid, mileage never settled — the miles must survive as held,
    // not silently vanish into a "paid" bucket the way the old paid_at split did.
    const rows = aggregatePayrollEntries([
      entry({ paid_at: "2026-06-10T00:00:00Z", miles: 20 }),
      entry({ clock_in: "2026-06-02T08:00:00Z", clock_out: "2026-06-02T16:00:00Z", miles: 10 }),
    ]);
    expect(rows[0]).toMatchObject({ paidHours: 8, unpaidHours: 8, heldMiles: 30, settledMiles: 0, loggedMiles: 30 });
  });

  it("splits miles held vs settled by mileage_paid_at — its own lock, independent of paid_at", () => {
    const rows = aggregatePayrollEntries([
      entry({ mileage_paid_at: "2026-06-10T00:00:00Z", miles: 30 }),
      entry({ clock_in: "2026-06-02T08:00:00Z", clock_out: "2026-06-02T16:00:00Z", miles: 10 }),
    ]);
    expect(rows[0]).toMatchObject({ settledMiles: 30, heldMiles: 10, loggedMiles: 40 });
  });

  it("nets the daily commute baseline off held miles (business, not raw logged)", () => {
    const rows = aggregatePayrollEntries([
      entry({ miles: 30, profiles: { full_name: "Brian", hourly_rate: 25, commute_baseline_miles: 10 } }),
    ]);
    expect(rows[0]).toMatchObject({ heldMiles: 20, loggedMiles: 30 });
  });

  it("DAY-STRADDLE (documented limit): a day with both held + settled entries double-subtracts the baseline — held reads LOW, never high", () => {
    // Same day, one settled entry + one held entry, baseline 10: whole-day truth is
    // 60 logged − 10 = 50 business, but each group nets the baseline on its own →
    // 20 + 20 = 40. The undercount is conservative (can't overstate what's owed);
    // see the note in aggregatePayrollEntries.
    const withBaseline = { full_name: "Brian", hourly_rate: 25, commute_baseline_miles: 10 };
    const rows = aggregatePayrollEntries([
      entry({ miles: 30, mileage_paid_at: "2026-06-10T00:00:00Z", profiles: withBaseline }),
      entry({ miles: 30, profiles: withBaseline }),
    ]);
    expect(rows[0]).toMatchObject({ settledMiles: 20, heldMiles: 20, loggedMiles: 60 });
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
    expect(r.heldMiles).toBe(0);
    expect(r.loggedMiles).toBe(0);
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

  it("returns an explicit per-rate hours breakdown, sorted by rate (never a silent blend)", () => {
    // The 48.24 lesson: (8×75 + 26×40)/34 blended to a number that pointed nowhere.
    // The breakdown names each rate and its hours so the odd shift points at itself.
    const [r] = aggregatePayrollEntries([entry({}), entry({ rate_override: 60 })]);
    expect(r.unpaidRates).toEqual([
      { rate: 25, hours: 8 },
      { rate: 60, hours: 8 },
    ]);
    expect(r.paidRates).toEqual([]);
  });

  it("merges same-rate entries into one breakdown line", () => {
    const [r] = aggregatePayrollEntries([entry({}), entry({ clock_in: "2026-06-02T08:00:00Z", clock_out: "2026-06-02T16:00:00Z" })]);
    expect(r.unpaidRates).toEqual([{ rate: 25, hours: 16 }]);
  });

  it("PARTLY PAID: both slices carry their own gross + rate breakdown", () => {
    // A late entry after a mark-paid: the paid slice must stay visible (with its
    // dollars) AND the unpaid slice must be independently payable.
    const rows = aggregatePayrollEntries([
      entry({ paid_at: "2026-06-10T00:00:00Z" }), // 8h × 25 = 200 paid
      entry({ clock_in: "2026-06-02T08:00:00Z", clock_out: "2026-06-02T16:00:00Z", rate_override: 50 }), // 8h × 50 = 400 unpaid
    ]);
    expect(rows[0]).toMatchObject({ paidHours: 8, paidGross: 200, unpaidHours: 8, unpaidGross: 400 });
    expect(rows[0].paidRates).toEqual([{ rate: 25, hours: 8 }]);
    expect(rows[0].unpaidRates).toEqual([{ rate: 50, hours: 8 }]);
  });

  it("row shape carries NO mileage dollars — miles are data until a human settles them", () => {
    const [r] = aggregatePayrollEntries([entry({ miles: 42 })]);
    for (const key of Object.keys(r)) {
      expect(key).not.toMatch(/mileagePay|mileageAmount|total/i);
    }
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
