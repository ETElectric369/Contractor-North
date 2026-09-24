import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * STOP THE CLOCK (2026-09-24), pinned without a database.
 *
 * Erik: "Brian did it the other day too and I had no way to stop it to set the time for the
 * invoice". What lives here is what the doors do: who may stop a clock, the bounds a stop time must
 * meet, the refusal when somebody else stopped it first (a zero-row write is never a success), the
 * crumb on the card, and who gets told. The 0291 guard under it is proven in
 * close-in-time.integration.test.ts. The fake refuses any statement it was not told about.
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

import { clockOut, stopShift, updateOpenEntry, updateTimeEntry } from "./actions";

type Q = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; cols: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)}`);
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

const ENTRY = "0c7fae89-0000-4000-8000-000000000001";
const HERRINGBONE = "a0000000-0000-4000-8000-00000000011b";
const H = 3_600_000;
// A day nobody worked: 2001-01-01, 1:37 PM Pacific.
const CLOCK_IN = "2001-01-01T21:37:00.000Z";

type Row = { profile_id?: string; status?: string; clock_out?: string | null; notes?: string | null };
const openRow = (r: Row = {}) => ({
  id: ENTRY,
  profile_id: r.profile_id ?? "brian-1",
  org_id: "org-1",
  clock_in: CLOCK_IN,
  clock_out: r.clock_out ?? null,
  status: r.status ?? "open",
  job_id: HERRINGBONE,
  notes: r.notes ?? null,
  paid_at: null,
  profiles: { full_name: "Brian Taylor" },
  job: { job_number: "J-011", name: "Herringbone" },
});

/** The routes stopShift needs; `updated` is what the guarded UPDATE matched. */
function stopRoutes(row: any, updated: any[] = [{ id: ENTRY }]) {
  return (q: Q): Reply => {
    if (q.table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } } };
    if (q.table === "profiles") return { data: { full_name: "Erik Taylor" } };
    if (q.table === "jobs") return { data: { id: HERRINGBONE, job_number: "J-011", name: "Herringbone" } };
    if (q.table === "time_entries" && q.verb === "select" && /status/.test(q.cols)) return { data: row };
    if (q.table === "time_entries" && q.verb === "select") return { data: [] }; // the overlap read: a clear day
    if (q.table === "time_entries" && q.verb === "update") return { data: updated };
    return undefined;
  };
}

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
  spies.notify = [];
  spies.push = [];
  state.staff = true;
});

describe("stopShift", () => {
  const stop = (clock_out: string, extra: Partial<Parameters<typeof stopShift>[0]> = {}) =>
    stopShift({ entry_id: ENTRY, clock_out, lunch_minutes: 0, ...extra });

  it("refuses a caller who is not office staff, before reading anything", async () => {
    state.staff = false;
    state.client = fakeSupabase(() => undefined, calls);
    expect(await stop("2001-01-02T01:00:00.000Z")).toMatchObject({ ok: false, error: "This action is staff-only." });
    expect(calls).toEqual([]);
  });

  it("refuses a clock that was already stopped, naming when", async () => {
    state.client = fakeSupabase(stopRoutes(openRow({ status: "closed", clock_out: "2001-01-02T01:00:00.000Z" })), calls);
    const r = await stop("2001-01-02T01:00:00.000Z");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("That clock was already stopped at Mon Jan 1, 5:00 PM. Reload to see its times.");
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("refuses a stop before the start, in the future, or more than 18 hours in", async () => {
    state.client = fakeSupabase(stopRoutes(openRow()), calls);
    expect((await stop("2001-01-01T20:00:00.000Z")).error).toBe("Pick a stop time after 1:37 PM.");
    expect((await stop(new Date(Date.now() + 2 * H).toISOString())).error).toBe("That time hasn't happened yet.");
    expect((await stop("2001-01-02T16:37:00.000Z")).error).toBe(
      "That's more than 18 hours after the clock-in. Pick when the shift really stopped.",
    );
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a zero-row update is a refusal, not a stopped clock, and tells nobody", async () => {
    state.client = fakeSupabase(stopRoutes(openRow(), []), calls);
    const r = await stop("2001-01-02T01:00:00.000Z");
    expect(r).toMatchObject({ ok: false, error: "That clock was stopped a moment ago somewhere else. Reload to see it." });
    expect(r.sentence).toBeUndefined();
    expect(spies.notify).toEqual([]);
    expect(spies.push).toEqual([]);
  });

  it("closes only an open row, writes who stopped it, and tells the crew member", async () => {
    state.client = fakeSupabase(stopRoutes(openRow({ notes: "pulled wire" })), calls);
    const r = await stop("2001-01-02T01:00:00.000Z", { clock_in: "2001-01-01T20:00:00.000Z" });
    expect(r.ok).toBe(true);
    expect(r.hours).toBe(5);
    expect(r.sentence).toBe("Stopped Brian's clock: Mon Jan 1, 12:00 PM to 5:00 PM (5.00 h). Brian has been told.");

    const upd = calls.find((c) => c.table === "time_entries" && c.verb === "update")!;
    expect(upd.filters).toContainEqual(["eq", "status", "open"]);
    expect(upd.payload).toMatchObject({
      clock_in: "2001-01-01T20:00:00.000Z",
      clock_out: "2001-01-02T01:00:00.000Z",
      lunch_minutes: 0,
      status: "closed",
      auto_closed_reason: null,
    });
    expect(upd.payload.notes).toMatch(/^pulled wire\n\[clock stopped by Erik Taylor on .+; it had been running since Jan 1, 1:37 PM; start moved from 1:37 PM to 12:00 PM\]$/);
    // Fields nobody sent are not touched.
    expect(upd.payload).not.toHaveProperty("job_id");
    expect(upd.payload).not.toHaveProperty("miles");
    expect(upd.payload).not.toHaveProperty("rate_override");

    expect(spies.notify).toHaveLength(1);
    const [org, to, n] = spies.notify[0];
    expect(org).toBe("org-1");
    expect(to).toEqual(["brian-1"]);
    expect(n).toMatchObject({ type: "clock_stopped", title: "The Office Stopped Your Clock", url: "/timeclock" });
    expect(n.body).toBe(
      "Erik stopped your clock on Herringbone. Your shift now reads Mon Jan 1, 12:00 PM to 5:00 PM, 5.00 h, no lunch. If that is wrong, tell Erik.",
    );
    expect(spies.push).toHaveLength(1);
    expect(spies.push[0][0]).toEqual(["brian-1"]);
    expect(spies.push[0][1]).toBe("clock_out");
  });

  it("stopping your own clock tells nobody, and the sentence leaves the telling out", async () => {
    state.client = fakeSupabase(stopRoutes(openRow({ profile_id: "user-1" })), calls);
    const r = await stop("2001-01-02T01:00:00.000Z", { lunch_minutes: 30 });
    expect(r.sentence).toBe("Stopped your clock: Mon Jan 1, 1:37 PM to 5:00 PM (2.88 h).");
    expect(spies.notify).toEqual([]);
    expect(spies.push).toEqual([]);
  });

  it("never uses an em-dash in what it says", async () => {
    state.client = fakeSupabase(stopRoutes(openRow()), calls);
    const r = await stop("2001-01-02T01:00:00.000Z");
    expect(r.sentence).not.toMatch(/—/);
    expect(spies.notify[0][2].body).not.toMatch(/—/);
  });
});

describe("updateTimeEntry on a running clock", () => {
  const edit = (extra: Partial<Parameters<typeof updateTimeEntry>[0]> = {}) =>
    updateTimeEntry({
      id: ENTRY,
      clock_in: CLOCK_IN,
      clock_out: "2001-01-02T01:00:00.000Z",
      lunch_minutes: 0,
      job_code: null,
      notes: "",
      ...extra,
    });

  it("goes through stopShift: same bounds, same crumb, same message to the crew member", async () => {
    state.client = fakeSupabase(stopRoutes(openRow()), calls);
    const r = await edit();
    expect(r.ok).toBe(true);
    expect(r.sentence).toMatch(/^Stopped Brian's clock/);
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.filters).toContainEqual(["eq", "status", "open"]);
    expect(upd.payload.notes).toMatch(/^\[clock stopped by Erik Taylor/);
    expect(spies.notify).toHaveLength(1);

    const future = await edit({ clock_out: new Date(Date.now() + 3 * H).toISOString() });
    expect(future.error).toBe("That time hasn't happened yet.");
  });

  it("refuses to hand a running shift to somebody else", async () => {
    state.client = fakeSupabase(stopRoutes(openRow()), calls);
    expect(await edit({ profile_id: "jimmy-1" })).toMatchObject({
      ok: false,
      error: "Stop the clock first, then move the shift to someone else.",
    });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });
});

describe("clockOut past ten hours", () => {
  const routes = (clockIn: string) => (q: Q): Reply => {
    if (q.table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } } };
    if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
    if (q.table === "time_entries" && q.verb === "select")
      return { data: { clock_in: clockIn, lunch_minutes: 0, status: "open", notes: "trimmed out", org_id: "org-1" } };
    if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: ENTRY }] };
    return undefined;
  };

  it("a plain tap on an 11-hour clock asks when he stopped and writes nothing", async () => {
    const clockIn = new Date(Date.now() - 11 * H).toISOString();
    state.client = fakeSupabase(routes(clockIn), calls);
    const r = await clockOut({ entry_id: ENTRY, lunch_minutes: 0, notes: "", gps: null });
    expect(r.ok).toBe(false);
    expect(r.needsTime).toBe(true);
    expect(r.error).toMatch(/^You've been on the clock since .+, more than 10 hours\. Pick when you stopped on Timeclock\.$/);
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a picked stop time closes it, says so on the card, and puts it on the office's bell", async () => {
    const clockIn = new Date(Date.now() - 11 * H).toISOString();
    const at = new Date(Date.now() - 7 * H).toISOString();
    state.client = fakeSupabase(routes(clockIn), calls);
    const r = await clockOut({ entry_id: ENTRY, lunch_minutes: 0, notes: "", gps: null, at, picked: true });
    expect(r).toMatchObject({ ok: true });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload.clock_out).toBe(at);
    expect(upd.payload.notes).toMatch(/^trimmed out\n\[stop time picked by Brian Taylor on .+, after the shift\]$/);
    expect(spies.notify).toHaveLength(1);
    const [, to, n] = spies.notify[0];
    expect(to).toEqual(["office-1"]); // the caller is never told about himself
    expect(n).toMatchObject({ type: "clock_stopped_late", title: "Brian Set His Stop Time Late", url: `/timecards?entry=${ENTRY}` });
    expect(n.body).toMatch(/and picked .+ as his stop, 4\.00 h\.$/);
    expect(spies.push).toEqual([]); // bell only
  });

  it("a picked stop more than 18 hours in is refused", async () => {
    const clockIn = new Date(Date.now() - 30 * H).toISOString();
    state.client = fakeSupabase(routes(clockIn), calls);
    const r = await clockOut({ entry_id: ENTRY, lunch_minutes: 0, notes: "", gps: null, at: new Date(Date.now() - H).toISOString(), picked: true });
    expect(r.error).toBe(
      "That's more than 18 hours after you clocked in. Pick when you really stopped. If the shift truly ran that long, the office has to enter it.",
    );
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("an ordinary 8-hour clock-out is one tap, as before", async () => {
    state.client = fakeSupabase(routes(new Date(Date.now() - 8 * H).toISOString()), calls);
    expect(await clockOut({ entry_id: ENTRY, lunch_minutes: 0, notes: "", gps: null })).toEqual({ ok: true });
    expect(spies.notify).toEqual([]);
  });
});

describe("updateOpenEntry", () => {
  it("fixes a running shift's job and notes without ever writing its clock or status", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "jobs") return { data: { id: HERRINGBONE } };
      if (q.table === "time_entries" && q.verb === "select") return { data: { job_id: null, status: "open" } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: ENTRY }] };
    }, calls);
    expect(await updateOpenEntry({ id: ENTRY, job_id: HERRINGBONE, notes: "panel swap" })).toEqual({ ok: true });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload).toEqual({ job_id: HERRINGBONE, notes: "panel swap" });
    expect(upd.filters).toContainEqual(["eq", "status", "open"]);
  });

  it("says so when the clock stopped in the meantime", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: { job_id: null, status: "open" } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [] };
    }, calls);
    expect(await updateOpenEntry({ id: ENTRY, notes: "x" })).toEqual({ ok: false, error: "That clock isn't running any more. Reload." });
  });
});
