import { describe, it, expect } from "vitest";
import {
  payLine,
  payLineFromGross,
  payRateForEntry,
  aggregatePayrollEntries,
  balanceForPerson,
  sumPayments,
  sumLockedGross,
  runningCredit,
  paymentSentence,
  voidSentence,
  sayMoney,
  periodLabel,
  toPayPaymentRow,
  lockRefusalReason,
  type PayPaymentRow,
} from "@/lib/payroll-math";

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

describe("snapshot == display: mark-paid gross equals the approval screen", () => {
  // The approval screen calls aggregatePayrollEntries(entries, tz) with profiles JOINED.
  // markPeriodPaid now calls the SAME function on entries that DON'T join profiles, passing
  // the profile's base rate as the fallback. Both paths must yield identical unpaid hours +
  // gross, or the frozen payroll_runs snapshot the accountant exports diverges from what the
  // owner approved on screen. These tests are the proof of that equality.
  const tz = "America/Los_Angeles";

  it("mixed base + override: unprofiled+fallback matches profiled join, to the cent", () => {
    const rate = 25;
    // What the approval screen loads (profiles joined, both entries unpaid):
    const displayEntries = [
      { clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 0, paid_at: null, mileage_paid_at: null, miles: 0, rate_override: null, profiles: { full_name: "Brian", hourly_rate: rate } },
      { clock_in: "2026-06-02T08:00:00Z", clock_out: "2026-06-02T16:00:00Z", lunch_minutes: 0, paid_at: null, mileage_paid_at: null, miles: 0, rate_override: 60, profiles: { full_name: "Brian", hourly_rate: rate } },
    ];
    // What markPeriodPaid fetches (NO profiles, unpaid-only query) + the base rate as fallback:
    const snapshotEntries = [
      { clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 0, rate_override: null },
      { clock_in: "2026-06-02T08:00:00Z", clock_out: "2026-06-02T16:00:00Z", lunch_minutes: 0, rate_override: 60 },
    ];
    const [disp] = aggregatePayrollEntries(displayEntries, tz);
    const [snap] = aggregatePayrollEntries(snapshotEntries, tz, rate);
    expect(snap.unpaidHours).toBe(disp.unpaidHours);
    expect(snap.unpaidGross).toBe(disp.unpaidGross);
    expect(snap.unpaidGross).toBe(680); // 8×25 + 8×60
  });

  it("lunch deductions and fractional cents carry identically through both paths", () => {
    const rate = 33.33;
    const displayEntries = [
      { clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 30, paid_at: null, mileage_paid_at: null, miles: 0, rate_override: null, profiles: { hourly_rate: rate } },
    ];
    const snapshotEntries = [
      { clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 30, rate_override: null },
    ];
    const [disp] = aggregatePayrollEntries(displayEntries, tz);
    const [snap] = aggregatePayrollEntries(snapshotEntries, tz, rate);
    expect(snap.unpaidHours).toBe(disp.unpaidHours); // 7.5
    expect(snap.unpaidGross).toBe(disp.unpaidGross); // 7.5 × 33.33 = 249.975 (raw; caller rounds once)
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

// ── OWED = EARNED − PAID (0264) ──────────────────────────────────────────────
// Erik's live numbers on the day this shipped: Brian 146.42 unpaid hours back to 2026-07-09,
// payroll_runs holding two rows in the app's whole life, and a large chunk already handed over in
// cash with nowhere to record it. These tests pin the arithmetic that has to hold for the Pay page
// to be worth trusting: a raise never restates a locked period, a payment never counts twice, and
// being ahead is a fact, not an error.
describe("balanceForPerson", () => {
  const tz = "America/Los_Angeles";
  // 8 payable hours, 8am-4pm Pacific (16:00Z is 9am PDT; the times only need to be consistent).
  const shift = (over: Partial<any> = {}) => ({
    profile_id: "brian",
    clock_in: "2026-08-03T15:00:00Z",
    clock_out: "2026-08-03T23:00:00Z", // 8h
    lunch_minutes: 0,
    miles: 0,
    paid_at: null,
    mileage_paid_at: null,
    rate_override: null,
    ...over,
  });
  const payment = (over: Partial<PayPaymentRow> = {}): PayPaymentRow => ({
    id: "pay1",
    profileId: "brian",
    amount: 100,
    paidOn: "2026-09-01",
    method: "cash",
    reference: null,
    note: null,
    needsCheck: false,
    voided: false,
    ...over,
  });
  const base = (over: Partial<Parameters<typeof balanceForPerson>[0]> = {}) =>
    balanceForPerson({
      profileId: "brian",
      name: "Brian Taylor",
      entries: [shift()],
      lockedRuns: [],
      payments: [],
      tz,
      fallbackRate: 40,
      ...over,
    });

  it("NO PAYMENTS: everything earned is owed, and the oldest unpaid day is named", () => {
    const b = base();
    expect(b).toMatchObject({
      earned: 320, // 8h × $40
      paid: 0,
      owed: 320,
      unpaidHours: 8,
      oldestUnpaid: "2026-08-03",
      lastPayment: null,
      hasOpenShift: false,
      needsCheckCount: 0,
    });
  });

  it("A PARTIAL PAYMENT: the odd amount comes straight off what is owed (the whole complaint)", () => {
    // "sometimes i need to throw his a few hundred or an off ammount" — $137.50 against $320.
    const b = base({ payments: [payment({ amount: 137.5, paidOn: "2026-08-20", method: "cash" })] });
    expect(b.paid).toBe(137.5);
    expect(b.owed).toBe(182.5);
    expect(b.lastPayment).toEqual({ amount: 137.5, paidOn: "2026-08-20", method: "cash" });
  });

  it("PAID MORE THAN EARNED: owed goes NEGATIVE, which means he is ahead, not that something broke", () => {
    // The advance-before-a-trip case. A clamp at zero here would lose the money.
    const b = base({ payments: [payment({ amount: 500 })] });
    expect(b.earned).toBe(320);
    expect(b.paid).toBe(500);
    expect(b.owed).toBe(-180);
  });

  it("A RAISE IS FORWARD ONLY: a locked period reads its FROZEN gross while the open one runs live", () => {
    // Brian worked 8h in a period that was locked when his rate was $40 (frozen gross 320), then
    // 8h in a period nobody has locked, after a raise to $50. Reading the locked hours at today's
    // rate would restate August as $400 — the silent-restatement bug this split exists to kill.
    const b = balanceForPerson({
      profileId: "brian",
      name: "Brian Taylor",
      entries: [
        shift({ paid_at: "2026-08-16T00:00:00Z" }), // locked: NOT aggregated live
        shift({ clock_in: "2026-08-20T15:00:00Z", clock_out: "2026-08-20T23:00:00Z" }), // open: live
      ],
      lockedRuns: [{ period_start: "2026-08-01", period_end: "2026-08-16", gross: 320 }],
      payments: [],
      tz,
      fallbackRate: 50, // the raise
    });
    expect(b.earned).toBe(720); // 320 frozen + 8h × $50 live — never 800, never 640
    expect(b.unpaidHours).toBe(8); // only the unlocked half is still open hours
    expect(b.oldestUnpaid).toBe("2026-08-20");
  });

  it("NEVER TWICE: a locked entry is not also aggregated live", () => {
    // Same entry, counted once through the frozen run. If the paid_at filter ever slips, earned
    // doubles and Erik pays the same hour twice — the money law, in one assertion.
    const b = balanceForPerson({
      profileId: "brian",
      name: "Brian",
      entries: [shift({ paid_at: "2026-08-16T00:00:00Z" })],
      lockedRuns: [{ period_start: "2026-08-01", period_end: "2026-08-16", gross: 320 }],
      payments: [],
      tz,
      fallbackRate: 40,
    });
    expect(b.earned).toBe(320);
    expect(b.unpaidHours).toBe(0);
    expect(b.oldestUnpaid).toBeNull();
  });

  it("A VOIDED PAYMENT STOPS COUNTING but the row is still there (void, never delete)", () => {
    const payments = [payment({ id: "a", amount: 200 }), payment({ id: "b", amount: 100, voided: true })];
    const b = base({ payments });
    expect(b.paid).toBe(200);
    expect(b.owed).toBe(120);
    expect(b.lastPayment?.amount).toBe(200); // the voided row is not the "last payment" either
  });

  it("AN OPEN SHIFT PAYS NOTHING and says so out loud", () => {
    // The 48.50 lesson: hours that are still moving must never be quietly folded into a figure
    // somebody is about to pay from.
    const b = base({ entries: [shift(), shift({ clock_in: "2026-08-04T15:00:00Z", clock_out: null })] });
    expect(b.hasOpenShift).toBe(true);
    expect(b.earned).toBe(320); // the running shift adds nothing
    expect(b.unpaidHours).toBe(8);
  });

  it("A RATE OVERRIDE ON ONE SHIFT is paid at ITS rate, not the profile's", () => {
    const b = base({ entries: [shift(), shift({ clock_in: "2026-08-04T15:00:00Z", clock_out: "2026-08-04T23:00:00Z", rate_override: 75 })] });
    expect(b.earned).toBe(920); // 8×40 + 8×75
    expect(b.unpaidHours).toBe(16);
  });

  it("LUNCH COMES OFF THE HOURS, once, the way the lunch rule says", () => {
    const b = base({ entries: [shift({ lunch_minutes: 30 })] });
    expect(b.unpaidHours).toBe(7.5);
    expect(b.earned).toBe(300);
  });

  it("MILES ARE NOT WAGES: held miles ride along, and never touch earned", () => {
    const b = base({ entries: [shift({ miles: 42 })] });
    expect(b.earned).toBe(320);
    expect(b.heldMiles).toBe(42);
    expect(b.loggedMiles).toBe(42);
  });

  it("counts imported payments still waiting to be checked, and ignores voided ones", () => {
    const b = base({
      payments: [payment({ id: "a", needsCheck: true }), payment({ id: "b", needsCheck: true, voided: true })],
    });
    expect(b.needsCheckCount).toBe(1);
  });

  it("ignores another person's entries and payments entirely (a tech never sees another man's pay)", () => {
    const b = base({
      entries: [shift(), shift({ profile_id: "jimmy", clock_in: "2026-08-05T15:00:00Z", clock_out: "2026-08-05T23:00:00Z" })],
    });
    expect(b.earned).toBe(320);
  });

  it("a zero-hour auto-closed ghost does not date the debt to a day that owes nothing", () => {
    const b = base({
      entries: [shift(), shift({ clock_in: "2026-07-09T15:00:00Z", clock_out: "2026-07-09T15:00:00Z" })],
    });
    expect(b.oldestUnpaid).toBe("2026-08-03");
  });

  it("no entries and no runs: a clean zero, not a crash", () => {
    const b = base({ entries: [], payments: [] });
    expect(b).toMatchObject({ earned: 0, paid: 0, owed: 0, unpaidHours: 0, oldestUnpaid: null, hasOpenShift: false });
  });
});

describe("sumPayments / sumLockedGross / runningCredit", () => {
  const p = (amount: number, voided = false): PayPaymentRow => ({
    id: String(amount), profileId: "brian", amount, paidOn: "2026-09-01", method: "cash",
    reference: null, note: null, needsCheck: false, voided,
  });

  it("sums to the cent without float drift", () => {
    expect(sumPayments([p(0.1), p(0.2)])).toBe(0.3);
  });

  it("MILEAGE RUNS ARE NOT WAGES: a kind='mileage' row is refused entry to the wages side", () => {
    expect(
      sumLockedGross([
        { period_start: "2026-08-01", period_end: "2026-08-16", gross: 320, kind: "base" },
        { period_start: "2026-08-01", period_end: "2026-08-16", gross: 999, kind: "mileage" },
      ]),
    ).toBe(320);
  });

  it("credit is what the payments have not yet bought a lock with", () => {
    expect(runningCredit([p(500)], [{ period_start: "2026-08-01", period_end: "2026-08-16", gross: 320 }])).toBe(180);
  });

  it("credit goes negative when a locked period is no longer covered (what a void has to unwind)", () => {
    expect(runningCredit([p(100)], [{ period_start: "2026-08-01", period_end: "2026-08-16", gross: 320 }])).toBe(-220);
  });
});

describe("the sentences Erik reads back", () => {
  const today = "2026-09-17";

  it("names the money, the man, the method and the day, then what is left", () => {
    expect(
      paymentSentence({ name: "Brian Taylor", amount: 400, method: "cash", paidOn: today, today, locked: [], owed: 1012 }),
    ).toBe("Recorded $400 to Brian, cash, today. $1,012 left.");
  });

  it("says which period a payment locked", () => {
    expect(
      paymentSentence({
        name: "Brian Taylor", amount: 520, method: "check", paidOn: today, today,
        locked: [{ start: "2026-08-16", end: "2026-09-01" }], owed: 0,
      }),
    ).toBe("Recorded $520 to Brian, check, today. That covers Aug 16 to Aug 31 in full, so those hours are locked now. Nothing left owing.");
  });

  it("says when a man is AHEAD, in plain words, without calling it an error", () => {
    const s = paymentSentence({
      name: "Jimmy Santoliva", amount: 1500, method: "transfer", paidOn: today, today,
      locked: [{ start: "2026-08-01", end: "2026-08-16" }, { start: "2026-08-16", end: "2026-09-01" }], owed: -68,
    });
    expect(s).toContain("That covers Aug 1 to Aug 15 and Aug 16 to Aug 31 in full");
    expect(s).toContain("Jimmy is $68 ahead now.");
  });

  it("NO DEAD END: a period that could not lock says why, and that the money is recorded anyway", () => {
    const s = paymentSentence({
      name: "Brian", amount: 900, method: "other", paidOn: today, today, locked: [],
      blocked: { start: "2026-08-16", end: "2026-09-01", reason: "Brian has a shift still on the clock. Fix it on Timecards." },
      owed: 632,
    });
    expect(s).toBe(
      "Recorded $900 to Brian, today. Aug 16 to Aug 31 could not be locked yet. Brian has a shift still on the clock. Fix it on Timecards. The money is recorded either way, and it will lock on the next payment once that is fixed. $632 left.",
    );
  });

  it("a void says what it took back AND what that re-opened", () => {
    expect(
      voidSentence({
        name: "Brian Taylor", amount: 520, paidOn: "2026-09-16", today,
        unlocked: [{ start: "2026-08-16", end: "2026-09-01" }], owed: 1532,
      }),
    ).toBe("Voided the $520 payment to Brian from yesterday. Aug 16 to Aug 31 is unlocked again, so those hours are back on the open list. $1,532 left.");
  });

  it("keeps the cents when there are cents, drops them when there are not", () => {
    expect(sayMoney(1012)).toBe("$1,012");
    expect(sayMoney(1012.5)).toBe("$1,012.50");
    expect(sayMoney(-68)).toBe("$68");
  });

  it("a pay period is spoken by the last day INSIDE it, never the exclusive end", () => {
    expect(periodLabel("2026-08-16", "2026-09-01")).toBe("Aug 16 to Aug 31");
  });
});

describe("toPayPaymentRow", () => {
  it("reads voided_at as the fact 'voided', and an unknown method as 'other'", () => {
    expect(
      toPayPaymentRow({ id: "x", profile_id: "brian", amount: "137.50", paid_on: "2026-08-20", method: "zelle", needs_check: true, voided_at: "2026-09-01T00:00:00Z" }),
    ).toEqual({
      id: "x", profileId: "brian", amount: 137.5, paidOn: "2026-08-20", method: "other",
      reference: null, note: null, needsCheck: true, voided: true,
    });
  });
});

describe("lockRefusalReason", () => {
  it("says an open shift in plain words, with the fix", () => {
    expect(lockRefusalReason("Brian Taylor has an open entry inside this period — close it on Timecards first.")).toBe(
      "A shift in it is still on the clock. Close it on Timecards.",
    );
  });
  it("says an auto-closed ghost in plain words, with the fix", () => {
    expect(lockRefusalReason("Brian has an auto-closed entry inside this period — the system closed it, so nobody has checked those hours. Fix it on Timecards first.")).toContain(
      "the app closed by itself",
    );
  });
  it("NOTHING SILENT: an unrecognized refusal is forwarded word for word", () => {
    expect(lockRefusalReason("Payroll record failed. connection reset")).toBe("Payroll record failed. connection reset");
  });
  it("an empty refusal still says something", () => {
    expect(lockRefusalReason("")).toBe("Something stopped it.");
  });
});

describe("a void whose unlock is refused", () => {
  it("says the money came back, the hours did NOT, and where to go next", () => {
    const s = voidSentence({
      name: "Brian", amount: 520, paidOn: "2026-09-17", today: "2026-09-17", unlocked: [],
      blocked: { start: "2026-08-16", end: "2026-09-01", reason: "A shift in it is still on the clock. Close it on Timecards." },
      owed: 1532,
    });
    expect(s).toBe(
      "Voided the $520 payment to Brian from today. Aug 16 to Aug 31 could not be unlocked. A shift in it is still on the clock. Close it on Timecards. The payment is voided either way, but those hours are still marked paid, so undo that period on Payroll once that is sorted. $1,532 left.",
    );
  });
});

// ── WHAT THE REVIEWER CAUGHT ─────────────────────────────────────────────────
// Two blockers, both about a sentence that must stay TRUE when the reads behind it did not come
// back whole, and about a payment that must not be refused because the payee has left.
describe("when the pay periods could not be checked", () => {
  const today = "2026-09-17";

  it("says the money is saved and does NOT read out a balance it could not compute", () => {
    const s = paymentSentence({
      name: "Brian Taylor", amount: 400, method: "cash", paidOn: today, today,
      locked: [], blocked: null, owed: null, unchecked: true,
    });
    expect(s).toBe(
      "Recorded $400 to Brian, cash, today. The pay periods could not be checked just now, so nothing else was locked. The payment is saved. Reload the page to see where it leaves things.",
    );
    // THE MONEY LAW: no invented figure. Nothing that reads as an amount still owed.
    expect(s).not.toMatch(/left\.|ahead now\.|Nothing left owing/);
  });

  it("still names what DID lock before the read gave out", () => {
    const s = paymentSentence({
      name: "Brian", amount: 520, method: "check", paidOn: today, today,
      locked: [{ start: "2026-08-16", end: "2026-09-01" }], owed: null, unchecked: true,
    });
    expect(s).toContain("That covers Aug 16 to Aug 31 in full, so those hours are locked now.");
    expect(s).toContain("The payment is saved.");
  });

  it("a void says the hours it could not check are STILL LOCKED, not that they came back", () => {
    const s = voidSentence({
      name: "Brian", amount: 520, paidOn: today, today, unlocked: [], owed: null, unchecked: true,
    });
    expect(s).toBe(
      "Voided the $520 payment to Brian from today. The pay periods could not be checked just now, so any hours this payment had locked are still locked. The void is saved. Reload the page and check that person's periods.",
    );
  });

  it("a known balance is still spoken, including zero and negative", () => {
    expect(paymentSentence({ name: "Brian", amount: 400, method: "cash", paidOn: today, today, locked: [], owed: 0 }))
      .toContain("Nothing left owing.");
    expect(paymentSentence({ name: "Jimmy", amount: 400, method: "cash", paidOn: today, today, locked: [], owed: -68 }))
      .toContain("Jimmy is $68 ahead now.");
  });
});

describe("paying someone who is switched off in People", () => {
  const today = "2026-09-17";

  it("records it and STATES the fact, instead of sending Erik to reactivate a former employee", () => {
    const s = paymentSentence({
      name: "Brian Taylor", amount: 400, method: "cash", paidOn: today, today,
      locked: [], owed: 1012, inactive: true,
    });
    expect(s).toBe(
      "Recorded $400 to Brian, cash, today. Brian is switched off in People, so this is on the books but he will not see it in the app. $1,012 left.",
    );
    // 0158 makes `active` the trust root under auth_org_id/is_org_staff. Never price a cash payout
    // at handing a former employee the org's customers, jobs, schedule and timeclock back.
    expect(s).not.toMatch(/switch (them|him|her) back on|reactivate/i);
  });

  it("says nothing about it for an active person", () => {
    expect(paymentSentence({ name: "Brian", amount: 400, method: "cash", paidOn: today, today, locked: [], owed: 1012 }))
      .not.toContain("switched off");
  });
});
