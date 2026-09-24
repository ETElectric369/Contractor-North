import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * MARK PAID FREEZES WHAT IT CLAIMED, NOT WHAT IT READ.
 *
 * markPeriodPaid reads the period's unpaid closed entries, then CLAIMS them with an UPDATE
 * filtered on `paid_at IS NULL` so a concurrent lock cannot stamp the same hour twice. The gross
 * it freezes into payroll_runs used to be computed ABOVE that claim, off the whole read list — so
 * a PARTIAL claim (someone else took some rows mid-flight) filed a snapshot covering hours that
 * were already stamped and already snapshotted somewhere else. balanceForPerson sums EVERY
 * kind='base' run into `earned` and nothing ever reconciles a frozen run back to the entries, so
 * the overstatement is permanent on both /payroll and /timecards.
 *
 * It takes two things to get there and cn-v963..v966 shipped both: markPeriodPaid now has two
 * callers (the Payroll button AND applyLocks on every recordPayment), and moving the pay anchor in
 * Settings puts their two windows out of step. unmarkPeriodPaid already treats a moved anchor as a
 * real, handled state, so this is not hypothetical.
 *
 * The fixture is Erik's own row, read out of the live database on 2026-09-20: Brian Taylor's
 * Jun 8-22 pay period, six closed shifts, 34.00 hours at $40.00 = $1,360.00 — exactly the
 * payroll_runs row that is standing in production today (accde383).
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const reported = vi.hoisted(() => ({ calls: [] as { where: string }[] }));
vi.mock("@/lib/observe", () => ({
  reportError: (where: string) => {
    reported.calls.push({ where });
  },
}));

import { markPeriodPaid, recordPayment, settleMileage } from "./actions";

type Call = { table: string; verb: string; payload?: any; ids?: string[] };

/** Brian's Jun 8-22 shifts, exactly as time_entries holds them (UTC instants, minutes of lunch,
 *  the two supervisor-rate overrides). 8.0 + 5.5 + 7.0 + 4.0 + 3.5 + 6.0 = 34.00 hours. */
const BRIAN_JUNE = [
  { id: "0e28fa63-7a67-40d3-9007-231dc79c4897", clock_in: "2026-06-12T18:00:00.000Z", clock_out: "2026-06-13T02:30:00.000Z", lunch_minutes: 30, rate_override: "40.00" },
  { id: "6617f632-b8d7-4f10-a9e0-ca7ccfff7a61", clock_in: "2026-06-13T17:00:00.000Z", clock_out: "2026-06-13T23:00:00.000Z", lunch_minutes: 30, rate_override: null },
  { id: "f545c504-a33f-4ddf-a6a6-de35b26175ec", clock_in: "2026-06-14T19:30:00.000Z", clock_out: "2026-06-15T03:00:00.000Z", lunch_minutes: 30, rate_override: null },
  { id: "4d06435c-5a6f-4915-bcd7-d18f9bf257c5", clock_in: "2026-06-16T19:30:00.000Z", clock_out: "2026-06-16T23:30:00.000Z", lunch_minutes: 0, rate_override: "40.00" },
  { id: "1149e4a8-4abc-47d2-a60d-a10d885ee3de", clock_in: "2026-06-17T18:30:00.000Z", clock_out: "2026-06-17T22:00:00.000Z", lunch_minutes: 0, rate_override: null },
  { id: "636664e5-4bc0-4051-86a0-39beb24da209", clock_in: "2026-06-18T17:30:00.000Z", clock_out: "2026-06-19T00:00:00.000Z", lunch_minutes: 30, rate_override: null },
];
const BRIAN = "b0000000-0000-4000-8000-000000000001";
const PERIOD = { profileId: BRIAN, periodStart: "2026-06-08", periodEnd: "2026-06-22" };

/** Minimal scriptable PostgREST-builder fake, same shape as the purchasing/organize suites:
 *  every chained filter returns the chain, and awaiting it dequeues the next scripted result for
 *  `<table>.<verb>`. Unscripted calls throw, so the tests also pin WHICH statements run. */
function fakeSupabase(script: Record<string, any[]>, calls: Call[]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      let verb = "select";
      const call: Call = { table, verb };
      const chain: any = {
        insert(payload: any) { verb = "insert"; call.verb = verb; call.payload = payload; calls.push(call); return chain; },
        update(payload: any) { verb = "update"; call.verb = verb; call.payload = payload; calls.push(call); return chain; },
        delete() { verb = "delete"; call.verb = verb; calls.push(call); return chain; },
        select() { if (verb === "select") { call.verb = verb; calls.push(call); } return chain; },
        in(_col: string, ids: string[]) { call.ids = ids; return chain; },
        eq: () => chain,
        is: () => chain,
        not: () => chain,
        gte: () => chain,
        lt: () => chain,
        order: () => chain,
        range: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(next(`${table}.${verb}`)),
        single: () => Promise.resolve(next(`${table}.${verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

/** The whole read side of markPeriodPaid, with the claim and the rate as the knobs. */
function scriptFor(opts: { entries: any[]; claimed: string[]; rate?: string; runError?: any }) {
  return {
    "profiles.select": [{ data: { role: "owner" }, error: null }],
    "organizations.select": [{ data: { settings: { timezone: "America/Los_Angeles" } }, error: null }],
    "profile_pay.select": [{ data: { hourly_rate: opts.rate ?? "40.00" }, error: null }],
    "time_entries.select": [
      { data: [], error: null }, // openEntryError: nothing still running
      { data: [], error: null }, // autoClosedEntryError: nothing the trigger closed
      { data: opts.entries, error: null }, // the period's unpaid closed hours
    ],
    "time_entries.update": [{ data: opts.claimed.map((id) => ({ id })), error: null }],
    "payroll_runs.insert": [{ error: opts.runError ?? null }],
  };
}

let calls: Call[];
beforeEach(() => {
  calls = [];
  reported.calls = [];
});

const runInsert = () => calls.find((c) => c.table === "payroll_runs" && c.verb === "insert")?.payload;

describe("markPeriodPaid — the snapshot is priced from the rows it CLAIMED", () => {
  it("a full claim freezes Brian's real Jun 8-22 figures: 34.00 hours, $1,360.00", async () => {
    state.client = fakeSupabase(
      scriptFor({ entries: BRIAN_JUNE, claimed: BRIAN_JUNE.map((e) => e.id) }),
      calls,
    );

    expect(await markPeriodPaid(PERIOD)).toEqual({ ok: true });
    expect(runInsert()).toMatchObject({
      profile_id: BRIAN,
      period_start: "2026-06-08",
      period_end: "2026-06-22",
      kind: "base",
      hours: 34,
      rate: 40,
      gross: 1360,
    });
  });

  it("a PARTIAL claim freezes only the hours it took — not the whole read list", async () => {
    // The office pressed Mark Paid on the old Sep 1-15 window while Erik's payment locked the new
    // Sep 8-22 one: the first three shifts were stamped and snapshotted by that other call a
    // moment ago, so this UPDATE comes back with the last three only.
    const claimed = BRIAN_JUNE.slice(3).map((e) => e.id);
    state.client = fakeSupabase(scriptFor({ entries: BRIAN_JUNE, claimed }), calls);

    expect(await markPeriodPaid(PERIOD)).toEqual({ ok: true });

    // It still ASKS for all six (the claim filter is what decides), so read set and claimed set
    // genuinely differ here — which is the whole point.
    const claim = calls.find((c) => c.table === "time_entries" && c.verb === "update");
    expect(claim?.ids).toHaveLength(6);

    // 4.0 + 3.5 + 6.0 = 13.5 hours at $40.
    expect(runInsert()).toMatchObject({ hours: 13.5, gross: 540 });
    // The regression, named: the other three shifts are already inside run accde383, and `earned`
    // sums every base run forever.
    expect(runInsert()?.gross).not.toBe(1360);
  });

  it("re-pricing keeps each shift's own rate: a raise since then does not repay old overrides", async () => {
    // Brian is on $45 now; the Jun 16 supervisor shift still carries its $40 override. The claimed
    // subset must price per entry, exactly as the approval screen does.
    const claimed = [BRIAN_JUNE[3].id, BRIAN_JUNE[4].id];
    state.client = fakeSupabase(scriptFor({ entries: BRIAN_JUNE, claimed, rate: "45.00" }), calls);

    expect(await markPeriodPaid(PERIOD)).toEqual({ ok: true });
    // 4.0 h at the $40 override + 3.5 h at the $45 base = 160 + 157.50.
    expect(runInsert()).toMatchObject({ hours: 7.5, gross: 317.5, rate: 45 });
  });

  it("a claim that takes NOTHING says so and writes no run at all", async () => {
    state.client = fakeSupabase(scriptFor({ entries: BRIAN_JUNE, claimed: [] }), calls);

    const res = await markPeriodPaid(PERIOD);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Those hours were just marked paid by someone else.");
    // No empty $0 snapshot standing behind hours somebody else locked.
    expect(runInsert()).toBeUndefined();
  });

  it("a failed run insert releases exactly the ids it stamped, and says nothing was marked paid", async () => {
    const claimed = BRIAN_JUNE.slice(3).map((e) => e.id);
    const script = scriptFor({ entries: BRIAN_JUNE, claimed, runError: { message: "insert or update violates row-level security" } });
    script["time_entries.update"].push({ data: claimed.map((id) => ({ id })), error: null }); // the release
    state.client = fakeSupabase(script, calls);

    const res = await markPeriodPaid(PERIOD);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nothing was marked paid");
    const updates = calls.filter((c) => c.table === "time_entries" && c.verb === "update");
    expect(updates[1]?.payload).toEqual({ paid_at: null });
    expect(updates[1]?.ids).toEqual(claimed); // the three it took, never the three it only read
    expect(reported.calls).toEqual([]); // the release landed, so there is nothing stuck to log
  });
});

/**
 * THE OWNER IS PAID BY DRAW (0286). All three wage doors refuse him in plain words BEFORE anything
 * is read for locking, stamped or inserted. The scripts below carry only the reads a refusal needs:
 * any further statement is unscripted and would throw, so the tests also prove nothing else ran.
 */
describe("the wage doors refuse the owner (0286)", () => {
  const ERIK = "e0000000-0000-4000-8000-000000000001";
  const said = "Erik Taylor is the owner and is paid by owner's draw, not wages, so there is nothing to record here. What the owner takes out belongs in the accountant's books.";

  it("markPeriodPaid refuses before any period check or lock", async () => {
    state.client = fakeSupabase(
      {
        "profiles.select": [{ data: { role: "owner" }, error: null }],
        "profile_pay.select": [{ data: { hourly_rate: "0.00", full_name: "Erik Taylor", paid_by_draw: true }, error: null }],
      },
      calls,
    );
    expect(await markPeriodPaid({ profileId: ERIK, periodStart: "2026-09-07", periodEnd: "2026-09-21" })).toEqual({ ok: false, error: said });
    expect(calls.some((c) => c.verb !== "select")).toBe(false);
  });

  it("settleMileage refuses before any mileage is stamped", async () => {
    state.client = fakeSupabase(
      {
        "profiles.select": [{ data: { role: "owner" }, error: null }],
        "profile_pay.select": [{ data: { commute_baseline_miles: 0, full_name: "Erik Taylor", paid_by_draw: true }, error: null }],
      },
      calls,
    );
    expect(await settleMileage({ profileId: ERIK, periodStart: "2026-09-07", periodEnd: "2026-09-21", amount: 50 })).toEqual({ ok: false, error: said });
    expect(calls.some((c) => c.verb !== "select")).toBe(false);
  });

  it("recordPayment refuses before the payment row is inserted", async () => {
    state.client = fakeSupabase(
      {
        "profiles.select": [
          { data: { role: "owner" }, error: null }, // the caller (staff check)
          { data: { id: ERIK, full_name: "Erik Taylor", active: true, role: "owner" }, error: null }, // the payee
        ],
        "organizations.select": [{ data: { settings: { timezone: "America/Los_Angeles" } }, error: null }],
      },
      calls,
    );
    const res = await recordPayment({ profileId: ERIK, amount: 500, paidOn: "2026-09-20", method: "cash" });
    expect(res).toEqual({ ok: false, error: said });
    expect(calls.find((c) => c.table === "pay_payments")).toBeUndefined();
  });

  it("a crew member still goes through markPeriodPaid exactly as before", async () => {
    state.client = fakeSupabase(scriptFor({ entries: BRIAN_JUNE, claimed: BRIAN_JUNE.map((e) => e.id) }), calls);
    expect(await markPeriodPaid(PERIOD)).toEqual({ ok: true });
    expect(runInsert()).toMatchObject({ gross: 1360 });
  });
});
