import { describe, it, expect } from "vitest";
import { hoursBetween } from "@/lib/utils";
import { payPeriodBounds, todayStrInTz } from "@/lib/tz";
import {
  balanceForPerson,
  entriesOfMyPeriod,
  leftByPeriod,
  myPayPeriods,
  openPeriodsFor,
  payRateForEntry,
  toPayPaymentRow,
  type MyPayRun,
  type PayPaymentRow,
} from "@/lib/payroll-math";

/**
 * MY PAY PERIODS (cn-v1166): a worker's own statement is built from the office's own figures, to the
 * cent. These are the lane's invariants:
 *   (a) every period's `left`, plus `earlier`, is max(owed, 0) to the cent;
 *   (b) `owed` is what the Payroll page's composition gives for that person;
 *   (c) a raise never restates a locked period;
 *   (d) a partial payment makes the oldest open period partly paid, with the right left;
 *   (e) a period with a base run AND newer unpaid hours shows frozen + live and is not "paid";
 *   (f) hours marked paid with no base run back is `unreadable`;
 *   (g) openPeriodsFor gives exactly what the Payroll page's inline builder gave.
 * Stand-in people only (Sam Tillery, Dana Rook). Every day is a 2026 day in the company's zone.
 */
const TZ = "America/Los_Angeles";
const SCHEDULE = "biweekly" as const;
const ANCHOR = "2026-01-05"; // periods: Jan 5–18, Jan 19–Feb 1, Feb 2–15, Feb 16–Mar 1 …
const O = { tz: TZ, schedule: SCHEDULE, anchor: ANCHOR };

let seq = 0;
/** One entry: `day` in the company's zone, starting 8 AM local (16:00Z in winter), `hours` long. */
function entry(
  who: string,
  day: string,
  hours: number,
  more: { lunch?: number; paid?: boolean; override?: number; miles?: number; mileagePaid?: boolean; running?: boolean; rate?: number } = {},
) {
  const inIso = `${day}T16:00:00.000Z`;
  const outIso = new Date(Date.parse(inIso) + hours * 3_600_000 + (more.lunch ?? 0) * 60_000).toISOString();
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, "0")}`,
    profile_id: who,
    clock_in: inIso,
    clock_out: more.running ? null : outIso,
    status: more.running ? "open" : "closed",
    lunch_minutes: more.lunch ?? 0,
    miles: more.miles ?? 0,
    paid_at: more.paid ? "2026-03-01T00:00:00Z" : null,
    mileage_paid_at: more.mileagePaid ? "2026-03-01T00:00:00Z" : null,
    rate_override: more.override ?? null,
    split_from: null,
    profiles: { full_name: who === SAM ? "Sam Tillery" : "Dana Rook", hourly_rate: more.rate ?? null, commute_baseline_miles: 0 },
  };
}
const SAM = "11111111-1111-4111-8111-111111111111";
const DANA = "22222222-2222-4222-8222-222222222222";

const run = (start: string, end: string, gross: number, hours: number): MyPayRun => ({
  kind: "base",
  period_start: start,
  period_end: end,
  hours,
  gross,
  miles: 0,
  mileage_amount: null,
});
const pay = (who: string, amount: number, paidOn: string, voided = false): PayPaymentRow =>
  toPayPaymentRow({ id: `p-${paidOn}-${amount}`, profile_id: who, amount, paid_on: paidOn, method: "check", reference: null, needs_check: false, voided_at: voided ? "2026-03-02T00:00:00Z" : null });

const cents = (n: number) => Math.round(n * 100);
const leftPlusEarlier = (r: ReturnType<typeof myPayPeriods>) => r.periods.reduce((s, p) => s + cents(p.left), 0) + cents(r.earlier);

/** THE PAYROLL PAGE'S INLINE BUILDER, as it stood before cn-v1166, copied here as the reference. */
function oldInlineOwedPeriods(closed: any[], drawIds: Set<string>, baseRateFor: (id: string) => number) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const owedPeriods: Record<string, { start: string; end: string; gross: number }[]> = {};
  const byPerson = new Map<string, Map<string, { start: string; end: string; gross: number }>>();
  for (const e of closed) {
    if (e.paid_at) continue;
    const id = e.profile_id ? String(e.profile_id) : "";
    if (!id || drawIds.has(id)) continue;
    const day = todayStrInTz(TZ, new Date(e.clock_in));
    const p = payPeriodBounds(SCHEDULE, ANCHOR, day);
    const key = `${p.start}|${p.end}`;
    const per = byPerson.get(id) ?? new Map<string, { start: string; end: string; gross: number }>();
    const cur = per.get(key) ?? { start: p.start, end: p.end, gross: 0 };
    cur.gross += hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) * payRateForEntry(e, baseRateFor(id));
    per.set(key, cur);
    byPerson.set(id, per);
  }
  for (const [id, per] of byPerson) {
    owedPeriods[id] = [...per.values()]
      .map((x) => ({ start: x.start, end: x.end, gross: r2(x.gross) }))
      .filter((x) => x.gross > 0)
      .sort((a, b) => a.start.localeCompare(b.start));
  }
  return owedPeriods;
}

/** The Payroll page's composition for one person: its grouping, then balanceForPerson and leftByPeriod. */
function officeFor(id: string, closed: any[], open: any[], runs: (MyPayRun & { profile_id: string })[], payments: PayPaymentRow[], rate: number) {
  const mine = [...closed, ...open].filter((e) => String(e.profile_id) === id);
  const bal = balanceForPerson({
    profileId: id,
    name: "",
    entries: mine,
    lockedRuns: runs.filter((r) => r.profile_id === id && r.kind === "base").map((r) => ({ period_start: r.period_start, period_end: r.period_end, gross: Number(r.gross ?? 0) })),
    payments: payments.filter((p) => p.profileId === id),
    tz: TZ,
    fallbackRate: rate,
  });
  const periods = oldInlineOwedPeriods(closed, new Set(), () => rate)[id] ?? [];
  return { owed: bal.owed, left: leftByPeriod(periods, bal.owed) };
}

describe("openPeriodsFor is the Payroll page's builder, moved (g)", () => {
  it("gives the old inline figures to the cent for every person, with overrides, lunches, paid and running entries", () => {
    const closed = [
      entry(SAM, "2026-01-06", 7.33, { lunch: 30 }),
      entry(DANA, "2026-01-06", 8),
      entry(SAM, "2026-01-07", 8, { override: 62.5 }),
      entry(SAM, "2026-01-08", 8, { paid: true }),
      entry(DANA, "2026-01-21", 5.17, { lunch: 17 }),
      entry(SAM, "2026-01-22", 3.01),
      entry(SAM, "2026-02-03", 0.1),
      entry(SAM, "2026-02-04", 6.66, { override: 41.17 }),
      entry(DANA, "2026-02-05", 9.99, { paid: true }),
      entry(DANA, "2026-02-06", 4.2, { override: 33.33 }),
    ];
    const open = [entry(SAM, "2026-02-10", 0, { running: true }), entry(DANA, "2026-02-10", 0, { running: true })];
    const rates: Record<string, number> = { [SAM]: 38.75, [DANA]: 27.4 };
    const old = oldInlineOwedPeriods(closed, new Set(), (id) => rates[id]);
    for (const id of [SAM, DANA]) {
      // The page groups [...closed, ...open] per person and hands each person's list over.
      const mine = [...closed, ...open].filter((e) => e.profile_id === id);
      expect(openPeriodsFor(mine, { ...O, fallbackRate: rates[id] }), id).toEqual(old[id]);
    }
    expect(old[SAM].length).toBe(3);
  });

  it("a period that comes to nothing is left out, and a person with only locked hours has none", () => {
    expect(openPeriodsFor([entry(SAM, "2026-01-06", 8, { paid: true })], { ...O, fallbackRate: 40 })).toEqual([]);
    expect(openPeriodsFor([entry(SAM, "2026-01-06", 8)], { ...O, fallbackRate: 0 })).toEqual([]);
    expect(openPeriodsFor(null, { ...O, fallbackRate: 40 })).toEqual([]);
  });

  it("the Payroll page calls it and keeps no builder of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/(app)/payroll/page.tsx", "utf8");
    expect(page).toContain("const list = openPeriodsFor(mine, { tz, schedule: settings.pay_schedule, anchor: settings.pay_anchor, fallbackRate: baseRateFor(id) });");
    expect(page).toContain("if (drawIds.has(id)) continue;");
    expect(page).not.toContain("cur.gross += hoursBetween(");
    expect(page).toContain("const windowStartYmd = balanceWindowStartYmd(today);");
  });
});

describe("myPayPeriods: the worker's figures are the office's (a, b)", () => {
  const scenarios: { name: string; closed: any[]; open: any[]; runs: (MyPayRun & { profile_id: string })[]; payments: PayPaymentRow[]; rate: number }[] = [
    {
      name: "nothing paid",
      closed: [entry(SAM, "2026-01-06", 8), entry(SAM, "2026-01-20", 7.5, { lunch: 30 })],
      open: [],
      runs: [],
      payments: [],
      rate: 41.37,
    },
    {
      name: "one period locked, newer ones open, a partial payment on top",
      closed: [entry(SAM, "2026-01-06", 8, { paid: true }), entry(SAM, "2026-01-20", 8), entry(SAM, "2026-02-03", 3.33)],
      open: [entry(SAM, "2026-02-04", 0, { running: true })],
      runs: [{ ...run("2026-01-05", "2026-01-19", 320, 8), profile_id: SAM }],
      payments: [pay(SAM, 320, "2026-01-20"), pay(SAM, 101.01, "2026-02-01"), pay(SAM, 999, "2026-02-02", true)],
      rate: 40,
    },
    {
      name: "paid ahead",
      closed: [entry(SAM, "2026-01-06", 2)],
      open: [],
      runs: [],
      payments: [pay(SAM, 500, "2026-01-10")],
      rate: 40,
    },
    {
      name: "owed past the open periods (an unwind that stopped partway): earlier",
      closed: [entry(SAM, "2026-01-06", 8, { paid: true }), entry(SAM, "2026-01-20", 1)],
      open: [],
      runs: [{ ...run("2026-01-05", "2026-01-19", 320, 8), profile_id: SAM }],
      payments: [],
      rate: 40,
    },
    {
      name: "cents that do not divide",
      closed: [entry(SAM, "2026-01-06", 1.01), entry(SAM, "2026-01-07", 2.02), entry(SAM, "2026-01-20", 3.03), entry(SAM, "2026-02-03", 0.07)],
      open: [],
      runs: [],
      payments: [pay(SAM, 33.33, "2026-01-21"), pay(SAM, 0.01, "2026-01-22")],
      rate: 33.37,
    },
  ];

  for (const sc of scenarios) {
    it(`${sc.name}: left + earlier = max(owed, 0), owed and every left equal the office's`, () => {
      const r = myPayPeriods({
        profileId: SAM,
        name: "Sam Tillery",
        entries: [...sc.closed, ...sc.open],
        runs: sc.runs,
        payments: sc.payments,
        ...O,
        fallbackRate: sc.rate,
      });
      const office = officeFor(SAM, sc.closed, sc.open, sc.runs, sc.payments, sc.rate);
      // (b) owed is the office's, and so is earlier.
      expect(r.owed).toBe(office.owed);
      expect(r.earlier).toBe(office.left.earlier);
      // Every open period's left is the office's left for that period.
      for (const row of office.left.rows) {
        const mine = r.periods.find((p) => p.start === row.start && p.end === row.end);
        expect(mine?.left, row.start).toBe(row.left);
      }
      // (a) to the cent.
      expect(leftPlusEarlier(r)).toBe(Math.max(0, cents(r.owed)));
      expect(r.unreadable).toBe(false);
    });
  }

  it("newest first, and a period's figures are said in cents (no float tails)", () => {
    const sc = scenarios[4];
    const r = myPayPeriods({ profileId: SAM, name: "", entries: sc.closed, runs: [], payments: sc.payments, ...O, fallbackRate: sc.rate });
    expect(r.periods.map((p) => p.start)).toEqual(["2026-02-02", "2026-01-19", "2026-01-05"]);
    for (const p of r.periods) for (const v of [p.gross, p.paid, p.left]) expect(cents(v) / 100).toBe(v);
  });
});

describe("myPayPeriods: the rules a worker reads (c, d, e, f)", () => {
  it("(c) a raise never restates a locked period: its gross is the run's frozen gross", () => {
    const entries = [entry(SAM, "2026-01-06", 10, { paid: true }), entry(SAM, "2026-01-20", 4)];
    const runs = [run("2026-01-05", "2026-01-19", 500, 10)];
    const payments = [pay(SAM, 500, "2026-01-19")];
    const before = myPayPeriods({ profileId: SAM, name: "", entries, runs, payments, ...O, fallbackRate: 50 });
    const after = myPayPeriods({ profileId: SAM, name: "", entries, runs, payments, ...O, fallbackRate: 80 });
    const locked = (r: typeof before) => r.periods.find((p) => p.start === "2026-01-05")!;
    expect(locked(before)).toMatchObject({ gross: 500, hours: 10, paid: 500, left: 0, state: "paid", locked: true });
    expect(locked(after)).toEqual(locked(before));
    // The open hours are priced at today's rate (a raise applies forward only).
    expect(before.periods[0]).toMatchObject({ start: "2026-01-19", gross: 200, state: "unpaid" });
    expect(after.periods[0]).toMatchObject({ start: "2026-01-19", gross: 320, state: "unpaid" });
  });

  it("(d) a partial payment makes the OLDEST open period partly paid, with the right left", () => {
    const entries = [entry(SAM, "2026-01-06", 10), entry(SAM, "2026-01-20", 10)];
    const r = myPayPeriods({ profileId: SAM, name: "", entries, runs: [], payments: [pay(SAM, 150, "2026-02-01")], ...O, fallbackRate: 40 });
    expect(r.owed).toBe(650);
    const [newer, older] = r.periods;
    expect(older).toMatchObject({ start: "2026-01-05", gross: 400, paid: 150, left: 250, state: "partly" });
    expect(newer).toMatchObject({ start: "2026-01-19", gross: 400, paid: 0, left: 400, state: "unpaid" });
  });

  it("(e) a period with a base run AND newer unpaid hours: frozen + live, and not paid", () => {
    const entries = [entry(SAM, "2026-01-06", 8, { paid: true }), entry(SAM, "2026-01-09", 2)];
    const r = myPayPeriods({
      profileId: SAM,
      name: "",
      entries,
      runs: [run("2026-01-05", "2026-01-19", 400, 8)],
      payments: [pay(SAM, 400, "2026-01-19")],
      ...O,
      fallbackRate: 50,
    });
    expect(r.periods).toHaveLength(1);
    expect(r.periods[0]).toMatchObject({ start: "2026-01-05", end: "2026-01-19", hours: 10, gross: 500, paid: 400, left: 100, state: "partly", locked: true });
    expect(r.owed).toBe(100);
  });

  it("(f) hours marked paid with no base run back: unreadable (a deploy ahead of 0410 reads nothing)", () => {
    const entries = [entry(SAM, "2026-01-06", 8, { paid: true }), entry(SAM, "2026-01-20", 2)];
    expect(myPayPeriods({ profileId: SAM, name: "", entries, runs: [], payments: [pay(SAM, 320, "2026-01-19")], ...O, fallbackRate: 40 }).unreadable).toBe(true);
    // A mileage run alone does not make the wages readable.
    const mileage: MyPayRun = { kind: "mileage", period_start: "2026-01-05", period_end: "2026-01-19", hours: 0, gross: 0, miles: 30, mileage_amount: 21 };
    expect(myPayPeriods({ profileId: SAM, name: "", entries, runs: [mileage], payments: [], ...O, fallbackRate: 40 }).unreadable).toBe(true);
    expect(myPayPeriods({ profileId: SAM, name: "", entries, runs: [run("2026-01-05", "2026-01-19", 320, 8)], payments: [], ...O, fallbackRate: 40 }).unreadable).toBe(false);
    // Nothing paid yet and no runs: readable.
    expect(myPayPeriods({ profileId: SAM, name: "", entries: [entry(SAM, "2026-01-06", 1)], runs: [], payments: [], ...O, fallbackRate: 40 }).unreadable).toBe(false);
  });

  it("a period holding only a running shift is On the Clock and counts nothing; owed is short it and says so", () => {
    const entries = [entry(SAM, "2026-01-06", 8), entry(SAM, "2026-01-20", 0, { running: true })];
    const r = myPayPeriods({ profileId: SAM, name: "", entries, runs: [], payments: [], ...O, fallbackRate: 40 });
    expect(r.onClock).toBe(true);
    expect(r.periods[0]).toMatchObject({ start: "2026-01-19", state: "onClock", gross: 0, hours: 0, running: true });
    expect(r.periods[1]).toMatchObject({ start: "2026-01-05", state: "unpaid", gross: 320, running: false });
    expect(r.owed).toBe(320);
  });

  it("mileage stays apart: miles not settled, the stated settlement, and never in base pay", () => {
    const entries = [entry(SAM, "2026-01-06", 8, { miles: 42 }), entry(SAM, "2026-01-07", 8, { miles: 10, mileagePaid: true })];
    const mileage: MyPayRun = { kind: "mileage", period_start: "2026-01-05", period_end: "2026-01-19", hours: 0, gross: 0, miles: 10, mileage_amount: 7.25 };
    const r = myPayPeriods({ profileId: SAM, name: "", entries, runs: [mileage], payments: [], ...O, fallbackRate: 40 });
    expect(r.periods).toHaveLength(1);
    expect(r.periods[0]).toMatchObject({ heldMiles: 42, settledMiles: 10, mileagePaid: 7.25, gross: 640, left: 640 });
    expect(r.owed).toBe(640);
  });

  it("only his own rows count: another person's entry handed in is dropped", () => {
    const r = myPayPeriods({ profileId: SAM, name: "", entries: [entry(SAM, "2026-01-06", 1), entry(DANA, "2026-01-06", 100)], runs: [], payments: [], ...O, fallbackRate: 40 });
    expect(r.periods.map((p) => p.gross)).toEqual([40]);
  });
});

describe("a moved pay anchor: locked hours counted once, from the run, and every entry under one period", () => {
  // The runs were cut on the old anchor (Jan 5, biweekly); the company then moved its anchor to Jan 12,
  // so today's payPeriodBounds cuts Dec 29–Jan 11, Jan 12–25, Jan 26–Feb 8.
  const MOVED = { tz: TZ, schedule: SCHEDULE, anchor: "2026-01-12" };
  const entries = [
    entry(SAM, "2026-01-06", 8, { paid: true }),
    entry(SAM, "2026-01-13", 8, { paid: true }),
    entry(SAM, "2026-01-14", 2), // after the lock, inside the run's dates, not paid
    entry(SAM, "2026-01-27", 4),
    entry(SAM, "2026-01-28", 0, { running: true }),
  ];
  const runs = [run("2026-01-05", "2026-01-19", 640, 16)];
  const payments = [pay(SAM, 640, "2026-01-19")];
  const r = myPayPeriods({ profileId: SAM, name: "", entries, runs, payments, ...MOVED, fallbackRate: 40 });

  it("no row shows hours at $0.00, and the hours across rows are the true hours", () => {
    for (const p of r.periods) if (p.hours > 0) expect(p.gross, p.start).toBeGreaterThan(0);
    expect(r.periods.find((p) => p.start === "2025-12-29")).toBeUndefined();
    const trueHours = entries.filter((e) => e.clock_out).reduce((s, e) => s + hoursBetween(e.clock_in, e.clock_out!, e.lunch_minutes), 0);
    expect(r.periods.reduce((s, p) => s + p.hours, 0)).toBeCloseTo(trueHours, 6);
    expect(r.periods.map((p) => [p.start, p.end, p.hours, p.gross, p.paid, p.left, p.state, p.locked])).toEqual([
      ["2026-01-26", "2026-02-09", 4, 160, 0, 160, "unpaid", false],
      ["2026-01-12", "2026-01-26", 2, 80, 0, 80, "unpaid", false],
      ["2026-01-05", "2026-01-19", 16, 640, 640, 0, "paid", true],
    ]);
  });

  it("each entry is listed under exactly one period, by the rule the figures use", () => {
    for (const e of entries) {
      const under = r.periods.filter((p) => entriesOfMyPeriod(entries, runs, MOVED, p).includes(e));
      expect(under.length, e.clock_in).toBe(1);
    }
    expect(entriesOfMyPeriod(entries, runs, MOVED, { start: "2026-01-05", end: "2026-01-19" }).map((e) => e.clock_in.slice(0, 10))).toEqual(["2026-01-06", "2026-01-13"]);
    expect(entriesOfMyPeriod(entries, runs, MOVED, { start: "2026-01-12", end: "2026-01-26" }).map((e) => e.clock_in.slice(0, 10))).toEqual(["2026-01-14"]);
  });

  it("(a) still holds, owed is the office's balance, and the open rows are openPeriodsFor's", () => {
    expect(r.owed).toBe(240);
    expect(leftPlusEarlier(r)).toBe(Math.max(0, cents(r.owed)));
    expect(r.unreadable).toBe(false);
    const open = openPeriodsFor(entries, { ...MOVED, fallbackRate: 40 });
    for (const o of open) expect(r.periods.find((p) => p.start === o.start && p.end === o.end)?.gross).toBe(o.gross);
  });

  it("where two runs hold a day, a paid entry goes under the one that starts latest", () => {
    const two = [run("2026-01-05", "2026-01-19", 640, 16), run("2026-01-12", "2026-01-26", 320, 8)];
    expect(entriesOfMyPeriod(entries, two, MOVED, { start: "2026-01-12", end: "2026-01-26" }).map((e) => e.clock_in.slice(0, 10))).toEqual(["2026-01-13", "2026-01-14"]);
  });

  it("the never-moved case is unchanged: every entry is listed under the period payPeriodBounds gives", () => {
    const same = [entry(SAM, "2026-01-06", 8, { paid: true }), entry(SAM, "2026-01-09", 2), entry(SAM, "2026-01-20", 3)];
    const sameRuns = [run("2026-01-05", "2026-01-19", 400, 8)];
    const rr = myPayPeriods({ profileId: SAM, name: "", entries: same, runs: sameRuns, payments: [], ...O, fallbackRate: 50 });
    for (const e of same) {
      const b = payPeriodBounds(SCHEDULE, ANCHOR, todayStrInTz(TZ, new Date(e.clock_in)));
      const under = rr.periods.filter((p) => entriesOfMyPeriod(same, sameRuns, O, p).includes(e));
      expect(under.map((p) => [p.start, p.end])).toEqual([[b.start, b.end]]);
    }
  });
});
