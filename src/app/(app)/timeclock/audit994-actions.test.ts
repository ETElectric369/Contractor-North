import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AUDIT v994, THE TIME CLOCK WAVE: what the doors do, pinned without a database.
 *
 *   SW1  a clock-out or a switch past twelve hours of the SHIFT (counted from the first piece after a
 *        Switch Job, Erik's call) must state a stop time;
 *   SW2  a Switch Job's piece gets the post-switch anchor window, and a zero-row anchor is no anchor;
 *   SW3  the "finish your timecard" lunch lands where it fits, on the part before when asked;
 *   SW4  the office's Clock Out on a shift that was switched says so, and hands back the running entry;
 *   SW6  a paid part before the switch never takes a lunch;
 *   SW7  a split piece is never handed to another person;
 *   SI6  "8 hours today" before the day is over ends at now, and says so.
 *
 * The fake refuses any statement it was not told about, by name.
 */
const state = vi.hoisted(() => ({ client: null as any, staff: true }));
const spies = vi.hoisted(() => ({ notify: [] as any[], push: [] as any[] }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () =>
    state.staff ? { supabase: state.client, userId: "user-1", orgId: "org-1" } : { error: "This action is staff-only." },
  ),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async (...a: any[]) => void spies.notify.push(a)) }));
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => void spies.push.push(a)),
  orgStaffIds: vi.fn(async () => ["office-1", "user-1"]),
}));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { adoptGeofenceAnchor, clockOut, completeAutoClockOut, createManualEntry, stopShift, switchJob, updateTimeEntry } from "./actions";
import { AUTO_CONFIRMED_CRUMB } from "./close-math";

type Q = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; cols: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)} ${JSON.stringify(q.filters)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc(fn: string, args: any) {
      const q: Q = { table: `rpc:${fn}`, verb: "rpc", cols: "", payload: args, filters: [] };
      calls.push(q);
      return Promise.resolve(answer(q));
    },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        single() { return Promise.resolve(answer(q)); },
        maybeSingle() { return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) {
          try { resolve(answer(q)); } catch (e) { reject?.(e); }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "overlaps", "order", "limit", "contains"]) {
        chain[m] = (...args: any[]) => { q.filters.push([m, ...args]); return chain; };
      }
      return chain;
    },
  };
}

const HEAD = "a0000000-0000-4000-8000-00000000000a";
const LIVE = "b0000000-0000-4000-8000-00000000000b";
const NEXT = "c0000000-0000-4000-8000-00000000000c";
const JOB = "d0000000-0000-4000-8000-00000000000d";
const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
const ORG_TZ = { data: { settings: { timezone: "America/Los_Angeles" } } };

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
  spies.notify = [];
  spies.push = [];
  state.staff = true;
});

const isChainRead = (q: Q) => q.table === "time_entries" && q.verb === "select" && q.filters.some((f) => f[0] === "or");

describe("SW1: twelve hours count from the start of the day, across a Switch Job", () => {
  // In 13 hours ago on job A, switched 1 hour ago, tapping a plain Clock Out now.
  const switchedAt = ago(1);
  const head = { id: HEAD, profile_id: "user-1", clock_in: ago(13), clock_out: switchedAt, status: "closed", split_from: null };
  const live = { id: LIVE, profile_id: "user-1", clock_in: switchedAt, status: "open", split_from: HEAD, lunch_minutes: 0, notes: null, org_id: "org-1" };

  it("a plain Clock Out on the running piece is refused and asks for the stop time, naming the day's start", async () => {
    state.client = fakeSupabase((q) => {
      if (isChainRead(q)) return { data: [head, live] };
      if (q.table === "time_entries" && q.verb === "select") return { data: live };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    const r = await clockOut({ entry_id: LIVE, lunch_minutes: 0, notes: "", gps: null });
    expect(r.ok).toBe(false);
    expect(r.needsTime).toBe(true);
    expect(r.error).toMatch(/^You've been on the clock since .+, more than 12 hours\. Pick when you stopped on Timeclock\.$/);
    expect(calls.some((c) => c.verb === "update")).toBe(false);
    // The chain was read by the family's first entry.
    expect(calls.find(isChainRead)!.filters).toContainEqual(["or", `id.in.(${HEAD}),split_from.in.(${HEAD})`]);
  });

  it("the same clock with a STATED stop time closes the running piece, and the card says it was picked late", async () => {
    state.client = fakeSupabase((q) => {
      if (isChainRead(q)) return { data: [head, live] };
      if (q.table === "time_entries" && q.verb === "select") return { data: live };
      if (q.table === "organizations") return ORG_TZ;
      if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: LIVE }] };
    }, calls);
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await clockOut({ entry_id: LIVE, lunch_minutes: 0, notes: "", gps: null, at, picked: true });
    expect(r.ok).toBe(true);
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload.notes).toMatch(/^\[stop time picked by Brian Taylor on .+, after the shift\]$/);
  });

  it("a piece that never switched keeps the old rule, and no chain is read", async () => {
    const solo = { ...live, id: NEXT, split_from: null, clock_in: ago(3) };
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: solo };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: NEXT }] };
    }, calls);
    expect(await clockOut({ entry_id: NEXT, lunch_minutes: 0, notes: "", gps: null })).toEqual({ ok: true });
    expect(calls.some(isChainRead)).toBe(false);
  });

  it("a second Switch Job late in a forgotten day is refused the same way", async () => {
    const running = { ...live, org_id: "org-1", job_id: JOB, job_code: null, rate_override: null, profiles: { full_name: "Brian Taylor" } };
    state.client = fakeSupabase((q) => {
      if (isChainRead(q)) return { data: [head, live] };
      if (q.table === "time_entries" && q.verb === "select") return { data: running };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    const r = await switchJob({ entry_id: LIVE, job_id: JOB });
    expect(r).toMatchObject({ ok: false, needsTime: true });
    expect(r.error).toMatch(/more than 12 hours\. Pick when you stopped on Timeclock, then clock in on this job\.$/);
    expect(calls.some((c) => c.verb === "rpc")).toBe(false);
  });
});

describe("SW2: a Switch Job's piece re-arms the geofence in the post-switch window", () => {
  const fix = { lat: 39.8, lng: -120.1, accuracy: 20 };

  it("30 minutes after a cut switch, a live piece with no anchor adopts one (the 15-minute window is for a clock-in)", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select")
        return { data: { id: LIVE, clock_in: ago(0.5), gps_in: null, notes: null, split_how: "live" } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: LIVE }] };
    }, calls);
    expect(await adoptGeofenceAnchor(LIVE, fix)).toEqual({ ok: true });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.filters).toContainEqual(["is", "gps_in", null]);
  });

  it("an ordinary clock-in 30 minutes ago does not", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: { id: LIVE, clock_in: ago(0.5), gps_in: null, notes: null, split_how: null } };
    }, calls);
    expect((await adoptGeofenceAnchor(LIVE, fix)).ok).toBe(false);
  });

  it("a zero-row anchor write is no anchor (the silent-write law)", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select")
        return { data: { id: LIVE, clock_in: ago(0.1), gps_in: null, notes: null, split_how: "live" } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [] };
    }, calls);
    expect(await adoptGeofenceAnchor(LIVE, fix)).toEqual({ ok: false, error: "That shift changed before the location saved." });
  });
});

describe("SW3 + SW6: the finish-your-timecard lunch after a Switch Job", () => {
  // 7:00-14:30 on the part before (7.5 h), the geofence closed the last part 20 minutes later.
  const priorOut = ago(2);
  const autoRow = { id: LIVE, clock_in: priorOut, clock_out: new Date(Date.parse(priorOut) + 20 * 60_000).toISOString(), job_id: JOB, lunch_minutes: 0, notes: null };
  const prior = { id: HEAD, clock_in: new Date(Date.parse(priorOut) - 7.5 * H).toISOString(), clock_out: priorOut, lunch_minutes: 0, paid_at: null };
  const routes = (priorRow: any, priorUpdated: any[] = [{ id: HEAD }]) => (q: Q): Reply => {
    if (q.table === "time_entries" && q.verb === "select" && q.cols.includes("notes")) return { data: autoRow };
    if (q.table === "time_entries" && q.verb === "select" && q.cols.includes("paid_at")) return { data: priorRow };
    if (q.table === "invoice_items") return { data: [] };
    if (q.table === "time_entries" && q.verb === "update" && q.filters.some((f) => f[1] === "id" && f[2] === HEAD)) return { data: priorUpdated };
    if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: LIVE }] };
    return undefined;
  };

  it("a 30-minute lunch asked for the part before lands there (raise-only, never paid) and this part keeps none", async () => {
    state.client = fakeSupabase(routes(prior), calls);
    const r = await completeAutoClockOut({ entry_id: LIVE, lunch_minutes: 30, lunch_on_prior: true });
    expect(r).toEqual({ ok: true });
    const [priorUpd, hereUpd] = calls.filter((c) => c.verb === "update");
    expect(priorUpd.payload).toEqual({ lunch_minutes: 30 });
    expect(priorUpd.filters).toContainEqual(["is", "paid_at", null]);
    expect(priorUpd.filters).toContainEqual(["eq", "profile_id", "user-1"]);
    expect(hereUpd.payload).toEqual({ lunch_minutes: 0, notes: AUTO_CONFIRMED_CRUMB });
  });

  it("the whole day's lunch ticked on the 20-minute last part goes on the part before, and says so", async () => {
    state.client = fakeSupabase(routes(prior), calls);
    const r = await completeAutoClockOut({ entry_id: LIVE, lunch_minutes: 30 });
    expect(r).toEqual({ ok: true, warning: "The 30-minute lunch is longer than this part of your shift, so it went on the part before the switch." });
    expect(calls.filter((c) => c.verb === "update")[0].payload).toEqual({ lunch_minutes: 30 });
  });

  it("a paid part before the switch: refused in words, nothing written, the prompt stays", async () => {
    state.client = fakeSupabase(routes({ ...prior, paid_at: "2001-01-05T00:00:00Z" }), calls);
    const r = await completeAutoClockOut({ entry_id: LIVE, lunch_minutes: 30 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/The part before the switch is already paid, so it can't go there\..*Nothing was changed\.$/);
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a part before that took nothing (paid a moment ago) stops everything, before this part is answered", async () => {
    state.client = fakeSupabase(routes(prior, []), calls);
    const r = await completeAutoClockOut({ entry_id: LIVE, lunch_minutes: 30, lunch_on_prior: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/didn't take the lunch/);
    expect(calls.filter((c) => c.verb === "update")).toHaveLength(1);
  });

  it("the clock-out's own lunch-before-the-switch never writes onto a paid part (SW6)", async () => {
    const running = { id: LIVE, profile_id: "user-1", clock_in: priorOut, lunch_minutes: 0, status: "open", notes: null, org_id: "org-1", split_from: HEAD };
    state.client = fakeSupabase((q) => {
      if (isChainRead(q)) return { data: [{ ...prior, profile_id: "user-1", status: "closed", split_from: null }, running] };
      if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("clock_in, lunch")) return { data: running };
      if (q.table === "time_entries" && q.verb === "select" && q.cols.includes("paid_at")) return { data: { ...prior, paid_at: "2001-01-05T00:00:00Z" } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: LIVE }] };
    }, calls);
    const r = await clockOut({ entry_id: LIVE, lunch_minutes: 0, lunch_on_entry_id: HEAD, lunch_on_minutes: 30, notes: "", gps: null });
    expect(r).toEqual({ ok: true, warning: "The part before the switch is already paid, so the lunch went on this part of your shift." });
    const upds = calls.filter((c) => c.verb === "update");
    expect(upds).toHaveLength(1);
    expect(upds[0].payload).toMatchObject({ lunch_minutes: 30, status: "closed" });
  });
});

describe("SW4: the office's Clock Out on a shift that was switched meanwhile", () => {
  const closed = {
    id: LIVE,
    profile_id: "brian-1",
    org_id: "org-1",
    clock_in: ago(3),
    clock_out: ago(0.1),
    status: "closed",
    job_id: JOB,
    notes: null,
    paid_at: null,
    profiles: { full_name: "Brian Taylor" },
    job: { job_number: "J-011", name: "Herringbone" },
  };
  const routes = (row: any, updated: any[] = [{ id: LIVE }]) => (q: Q): Reply => {
    if (q.table === "organizations") return ORG_TZ;
    if (q.table === "profiles") return { data: { full_name: "Erik Taylor" } };
    if (q.table === "time_entries" && q.verb === "select" && q.cols.includes("paid_at")) return { data: row };
    if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("id, clock_in, job_code"))
      return { data: { id: NEXT, clock_in: ago(0.1), job_code: null, job: { job_number: "J-012", name: "Rhodesia" } } };
    if (q.table === "time_entries" && q.verb === "select") return { data: [] };
    if (q.table === "time_entries" && q.verb === "update") return { data: updated };
    return undefined;
  };

  it("says he switched and is still on the clock, and hands back the running entry, never applied", async () => {
    state.client = fakeSupabase(routes(closed), calls);
    const r = await stopShift({ entry_id: LIVE, clock_out: ago(0.5), lunch_minutes: 0 });
    expect(r.ok).toBe(false);
    expect(r.still_open_entry_id).toBe(NEXT);
    expect(r.error).toMatch(/^Brian switched to Rhodesia at .+ and is still on the clock\. Nothing was changed\. Open that shift to Clock Out Brian\.$/);
    expect(calls.some((c) => c.verb === "update")).toBe(false);
    const look = calls.find((c) => c.cols.startsWith("id, clock_in, job_code"))!;
    expect(look.filters).toEqual(expect.arrayContaining([["eq", "profile_id", "brian-1"], ["eq", "org_id", "org-1"], ["eq", "status", "open"]]));
  });

  it("the race (the switch landed between the read and the write) says the same", async () => {
    state.client = fakeSupabase(routes({ ...closed, status: "open", clock_out: null }, []), calls);
    const r = await stopShift({ entry_id: LIVE, clock_out: ago(0.5), lunch_minutes: 0 });
    expect(r).toMatchObject({ ok: false, still_open_entry_id: NEXT });
  });
});

describe("SW7: a split piece is never handed to another person", () => {
  const stored = {
    job_id: JOB,
    clock_in: "2001-01-01T16:00:00Z",
    clock_out: "2001-01-01T19:00:00Z",
    lunch_minutes: 0,
    rate_override: null,
    profile_id: "brian-1",
    miles: 0,
    paid_at: null,
    mileage_paid_at: null,
    auto_closed_reason: null,
    status: "closed",
    profiles: { full_name: "Brian Taylor" },
  };
  const input = { id: LIVE, clock_in: "2001-01-01T16:00:00Z", clock_out: "2001-01-01T19:00:00Z", lunch_minutes: 0, job_code: null, notes: "", profile_id: "jimmy-1" };

  it("a piece (it points at a first entry) is refused before anything is written", async () => {
    state.client = fakeSupabase((q) => (q.table === "time_entries" && q.verb === "select" ? { data: { ...stored, split_from: HEAD } } : undefined), calls);
    const r = await updateTimeEntry(input as any);
    expect(r).toEqual({ ok: false, error: "This shift was split into parts. Join the split back first, then move the shift to someone else." });
  });

  it("the first entry (others point at it) is refused too", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select" && q.cols === "id") return { data: [{ id: NEXT }] };
      if (q.table === "time_entries" && q.verb === "select") return { data: { ...stored, split_from: null } };
    }, calls);
    const r = await updateTimeEntry(input as any);
    expect(r.error).toBe("This shift was split into parts. Join the split back first, then move the shift to someone else.");
    expect(calls.find((c) => c.cols === "id")!.filters).toContainEqual(["eq", "split_from", LIVE]);
  });
});

describe("SI6: 'Brian worked 8 hours today' logged before the day is over", () => {
  it("at 3 PM the span ends at now, not at a 4 PM nobody has reached, and the answer says so", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-24T22:00:00Z"), toFake: ["Date"] }); // 3:00 PM Pacific
    try {
      state.client = fakeSupabase((q) => {
        if (q.table === "organizations") return ORG_TZ;
        if (q.table === "time_entries" && q.verb === "select") return { data: [] };
        if (q.table === "time_entries" && q.verb === "insert") return { data: [{ id: NEXT }] };
      }, calls);
      const r = await createManualEntry({ profile_id: "brian-1", work_date: "2026-09-24", hours: 8, job_id: null, job_code: null, notes: "" });
      expect(r).toEqual({
        ok: true,
        warning: "Today isn't over yet, so the hours are logged ending now: 7:00 AM to 3:00 PM. Change the times on Timecards if that's not right.",
      });
      const ins = calls.find((c) => c.verb === "insert")!;
      expect(ins.payload).toMatchObject({ clock_in: "2026-09-24T14:00:00.000Z", clock_out: "2026-09-24T22:00:00.000Z" });
      expect(ins.payload.notes).toBe("[duration-entered: 8h]");
    } finally {
      vi.useRealTimers();
    }
  });
});
