import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * "WHICH JOB ARE YOU ON?" — the server half, pinned without a database (Erik, 2026-09-26: "yes").
 *
 *   - the clock answers with the punch ALREADY saved, and says `noJob` only when it couldn't tell
 *     the job (never when the job was known, never for a punch given a code); it reads no job list
 *     of its own, so the question never slows the clock down;
 *   - a clock-out still on no job is asked about once more (never the geofence's unattended close);
 *   - the sheet's list: the job he punched last, today's schedule, then the jobs in progress, with
 *     label columns only (no price reaches a tech);
 *   - picking is a checked write on his own, still job-less punch (open, or closed within a day).
 */
const state = vi.hoisted(() => ({ client: null as any }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined), notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { clockIn, clockOut } from "./actions";
import { putPunchOnJob, whichJobChoices } from "./which-job-actions";
import { CLOSED_PICK_WINDOW_MS, WHICH_JOB_COLUMNS, closedPickable } from "./which-job-choices";

type Q = {
  table: string;
  verb: "select" | "insert" | "update" | "delete";
  cols: string;
  /** The columns a write asked back (`.select(...)` after insert/update): the silent-write law. */
  returning?: string;
  payload?: any;
  filters: any[];
};
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)} ${JSON.stringify(q.filters)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(cols?: string) {
          if (q.verb === "select") q.cols = cols ?? "";
          else q.returning = cols ?? "";
          return chain;
        },
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

const has = (q: Q, ...f: any[]) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f));
const H = 3_600_000;
const PUNCH = "a0000000-0000-4000-8000-00000000000a";
const JOB = "d0000000-0000-4000-8000-00000000000d";
const ORG = { data: { settings: { timezone: "America/Los_Angeles" } } };

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.useRealTimers();
});

// ── the clock ────────────────────────────────────────────────────────────────────────────────

/** A tech's clock-in on a day nothing resolves: no crew day, no job of his today, two in progress. */
const unresolvedDay = (insertReply: Reply = { data: { id: PUNCH } }) => (q: Q): Reply => {
  if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
  if (q.table === "profiles") return { data: { role: "tech" } };
  if (q.table === "organizations") return ORG;
  if (q.table === "crew_day_assignments") return { data: null };
  if (q.table === "jobs" && q.filters.some((f) => f[0] === "contains")) return { data: [] };
  if (q.table === "jobs" && has(q, "eq", "status", "in_progress")) return { data: [{ id: "j1" }, { id: "j2" }] };
  if (q.table === "time_entries" && q.verb === "insert") return insertReply;
};

describe("the clock asks only when it can't tell the job, and never before the punch is saved", () => {
  it("a clock-in that resolves no job lands, then says noJob with the saved punch's id", async () => {
    state.client = fakeSupabase(unresolvedDay(), calls);
    const r = await clockIn({ job_id: null, job_code: null, gps: null });
    expect(r).toEqual({ ok: true, id: PUNCH, noJob: true });
    const insert = calls.find((c) => c.verb === "insert")!;
    expect(insert.payload).toMatchObject({ job_id: null, status: "open" });
    // The row comes back: the door knows WHICH punch to ask about.
    expect(insert.returning).toBe("id");
    // THE CLOCK NEVER WAITS ON THE QUESTION: no job list is read on the way to the answer (the sheet
    // loads its own, after the clock has answered).
    expect(calls.some((c) => c.cols === WHICH_JOB_COLUMNS)).toBe(false);
    expect(calls.some((c) => c.table === "job_schedule_segments")).toBe(false);
  });

  it("a clock-in whose job was known (or resolved) asks nothing: the clock stays two buttons", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
      if (q.table === "profiles") return { data: { role: "tech" } };
      if (q.table === "jobs" && q.cols === "id") return { data: { id: JOB } };
      // The promotion's read (lib/job-promote): the org, and whether the job is on hold (0366).
      if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1" } };
      if (q.table === "jobs" && q.verb === "update") return { data: [] };
      if (q.table === "time_entries" && q.verb === "insert") return { data: { id: PUNCH } };
    }, calls);
    // It does report WHICH job and WHO chose it (clock-told): a punch the person picked says nothing
    // new on screen, and a punch the app picked says one sentence. Neither is ever asked about.
    const known = await clockIn({ job_id: JOB, job_code: null, gps: null });
    expect(known).toEqual({ ok: true, id: PUNCH, jobPick: { chosenBy: "person", id: JOB } });
    expect(known.noJob).toBeUndefined();
  });

  it("a punch given a time code (Shop) with no job was named on purpose, and is not asked about", async () => {
    state.client = fakeSupabase(unresolvedDay(), calls);
    expect(await clockIn({ job_id: null, job_code: "SHOP", gps: null })).toEqual({ ok: true, id: PUNCH });
  });

  it("a refused clock-in asks nothing (there is no punch to ask about)", async () => {
    state.client = fakeSupabase(unresolvedDay({ error: { code: "23505", message: 'duplicate key value violates unique constraint "one_open_entry"' } }), calls);
    const r = await clockIn({ job_id: null, job_code: null, gps: null });
    expect(r.ok).toBe(false);
    expect(r.noJob).toBeUndefined();
  });

  const closing = (row: any) => (q: Q): Reply => {
    if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("clock_in"))
      return {
        data: { id: PUNCH, profile_id: "user-1", split_from: null, clock_in: new Date(Date.now() - 3 * H).toISOString(), lunch_minutes: 0, status: "open", notes: null, org_id: "org-1" },
      };
    if (q.table === "time_entries" && q.verb === "update") return { data: [row] };
  };

  const justNow = () => new Date().toISOString();

  it("a clock-out still on no job asks once more, with the closed shift's id", async () => {
    state.client = fakeSupabase(closing({ id: PUNCH, job_id: null, job_code: null, clock_out: justNow() }), calls);
    expect(await clockOut({ entry_id: PUNCH, lunch_minutes: 0, notes: "", gps: null })).toEqual({ ok: true, id: PUNCH, noJob: true });
    expect(calls.find((c) => c.verb === "update")!.returning).toBe("id, job_id, job_code, clock_out");
  });

  it("a clock-out on a job, or with a code, asks nothing", async () => {
    state.client = fakeSupabase(closing({ id: PUNCH, job_id: JOB, job_code: null, clock_out: justNow() }), calls);
    expect(await clockOut({ entry_id: PUNCH, lunch_minutes: 0, notes: "", gps: null })).toEqual({ ok: true });
    state.client = fakeSupabase(closing({ id: PUNCH, job_id: null, job_code: "SHOP", clock_out: justNow() }), calls);
    expect(await clockOut({ entry_id: PUNCH, lunch_minutes: 0, notes: "", gps: null })).toEqual({ ok: true });
  });

  it("a clock left running over a weekend, closed at a picked Friday stop, asks nothing: every pick would be refused", async () => {
    // Monday's close of Friday's shift: the stop he picked is 64 hours back, past the day a pick
    // can still land (putPunchOnJob answers "That shift closed a while ago"). The office has it.
    const friday = new Date(Date.now() - 64 * H).toISOString();
    state.client = fakeSupabase(closing({ id: PUNCH, job_id: null, job_code: null, clock_out: friday }), calls);
    expect(await clockOut({ entry_id: PUNCH, lunch_minutes: 0, notes: "", gps: null })).toEqual({ ok: true });
    // A row that came back without its stop is not read as "ask".
    state.client = fakeSupabase(closing({ id: PUNCH, job_id: null, job_code: null }), calls);
    expect(await clockOut({ entry_id: PUNCH, lunch_minutes: 0, notes: "", gps: null })).toEqual({ ok: true });
  });

  it("the ask and the pick share one window: asked exactly while a pick can still land", () => {
    const now = Date.parse("2026-09-28T16:00:00Z");
    expect(closedPickable(new Date(now - 2 * H).toISOString(), now)).toBe(true);
    expect(closedPickable(new Date(now - CLOSED_PICK_WINDOW_MS).toISOString(), now)).toBe(true);
    expect(closedPickable(new Date(now - CLOSED_PICK_WINDOW_MS - 60_000).toISOString(), now)).toBe(false);
    expect(closedPickable(null, now)).toBe(false);
    expect(closedPickable("not a time", now)).toBe(false);
  });

  it("the geofence's unattended close asks nobody", async () => {
    state.client = fakeSupabase(closing({ id: PUNCH, job_id: null, job_code: null, clock_out: justNow() }), calls);
    const r = await clockOut({ entry_id: PUNCH, lunch_minutes: null, notes: "", gps: null, auto: true, autoClosedReason: "left the site" });
    expect(r).toEqual({ ok: true });
  });
});

// ── the sheet's list ─────────────────────────────────────────────────────────────────────────

describe("the jobs the sheet offers", () => {
  // Saturday Sep 26, 2026, 8:00 AM Pacific.
  const NOW = Date.parse("2026-09-26T15:00:00Z");
  const job = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    job_number: id.toUpperCase(),
    name: `${id} site`,
    address: null,
    status: "in_progress",
    scheduled_start: null,
    scheduled_end: null,
    created_at: "2026-09-01T00:00:00Z",
    customers: { name: "Someone" },
    ...over,
  });
  const route = (q: Q): Reply => {
    if (q.table === "profiles") return { data: { role: "tech" } };
    if (q.table === "organizations") return ORG;
    if (q.table === "time_entries" && q.cols === "id, job_id, status") return { data: { id: PUNCH, job_id: null, status: "open" } };
    if (q.table === "time_entries" && q.cols === "job_id, clock_in") return { data: { job_id: "last", clock_in: "2026-09-25T15:00:00Z" } };
    if (q.table === "job_schedule_segments") {
      // The "has it any day rows?" read, by job id: seg and gap have day rows; window has none.
      const ids = q.filters.find((f) => f[0] === "in" && f[1] === "job_id")?.[2] as string[] | undefined;
      if (ids) return { data: ids.filter((id) => id === "seg" || id === "gap").map((job_id) => ({ job_id })) };
      return { data: [{ job_id: "seg" }] };
    }
    if (q.table === "jobs" && has(q, "eq", "status", "in_progress"))
      return {
        data: [
          job("older", { created_at: "2026-08-01T00:00:00Z" }),
          job("newer", { created_at: "2026-09-20T00:00:00Z" }),
          // Also on today's schedule by its own window: listed once, with today's.
          job("window", { scheduled_start: "2026-09-25T15:00:00Z", scheduled_end: "2026-09-27T01:00:00Z" }),
        ],
      };
    if (q.table === "jobs" && q.filters.some((f) => f[0] === "lt" && f[1] === "scheduled_start"))
      return {
        data: [
          job("window", { scheduled_start: "2026-09-25T15:00:00Z", scheduled_end: "2026-09-27T01:00:00Z" }),
          // Booked Tue 9/22 and Tue 9/29 (Add To Schedule): its window spans today, but today is a GAP
          // between its day rows, so it is not on today's schedule and not offered.
          job("gap", { status: "scheduled", scheduled_start: "2026-09-22T15:00:00Z", scheduled_end: "2026-09-29T23:00:00Z" }),
          // Scheduled, but for Monday: not today, not in progress, not offered.
          job("monday", { status: "scheduled", scheduled_start: "2026-09-28T15:00:00Z" }),
        ],
      };
    if (q.table === "jobs" && q.filters.some((f) => f[0] === "in" && f[1] === "id"))
      return { data: [job("last", { status: "scheduled" }), job("seg", { status: "scheduled", scheduled_start: "2026-09-26T16:00:00Z" })] };
  };

  it("puts the job he punched last first, today's schedule next, then the rest in progress, newest first", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    state.client = fakeSupabase(route, calls);
    const r = await whichJobChoices(PUNCH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.isStaff).toBe(false);
    expect(r.jobs.map((j) => j.id)).toEqual(["last", "window", "seg", "newer", "older"]);
    // A gap day is not a job day: only the jobs the window alone would put on today are asked
    // whether they have day rows, and "gap" (rows on 9/22 and 9/29, none today) is left out.
    const dayRows = calls.find((c) => c.table === "job_schedule_segments" && c.filters.some((f) => f[0] === "in"))!;
    expect(dayRows.cols).toBe("job_id");
    expect(dayRows.filters).toEqual([["in", "job_id", ["window", "gap"]]]);
    expect(r.jobs.map((j) => j.id)).not.toContain("gap");
    expect(r.jobs[0]).toEqual({ id: "last", label: "last site", why: "Where you worked last" });
    expect(r.jobs[1].why).toBe("On today's schedule");
    expect(r.jobs[3].why).toBeUndefined();
    // Only his own punch is asked about, and "last" looks three days back, never at this punch.
    const own = calls.find((c) => c.cols === "id, job_id, status")!;
    expect(has(own, "eq", "profile_id", "user-1")).toBe(true);
    const last = calls.find((c) => c.cols === "job_id, clock_in")!;
    expect(has(last, "neq", "id", PUNCH)).toBe(true);
    expect(has(last, "gte", "clock_in", new Date(NOW - 3 * 86_400_000).toISOString())).toBe(true);
  });

  it("reads every job in progress and every job whose own window covers today, with no cap to drop today's job", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    state.client = fakeSupabase(route, calls);
    await whichJobChoices(PUNCH);
    const going = calls.find((c) => c.table === "jobs" && has(c, "eq", "status", "in_progress"))!;
    const window = calls.find((c) => c.table === "jobs" && c.filters.some((f) => f[0] === "lt" && f[1] === "scheduled_start"))!;
    // A cap on either one once let an org with many jobs lose the oldest long-running job, or
    // today's own job, from the list (My Day's in-progress read carries no cap for the same reason).
    for (const q of [going, window]) expect(q.filters.some((f) => f[0] === "limit")).toBe(false);
    // Saturday Sep 26 in Pacific runs 07:00Z to 07:00Z: a job starting before it ends, and
    // starting that day or ending that day or later (onToday's own rule, so nothing older rides in).
    expect(has(window, "lt", "scheduled_start", "2026-09-27T07:00:00.000Z")).toBe(true);
    expect(has(window, "or", "scheduled_start.gte.2026-09-26T07:00:00.000Z,scheduled_end.gte.2026-09-26T07:00:00.000Z")).toBe(true);
  });

  it("techs see job names only: every job read selects label and schedule columns, never a price", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    state.client = fakeSupabase(route, calls);
    const r = await whichJobChoices(PUNCH);
    const jobReads = calls.filter((c) => c.table === "jobs");
    expect(jobReads.length).toBeGreaterThan(0);
    for (const q of jobReads) expect(q.cols).toBe(WHICH_JOB_COLUMNS);
    expect(WHICH_JOB_COLUMNS).not.toMatch(/price|rate|amount|total|cost|budget|contract|markup|paid|bill/i);
    expect(JSON.stringify(r)).not.toMatch(/\$|price|rate|amount|total/i);
  });

  it("a punch that already has a job, or isn't his, gets a sentence instead of a list", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles") return { data: { role: "tech" } };
      if (q.table === "organizations") return ORG;
      if (q.table === "time_entries") return { data: { id: PUNCH, job_id: JOB, status: "open" } };
    }, calls);
    expect(await whichJobChoices(PUNCH)).toEqual({ ok: false, isStaff: false, error: "This punch is already on a job." });
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles") return { data: { role: "tech" } };
      if (q.table === "organizations") return ORG;
      if (q.table === "time_entries") return { data: null };
    }, calls);
    expect((await whichJobChoices(PUNCH)).ok).toBe(false);
  });
});

// ── the pick ─────────────────────────────────────────────────────────────────────────────────

describe("picking puts the punch on the job, checked", () => {
  const pickRoute = (entry: any, jobRow: any, updateReply: Reply = { data: { id: PUNCH } }) => (q: Q): Reply => {
    if (q.table === "time_entries" && q.verb === "select") return { data: entry };
    if (q.table === "time_entries" && q.verb === "update") return updateReply;
    // The promotion's read (lib/job-promote): the org, and whether the job is on hold (0366).
    if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: jobRow?.status ?? null } };
    if (q.table === "jobs" && q.verb === "select") return { data: jobRow };
    if (q.table === "jobs" && q.verb === "update") return { data: [] };
    if (q.table === "organizations") return ORG;
  };
  const openPunch = { id: PUNCH, job_id: null, job_code: null, status: "open", clock_out: null };
  const whitney = { id: JOB, status: "scheduled", job_number: "J-028", name: "85 Whitney", address: null, customers: { name: "Nora" } };

  it("an open punch goes on the job whole: only if still his and still job-less, asked back, and a job not started yet is started", async () => {
    state.client = fakeSupabase(pickRoute(openPunch, whitney), calls);
    expect(await putPunchOnJob(PUNCH, JOB)).toEqual({ ok: true, label: "85 Whitney" });
    const upd = calls.find((c) => c.table === "time_entries" && c.verb === "update")!;
    expect(upd.payload).toEqual({ job_id: JOB });
    expect(has(upd, "eq", "profile_id", "user-1")).toBe(true);
    expect(has(upd, "eq", "status", "open")).toBe(true);
    expect(has(upd, "is", "job_id", null)).toBe(true);
    expect(upd.returning).toBe("id");
    // Naming the job is clocking into it: the same promotion clock-in makes.
    const promote = calls.find((c) => c.table === "jobs" && c.verb === "update")!;
    expect(promote.payload).toEqual({ status: "in_progress" });
  });

  it("a shift that just closed (the clock-out's question) goes on the job too", async () => {
    const closed = { ...openPunch, status: "closed", clock_out: new Date(Date.now() - 2 * H).toISOString() };
    state.client = fakeSupabase(pickRoute(closed, whitney), calls);
    expect(await putPunchOnJob(PUNCH, JOB)).toEqual({ ok: true, label: "85 Whitney" });
    expect(has(calls.find((c) => c.table === "time_entries" && c.verb === "update")!, "eq", "status", "closed")).toBe(true);
  });

  it("an old closed shift, or one filed under a code, is the office's: refused in words, nothing written", async () => {
    const old = { ...openPunch, status: "closed", clock_out: new Date(Date.now() - 30 * H).toISOString() };
    state.client = fakeSupabase(pickRoute(old, whitney), calls);
    const r = await putPunchOnJob(PUNCH, JOB);
    expect(r).toMatchObject({ ok: false, stale: true });
    expect(r.error).toMatch(/office puts it on its job from Timecards/);
    const shop = { ...openPunch, status: "closed", job_code: "SHOP", clock_out: new Date(Date.now() - H).toISOString() };
    state.client = fakeSupabase(pickRoute(shop, whitney), calls);
    expect((await putPunchOnJob(PUNCH, JOB)).error).toBe("That shift is filed under SHOP. The office moves it from Timecards.");
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a finished job, or one he can't see, is refused and nothing is written", async () => {
    state.client = fakeSupabase(pickRoute(openPunch, { ...whitney, status: "complete" }), calls);
    expect((await putPunchOnJob(PUNCH, JOB)).error).toMatch(/^That job is finished/);
    state.client = fakeSupabase(pickRoute(openPunch, null), calls);
    expect(await putPunchOnJob(PUNCH, JOB)).toEqual({ ok: false, error: "That job isn't available." });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a zero-row update (the punch closed or got a job a moment ago) is never reported as done", async () => {
    state.client = fakeSupabase(pickRoute(openPunch, whitney, { data: null }), calls);
    const r = await putPunchOnJob(PUNCH, JOB);
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.error).toMatch(/^Nothing changed/);
    expect(calls.some((c) => c.table === "jobs" && c.verb === "update")).toBe(false);
  });
});
