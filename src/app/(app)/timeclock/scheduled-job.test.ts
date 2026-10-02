import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * WHERE THE SCHEDULE PUTS ONE PERSON ON ONE DAY (scheduledJobFor, Wave 2), and the clock that
 * resolves through it (resolveTechJobToday, reached here through clockIn), pinned without a
 * database. The precedence law, tier by tier:
 *   - that day's crew day row wins; an OFF row fails closed (no tier below may guess);
 *   - else a rostered job whose segments, or whose own window, cover the day, read in COMPANY days;
 *   - tier 2 (the org's only in-progress job) is the clock's alone.
 * The one resolution that moved: an evening start no longer covers the next morning.
 * scheduled-job.integration.test.ts runs the same reads on the TEST database under the office's RLS.
 */
const state = vi.hoisted(() => ({ client: null as any }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined), notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { NOTHING_SCHEDULED, dayBoundsInTz, scheduledJobFor, windowCoversDay } from "./scheduled-job";
import { clockIn } from "./actions";

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

const TZ = "America/Los_Angeles";
const has = (q: Q, ...f: any[]) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f));
const isDayRow = (q: Q) => q.table === "crew_day_assignments";
const isDayJobCheck = (q: Q) => q.table === "jobs" && q.cols === "id" && q.filters.some((f) => f[0] === "eq" && f[1] === "id");
const isRoster = (q: Q) => q.table === "jobs" && q.cols === "id, scheduled_start, scheduled_end";
const isSegments = (q: Q) => q.table === "job_schedule_segments";
const isInProgress = (q: Q) => q.table === "jobs" && q.cols === "id" && has(q, "eq", "status", "in_progress");

/** A schedule: the day row, the jobs the person is rostered on, the segments, and the jobs in flight. */
type Plan = {
  day?: { job_id: string | null; kind: string } | null;
  active?: string[];
  roster?: { id: string; scheduled_start: string | null; scheduled_end: string | null }[];
  segments?: { job_id: string; start_date: string; end_date: string }[];
  inProgress?: string[];
};
function planRoutes(p: Plan) {
  return (q: Q): Reply => {
    if (isDayRow(q)) return { data: p.day ?? null };
    if (isInProgress(q)) return { data: (p.inProgress ?? []).map((id) => ({ id })) };
    if (isDayJobCheck(q)) {
      const id = q.filters.find((f) => f[0] === "eq" && f[1] === "id")![2];
      return { data: (p.active ?? []).includes(id) ? { id } : null };
    }
    if (isRoster(q)) return { data: p.roster ?? [] };
    if (isSegments(q)) {
      // Every row of the jobs asked about (the reader decides the day itself), as PostgREST would.
      const ids: string[] = q.filters.find((f) => f[0] === "in" && f[1] === "job_id")?.[2] ?? [];
      return { data: (p.segments ?? []).filter((s) => ids.includes(s.job_id)) };
    }
    return undefined;
  };
}

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
});

describe("scheduledJobFor: the day row wins", () => {
  it("a day row naming a job still in flight is the answer, and no tier below is read", async () => {
    const sb = fakeSupabase(
      planRoutes({
        day: { job_id: "larkspur", kind: "job" },
        active: ["larkspur", "pine"],
        roster: [{ id: "pine", scheduled_start: "2026-09-22T15:00:00Z", scheduled_end: null }],
      }),
      calls,
    );
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual({ off: false, jobId: "larkspur" });
    expect(calls.some(isRoster)).toBe(false);
    const day = calls.find(isDayRow)!;
    expect(day.filters).toEqual(expect.arrayContaining([["eq", "profile_id", "brian-1"], ["eq", "work_date", "2026-09-22"]]));
  });

  it("OFF fails closed: marked off that day means off, whatever the roster says, and no job is read", async () => {
    const sb = fakeSupabase(
      planRoutes({
        day: { job_id: null, kind: "off" },
        roster: [{ id: "pine", scheduled_start: "2026-09-22T15:00:00Z", scheduled_end: null }],
      }),
      calls,
    );
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual({ off: true, jobId: null });
    expect(calls.some((q) => q.table === "jobs")).toBe(false);
  });

  it("a day row naming a finished job falls through to the roster, never resurrecting it", async () => {
    const sb = fakeSupabase(
      planRoutes({
        day: { job_id: "done", kind: "job" },
        active: ["pine"],
        roster: [{ id: "pine", scheduled_start: "2026-09-22T15:00:00Z", scheduled_end: null }],
      }),
      calls,
    );
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual({ off: false, jobId: "pine" });
  });
});

describe("scheduledJobFor: a rostered job whose days cover the date", () => {
  it("a job booked Monday to Wednesday with no segments covers day two", async () => {
    // Mon Sep 21, 8:00 AM to Wed Sep 23, 5:00 PM Pacific.
    const sb = fakeSupabase(planRoutes({ roster: [{ id: "pine", scheduled_start: "2026-09-21T15:00:00Z", scheduled_end: "2026-09-24T00:00:00Z" }] }), calls);
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual({ off: false, jobId: "pine" });
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-23", TZ)).toEqual({ off: false, jobId: "pine" });
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-24", TZ)).toEqual(NOTHING_SCHEDULED);
  });

  it("a segment covering the day counts; the earliest start wins among several", async () => {
    const sb = fakeSupabase(
      planRoutes({
        roster: [
          { id: "late", scheduled_start: "2026-09-10T20:00:00Z", scheduled_end: null },
          { id: "early", scheduled_start: "2026-09-10T15:00:00Z", scheduled_end: null },
        ],
        segments: [
          { job_id: "late", start_date: "2026-09-22", end_date: "2026-09-22" },
          { job_id: "early", start_date: "2026-09-21", end_date: "2026-09-25" },
        ],
      }),
      calls,
    );
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual({ off: false, jobId: "early" });
    const segs = calls.find(isSegments)!;
    expect(segs.cols).toBe("job_id, start_date, end_date");
    expect(segs.filters).toEqual([["in", "job_id", ["late", "early"]]]);
  });

  it("A GAP DAY IS NOT A JOB DAY: a job booked day 1 and day 3 is not on day 2, and on day 2 the job booked that day wins", async () => {
    // Honeysuckle: 9/18, 9/22 and 9/24 (Add To Schedule), its window mirrored 9/18 8 AM to 9/24 4 PM.
    // Siskin: one day, 9/23 at 10 AM. Brian is on both crews.
    const honeysuckle = { id: "honeysuckle", scheduled_start: "2026-09-18T15:00:00Z", scheduled_end: "2026-09-24T23:00:00Z" };
    const siskin = { id: "siskin", scheduled_start: "2026-09-23T17:00:00Z", scheduled_end: "2026-09-23T19:00:00Z" };
    const segments = [
      { job_id: "honeysuckle", start_date: "2026-09-18", end_date: "2026-09-18" },
      { job_id: "honeysuckle", start_date: "2026-09-22", end_date: "2026-09-22" },
      { job_id: "honeysuckle", start_date: "2026-09-24", end_date: "2026-09-24" },
      { job_id: "siskin", start_date: "2026-09-23", end_date: "2026-09-23" },
    ];
    const sb = fakeSupabase(planRoutes({ roster: [honeysuckle, siskin], segments }), calls);
    // Day 2 of the gap: the job actually booked that day, not the older multi-day one.
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-23", TZ)).toEqual({ off: false, jobId: "siskin" });
    // A pure gap day, nothing else booked: nothing, not Honeysuckle.
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-21", TZ)).toEqual(NOTHING_SCHEDULED);
    // Its booked days are still its own.
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual({ off: false, jobId: "honeysuckle" });
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-24", TZ)).toEqual({ off: false, jobId: "honeysuckle" });
  });

  it("the window still answers for a job with no segment rows beside one that has them", async () => {
    // Siskin has no day rows (an old one-day booking): its own window puts it on 9/23.
    const sb = fakeSupabase(
      planRoutes({
        roster: [
          { id: "honeysuckle", scheduled_start: "2026-09-18T15:00:00Z", scheduled_end: "2026-09-24T23:00:00Z" },
          { id: "siskin", scheduled_start: "2026-09-23T17:00:00Z", scheduled_end: null },
        ],
        segments: [
          { job_id: "honeysuckle", start_date: "2026-09-18", end_date: "2026-09-18" },
          { job_id: "honeysuckle", start_date: "2026-09-24", end_date: "2026-09-24" },
        ],
      }),
      calls,
    );
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-23", TZ)).toEqual({ off: false, jobId: "siskin" });
  });

  it("AN EVENING START STAYS ON ITS OWN COMPANY DAY: booked Tuesday 6 PM, it is Tuesday's, not Wednesday's", async () => {
    // Tue Sep 22, 6:00 PM Pacific is stored as Wed Sep 23, 01:00 UTC. The old window sliced the UTC
    // date ("2026-09-23"), so this job covered Wednesday and a Wednesday punch landed on it.
    const evening = { id: "callback", scheduled_start: "2026-09-23T01:00:00Z", scheduled_end: null };
    const sb = fakeSupabase(planRoutes({ roster: [evening] }), calls);
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual({ off: false, jobId: "callback" });
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-23", TZ)).toEqual(NOTHING_SCHEDULED);
  });

  it("nothing rostered: nothing scheduled, and no segment read", async () => {
    const sb = fakeSupabase(planRoutes({}), calls);
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual(NOTHING_SCHEDULED);
    expect(calls.some(isSegments)).toBe(false);
  });

  it("only jobs in flight are asked about: the roster read carries the active statuses", async () => {
    const sb = fakeSupabase(planRoutes({}), calls);
    await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ);
    const roster = calls.find(isRoster)!;
    expect(roster.filters).toEqual(
      expect.arrayContaining([
        ["contains", "assigned_to", ["brian-1"]],
        ["in", "status", ["to_be_scheduled", "scheduled", "in_progress", "on_hold"]],
      ]),
    );
  });

  it("a read that answers with an error falls to the next tier, as the clock always did", async () => {
    const sb = fakeSupabase(
      (q) => (isDayRow(q) ? { error: { message: "relation does not exist" } } : planRoutes({ roster: [{ id: "pine", scheduled_start: "2026-09-22T15:00:00Z", scheduled_end: null }] })(q)),
      calls,
    );
    expect(await scheduledJobFor(sb as any, "brian-1", "2026-09-22", TZ)).toEqual({ off: false, jobId: "pine" });
  });
});

describe("the window, in company days", () => {
  it("windowCoversDay reads the start and the end on the company's calendar", () => {
    const evening = { scheduled_start: "2026-09-23T01:00:00Z", scheduled_end: null };
    expect(windowCoversDay(evening, "2026-09-22", TZ)).toBe(true);
    expect(windowCoversDay(evening, "2026-09-23", TZ)).toBe(false);
    // An end before the start is the start day alone; no start is no window.
    expect(windowCoversDay({ scheduled_start: "2026-09-22T15:00:00Z", scheduled_end: "2026-09-20T15:00:00Z" }, "2026-09-21", TZ)).toBe(false);
    expect(windowCoversDay({ scheduled_start: null, scheduled_end: "2026-09-22T15:00:00Z" }, "2026-09-22", TZ)).toBe(false);
  });

  it("dayBoundsInTz is the company's midnight to the next, a DST night included", () => {
    const { dayStart, dayEnd } = dayBoundsInTz("2026-09-22", TZ);
    expect(dayStart.toISOString()).toBe("2026-09-22T07:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-09-23T07:00:00.000Z");
    const fallBack = dayBoundsInTz("2026-11-01", TZ);
    expect((fallBack.dayEnd.getTime() - fallBack.dayStart.getTime()) / 3_600_000).toBe(25);
  });
});

describe("the clock resolves exactly as before (resolveTechJobToday, through a job-less Clock In)", () => {
  // Wednesday Sep 23, 10:00 AM Pacific.
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-09-23T17:00:00Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A tech's one-tap punch with no job, against a schedule; the job the punch landed on. */
  async function punch(p: Plan): Promise<{ jobId: string | null; result: any }> {
    const route = planRoutes(p);
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
      if (q.table === "profiles") return { data: { role: "tech" } };
      if (q.table === "organizations") return { data: { settings: { timezone: TZ } } };
      if (q.table === "time_entries" && q.verb === "insert") return { data: { id: "new-punch" } };
      // promoteJobToInProgress reads the job it would move; nothing to move here.
      if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: null };
      // The label read behind the clock's "the app picked that job" sentence (clock-told).
      if (q.table === "jobs" && q.cols.startsWith("id, job_number")) {
        const id = q.filters.find((f: any[]) => f[0] === "eq" && f[1] === "id")?.[2] as string;
        return { data: { id, job_number: "J-1", name: `${id} site`, address: null, customers: null } };
      }
      return route(q);
    }, calls);
    const result = await clockIn({ job_id: null, job_code: null, gps: null });
    const ins = calls.find((c) => c.table === "time_entries" && c.verb === "insert");
    return { jobId: ins?.payload?.job_id ?? null, result };
  }

  it("today's day row wins", async () => {
    const { jobId, result } = await punch({ day: { job_id: "larkspur", kind: "job" }, active: ["larkspur"], inProgress: ["pine"] });
    expect(jobId).toBe("larkspur");
    // NOBODY PICKED THIS JOB — the schedule did, and the answer says so now, so every clock door can
    // name it out loud instead of leaving the hours on it in silence (clock-told, Erik's ARR 56).
    expect(result).toEqual({ ok: true, id: "new-punch", jobPick: { chosenBy: "app", id: "larkspur", from: "schedule", label: "larkspur site" } });
    // Asked about the company's today.
    expect(calls.find(isDayRow)!.filters).toContainEqual(["eq", "work_date", "2026-09-23"]);
  });

  it("marked off today: the punch lands on no job, even with one job in progress (tier 2 never guesses past OFF)", async () => {
    const { jobId, result } = await punch({ day: { job_id: null, kind: "off" }, inProgress: ["pine"] });
    expect(jobId).toBeNull();
    expect(result).toEqual({ ok: true, id: "new-punch", noJob: true });
    expect(calls.some(isInProgress)).toBe(false);
  });

  it("no day row: day two of a job whose window covers it", async () => {
    const { jobId } = await punch({ roster: [{ id: "pine", scheduled_start: "2026-09-22T15:00:00Z", scheduled_end: "2026-09-25T00:00:00Z" }] });
    expect(jobId).toBe("pine");
  });

  it("no day row: a gap between a job's booked days is not today, so the punch lands on the job booked today", async () => {
    const { jobId } = await punch({
      roster: [
        { id: "honeysuckle", scheduled_start: "2026-09-18T15:00:00Z", scheduled_end: "2026-09-24T23:00:00Z" },
        { id: "siskin", scheduled_start: "2026-09-23T17:00:00Z", scheduled_end: "2026-09-23T19:00:00Z" },
      ],
      segments: [
        { job_id: "honeysuckle", start_date: "2026-09-22", end_date: "2026-09-22" },
        { job_id: "honeysuckle", start_date: "2026-09-24", end_date: "2026-09-24" },
        { job_id: "siskin", start_date: "2026-09-23", end_date: "2026-09-23" },
      ],
    });
    expect(jobId).toBe("siskin");
  });

  it("no day row: a segment covering today", async () => {
    const { jobId } = await punch({
      roster: [{ id: "tupelo", scheduled_start: "2026-09-01T15:00:00Z", scheduled_end: "2026-09-30T00:00:00Z" }],
      segments: [{ job_id: "tupelo", start_date: "2026-09-23", end_date: "2026-09-23" }],
    });
    expect(jobId).toBe("tupelo");
  });

  it("nothing scheduled: the org's only job in progress (tier 2, the clock's alone)", async () => {
    expect((await punch({ inProgress: ["pine"] })).jobId).toBe("pine");
  });

  it("nothing scheduled and two jobs in progress: no guess", async () => {
    const { jobId, result } = await punch({ inProgress: ["pine", "larkspur"] });
    expect(jobId).toBeNull();
    expect(result.noJob).toBe(true);
  });

  it("THE ONE CHANGE: a job booked yesterday at 6 PM no longer catches this morning's punch", async () => {
    // Tue Sep 22, 6:00 PM Pacific = 2026-09-23T01:00:00Z. The old resolver sliced "2026-09-23" out of
    // it and put Wednesday's punch on the callback; the company's calendar says it was Tuesday's.
    const { jobId } = await punch({ roster: [{ id: "callback", scheduled_start: "2026-09-23T01:00:00Z", scheduled_end: null }] });
    expect(jobId).toBeNull();
  });

  it("the same change at the other end: yesterday's 8-to-5 job (its 5 PM is today in UTC) is not today's", async () => {
    // Tue Sep 22, 8:00 AM to 5:00 PM Pacific: the end is stored as 2026-09-23T00:00:00Z, and the old
    // slice read Wednesday into the window.
    const { jobId } = await punch({ roster: [{ id: "tuesday", scheduled_start: "2026-09-22T15:00:00Z", scheduled_end: "2026-09-23T00:00:00Z" }] });
    expect(jobId).toBeNull();
  });

  it("and a job booked for today resolves today, its evening end or not", async () => {
    // Wed Sep 23, 8:00 AM to 5:00 PM Pacific.
    const { jobId } = await punch({ roster: [{ id: "today", scheduled_start: "2026-09-23T15:00:00Z", scheduled_end: "2026-09-24T00:00:00Z" }] });
    expect(jobId).toBe("today");
  });
});
