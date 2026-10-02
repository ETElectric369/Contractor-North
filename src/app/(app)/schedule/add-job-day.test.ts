import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ADD TO SCHEDULE FOR ANY JOB, AND EACH DAY'S OWN HOURS, on the server without a database (Erik,
 * 2026-09-28: "i want to put honysuckle on the page for the rest of the day after Siskin but theres no
 * way to add to the schedule from the schedule page unless its already scripted"). An in-memory
 * stand-in for the Supabase client applies each write to rows the next read sees; `noHours` plays a
 * database without 0370 (a select or an insert naming start_time/end_time fails with 42703, the way
 * Postgres does), so the writers are proven to degrade to today's behavior, never to an error.
 */
type Row = Record<string, any>;
type Write = { table: string; op: "insert" | "update" | "delete"; row?: any; filters: Record<string, unknown> };

const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  writes: [] as Write[],
  noHours: false,
  /** Every read of the days fails (a timeout): the writer must stop before it writes anything. */
  failSegRead: false,
}));

const HOURS = /\b(start_time|end_time)\b/;
const missing = { code: "42703", message: 'column job_schedule_segments.start_time does not exist' };

function builder(table: string) {
  const q = {
    op: "select" as "select" | "insert" | "update" | "delete",
    cols: "",
    filters: [] as [string, "eq" | "in" | "is" | "lte" | "gte", unknown][],
    row: undefined as any,
  };
  const match = (r: Row) =>
    q.filters.every(([k, op, v]) =>
      op === "eq"
        ? r[k] === v
        : op === "in"
          ? (v as unknown[]).includes(r[k])
          : op === "is"
            ? (r[k] ?? null) === v
            : op === "lte"
              ? String(r[k] ?? "") <= String(v)
              : String(r[k] ?? "") >= String(v),
    );
  const filtersOf = () => Object.fromEntries(q.filters.map(([k, , v]) => [k, v]));
  const run = (single: boolean) => {
    const rows = state.db[table] ?? (state.db[table] = []);
    if (state.failSegRead && table === "job_schedule_segments" && q.op === "select") {
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    }
    if (state.noHours && table === "job_schedule_segments") {
      const named = q.op === "insert" ? (Array.isArray(q.row) ? q.row : [q.row]).some((r: Row) => "start_time" in r || "end_time" in r) : HOURS.test(q.cols);
      if (named) return { data: null, error: missing };
    }
    if (q.op === "insert") {
      const list = (Array.isArray(q.row) ? q.row : [q.row]).map((x: Row, i: number) => ({ id: x.id ?? `${table}-${rows.length + i + 1}`, ...x }));
      rows.push(...list);
      state.writes.push({ table, op: "insert", row: q.row, filters: {} });
      return { data: single ? list[0] : list, error: null };
    }
    if (q.op === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, q.row);
      state.writes.push({ table, op: "update", row: q.row, filters: filtersOf() });
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (q.op === "delete") {
      const gone = rows.filter(match);
      state.db[table] = rows.filter((r) => !match(r));
      state.writes.push({ table, op: "delete", filters: filtersOf() });
      return { data: gone.map((r) => ({ id: r.id })), error: null };
    }
    const hit = rows.filter(match);
    return { data: single ? (hit[0] ?? null) : hit, error: null };
  };
  const b: any = {
    select(cols?: string) {
      if (q.op === "select") q.cols = String(cols ?? "");
      return b;
    },
    insert(row: any) {
      q.op = "insert";
      q.row = row;
      return b;
    },
    update(row: any) {
      q.op = "update";
      q.row = row;
      return b;
    },
    delete() {
      q.op = "delete";
      return b;
    },
    eq(k: string, v: unknown) {
      q.filters.push([k, "eq", v]);
      return b;
    },
    in(k: string, v: unknown[]) {
      q.filters.push([k, "in", v]);
      return b;
    },
    is(k: string, v: unknown) {
      q.filters.push([k, "is", v]);
      return b;
    },
    lte(k: string, v: unknown) {
      if (table === "job_schedule_segments") q.filters.push([k, "lte", v]);
      return b;
    },
    gte(k: string, v: unknown) {
      if (table === "job_schedule_segments") q.filters.push([k, "gte", v]);
      return b;
    },
    maybeSingle: async () => run(true),
    single: async () => run(true),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad),
  };
  for (const m of ["neq", "not", "or", "order", "limit", "lt", "gt"]) b[m] = () => b;
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: async () => ({ supabase: client, userId: "office-1", orgId: "org-1" }),
  requireMember: async () => ({ supabase: client, userId: "office-1", orgId: "org-1", staff: true, name: "Office" }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => undefined), deleteCalendarItem: vi.fn(async () => undefined) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn(async () => undefined) }));
vi.mock("../appointments/actions", () => ({ rescheduleAppointment: vi.fn(async () => ({ ok: true })) }));

const actions = await import("./actions");
const { notifyJobCrewAdded } = await import("@/lib/crew-notify");
const { tzDateTimeUtc } = await import("@/lib/tz");
const { jobDayBlock } = await import("@/lib/schedule/job-block");

const LA = "America/Los_Angeles";
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA);
const job = (id: string) => state.db.jobs.find((j) => j.id === id)!;
/** A job's days as "start..end hh:mm-hh:mm" (or "usual"), sorted. */
const days = (id: string) =>
  (state.db.job_schedule_segments ?? [])
    .filter((s) => s.job_id === id)
    .map((s) => `${s.start_date}..${s.end_date} ${s.start_time ? `${String(s.start_time).slice(0, 5)}-${String(s.end_time).slice(0, 5)}` : "usual"}`)
    .sort();

beforeEach(() => {
  state.writes = [];
  state.noHours = false;
  state.failSegRead = false;
  state.db = {
    // ET Electric's shape: Pacific, a 9-to-5 day.
    organizations: [{ id: "org-1", settings: { timezone: LA, work_day_start: "09:00", work_day_end: "17:00" } }],
    jobs: [],
    job_schedule_segments: [],
    time_entries: [],
    appointments: [],
    schedule_proposals: [],
    customers: [],
    profiles: [
      { id: "p-erik", full_name: "Erik Taylor" },
      { id: "p-brian", full_name: "Brian Cole" },
      { id: "p-mike", full_name: "Mike Ross" },
    ],
  };
  vi.mocked(notifyJobCrewAdded).mockClear();
});

/** Honeysuckle as Erik had it: In Progress on 9/18, 9/22 and 9/24 (the plan 9/24, 9 to closing), worked. */
function honeysuckle() {
  state.db.jobs.push({
    id: "j011",
    name: "Honeysuckle",
    status: "in_progress",
    scheduled_start: at("2026-09-24", "09:00"),
    scheduled_end: at("2026-09-24", "17:00"),
    planned_minutes: null,
    assigned_to: ["p-erik"],
  });
  state.db.job_schedule_segments.push(
    { job_id: "j011", start_date: "2026-09-18", end_date: "2026-09-18", start_time: null, end_time: null },
    { job_id: "j011", start_date: "2026-09-22", end_date: "2026-09-22", start_time: null, end_time: null },
    { job_id: "j011", start_date: "2026-09-24", end_date: "2026-09-24", start_time: null, end_time: null },
  );
  state.db.time_entries.push({ job_id: "j011", clock_in: at("2026-09-22", "08:00") }, { job_id: "j011", clock_in: at("2026-09-24", "08:00") });
}

describe("Add To Schedule: the day joins the job, at its own hours", () => {
  it("Honeysuckle gets today, noon to 5, beside its other days, which all stay", async () => {
    honeysuckle();
    const r = await actions.addJobDay("j011", { day: "2026-09-28", start: "12:00", length: 300 });
    expect(r).toMatchObject({ ok: true });
    expect(r.note).toContain("Added Mon, Sep 28, 12:00 PM – 5:00 PM.");
    expect(days("j011")).toEqual([
      "2026-09-18..2026-09-18 usual",
      "2026-09-22..2026-09-22 usual",
      "2026-09-24..2026-09-24 usual",
      "2026-09-28..2026-09-28 12:00-17:00",
    ]);
    // The span grows to cover the new day; its start (and the status) stay.
    expect(job("j011")).toMatchObject({ scheduled_start: at("2026-09-24", "09:00"), scheduled_end: at("2026-09-28", "17:00"), status: "in_progress" });
  });

  it("adding a day never moves another: Siskin's 10 to 12 keeps 10 to 12 when a second day joins (by the rule itself: a job's hours are each day's, so nothing is frozen)", async () => {
    state.db.jobs.push({ id: "j058", name: "Siskin · 3-way switches", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null, assigned_to: [] });
    state.db.job_schedule_segments.push({ job_id: "j058", start_date: "2026-09-28", end_date: "2026-09-28", start_time: null, end_time: null });
    expect((await actions.addJobDay("j058", { day: "2026-09-30", start: "13:00" })).ok).toBe(true);
    expect(days("j058")).toEqual(["2026-09-28..2026-09-28 usual", "2026-09-30..2026-09-30 13:00-15:00"]);
    // The mirror carries 10 to 12 onto the last day: the 28th still draws 10 to 12 with no hours of its own.
    expect(job("j058")).toMatchObject({ scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-30", "12:00") });
    const b = jobDayBlock({ day: "2026-09-28", scheduledStart: job("j058").scheduled_start, scheduledEnd: job("j058").scheduled_end, plannedMinutes: null, tz: LA, wd: { startMin: 9 * 60, endMin: 17 * 60 } });
    expect(b).toEqual({ startMin: 600, endMin: 720, allDay: false });
  });

  it("no length: the job's size when it has one, else two hours, said", async () => {
    honeysuckle();
    const r = await actions.addJobDay("j011", { day: "2026-09-29", start: "13:00" });
    expect(r).toMatchObject({ ok: true, defaulted: true });
    expect(r.note).toContain("(2 hours; change it on its block)");
    expect(days("j011")).toContain("2026-09-29..2026-09-29 13:00-15:00");
    job("j011").planned_minutes = 240;
    expect((await actions.addJobDay("j011", { day: "2026-09-30" })).defaulted).toBeUndefined();
    // No start: the work day's start.
    expect(days("j011")).toContain("2026-09-30..2026-09-30 09:00-13:00");
  });

  it("a job with no day yet: the day is its plan, at those hours, as its usual (no own hours)", async () => {
    state.db.jobs.push({ id: "n1", name: "12 Elm St", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null, assigned_to: [] });
    const r = await actions.addJobDay("n1", { day: "2026-10-05", start: "13:00" });
    expect(r).toMatchObject({ ok: true, defaulted: true });
    expect(job("n1")).toMatchObject({ status: "scheduled", scheduled_start: at("2026-10-05", "13:00"), scheduled_end: at("2026-10-05", "15:00"), planned_minutes: null });
    expect(days("n1")).toEqual(["2026-10-05..2026-10-05 usual"]);
  });

  it("an on-hold job comes off hold (its reason with it), its worked day kept, its stale day gone", async () => {
    state.db.jobs.push({ id: "h1", name: "Tupelo", status: "on_hold", hold_reason: "Waiting on the permit", scheduled_start: at("2026-09-25", "09:00"), scheduled_end: at("2026-09-25", "17:00"), planned_minutes: null, assigned_to: [] });
    state.db.job_schedule_segments.push(
      { job_id: "h1", start_date: "2026-09-21", end_date: "2026-09-21", start_time: "10:00:00", end_time: "14:00:00" },
      { job_id: "h1", start_date: "2026-09-25", end_date: "2026-09-25", start_time: null, end_time: null },
    );
    state.db.time_entries.push({ job_id: "h1", clock_in: at("2026-09-21", "10:05") });
    const r = await actions.addJobDay("h1", { day: "2026-10-05", start: "08:00", length: 120 });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("It's off hold now.");
    expect(job("h1")).toMatchObject({ status: "scheduled", hold_reason: null, scheduled_start: at("2026-10-05", "08:00"), scheduled_end: at("2026-10-05", "10:00") });
    expect(days("h1")).toEqual(["2026-09-21..2026-09-21 10:00-14:00", "2026-10-05..2026-10-05 usual"]);
  });

  it("the crew as the sheet left it, applied to the crew as saved now: someone added rings the bell", async () => {
    honeysuckle();
    // Someone put Mike on from the time clock after the sheet opened; the sheet only added Brian.
    job("j011").assigned_to = ["p-erik", "p-mike"];
    expect((await actions.addJobDay("j011", { day: "2026-09-28", start: "12:00", length: 300, crew: { add: ["p-brian"], remove: ["p-erik"] } })).ok).toBe(true);
    expect(job("j011").assigned_to).toEqual(["p-mike", "p-brian"]);
    expect(notifyJobCrewAdded).toHaveBeenCalledTimes(1);
  });

  it("refused in words: a day it's already on, a finished job, a job that isn't there", async () => {
    honeysuckle();
    expect(await actions.addJobDay("j011", { day: "2026-09-24", start: "12:00" })).toEqual({
      ok: false,
      error: "Honeysuckle is already on Thu, Sep 24. Tap its block there to change its time or crew.",
    });
    job("j011").status = "complete";
    const done = await actions.addJobDay("j011", { day: "2026-09-29" });
    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/^Honeysuckle is .+, so it can't take another day\. Change its status on the job page first\.$/);
    expect((await actions.addJobDay("nope", { day: "2026-09-29" })).error).toBe("That job isn't available. It may have been deleted.");
    expect((await actions.addJobDay("j011", { day: "Monday" })).error).toBe("Pick a day.");
    expect((await actions.addJobDay("j011", { day: "2026-09-29", start: "25:00" })).error).toBe("Pick a start time.");
    expect(state.writes.filter((w) => w.table === "job_schedule_segments")).toEqual([]);
  });

  it("a worked day kept as history (outside the plan) takes the add: it is planned again at these hours", async () => {
    honeysuckle();
    // 9/22 was worked and sits outside the plan (9/24): its block's sheet says its time belongs to the
    // plan, so "tap its block" would be a dead end. The add plans it.
    const r = await actions.addJobDay("j011", { day: "2026-09-22", start: "12:00", length: 300 });
    expect(r).toMatchObject({ ok: true });
    expect(days("j011")).toEqual(["2026-09-18..2026-09-18 usual", "2026-09-22..2026-09-22 12:00-17:00", "2026-09-24..2026-09-24 usual"]);
    expect(job("j011")).toMatchObject({ scheduled_start: at("2026-09-22", "09:00"), scheduled_end: at("2026-09-24", "17:00"), status: "in_progress" });
  });

  it("a job with no live plan, on the day it sits on as history: that day becomes its plan", async () => {
    // Its date was cleared (Clear The Date) and the worked day stayed; the office puts it back on that day.
    state.db.jobs.push({ id: "c1", name: "Tupelo", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null, assigned_to: [] });
    state.db.job_schedule_segments.push({ job_id: "c1", start_date: "2026-09-21", end_date: "2026-09-21", start_time: "10:00:00", end_time: "14:00:00" });
    state.db.time_entries.push({ job_id: "c1", clock_in: at("2026-09-21", "10:05") });
    const r = await actions.addJobDay("c1", { day: "2026-09-21", start: "13:00", length: 120 });
    expect(r).toMatchObject({ ok: true });
    expect(days("c1")).toEqual(["2026-09-21..2026-09-21 usual"]);
    expect(job("c1")).toMatchObject({ status: "scheduled", scheduled_start: at("2026-09-21", "13:00"), scheduled_end: at("2026-09-21", "15:00") });
  });

  it("an on-hold job put back on its old day comes off hold there, instead of being told it's already on it", async () => {
    state.db.jobs.push({ id: "h2", name: "Tupelo", status: "on_hold", hold_reason: "Waiting on the permit", scheduled_start: at("2026-09-25", "09:00"), scheduled_end: at("2026-09-25", "17:00"), planned_minutes: null, assigned_to: [] });
    state.db.job_schedule_segments.push({ job_id: "h2", start_date: "2026-09-25", end_date: "2026-09-25", start_time: null, end_time: null });
    const r = await actions.addJobDay("h2", { day: "2026-09-25", start: "08:00", length: 120 });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("It's off hold now.");
    expect(job("h2")).toMatchObject({ status: "scheduled", hold_reason: null, scheduled_start: at("2026-09-25", "08:00"), scheduled_end: at("2026-09-25", "10:00") });
    expect(days("h2")).toEqual(["2026-09-25..2026-09-25 usual"]);
  });

  it("a pick-a-date link out is asked about first, and withdrawn only when the office says so", async () => {
    honeysuckle();
    state.db.schedule_proposals.push({ id: "sp1", job_id: "j011", status: "pending" });
    const ask = await actions.addJobDay("j011", { day: "2026-09-28", start: "12:00" });
    expect(ask).toMatchObject({ ok: false, needsProposalConfirm: true });
    expect(days("j011")).toHaveLength(3);
    const r = await actions.addJobDay("j011", { day: "2026-09-28", start: "12:00" }, { cancelProposals: true });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("The customer's pick-a-date link was withdrawn.");
    expect(state.db.schedule_proposals[0].status).toBe("cancelled");
  });

  it("a refused add never withdraws the customer's link", async () => {
    honeysuckle();
    state.db.schedule_proposals.push({ id: "sp2", job_id: "j011", status: "pending" });
    const r = await actions.addJobDay("j011", { day: "2026-09-24", start: "12:00" }, { cancelProposals: true });
    expect(r.error).toBe("Honeysuckle is already on Thu, Sep 24. Tap its block there to change its time or crew.");
    expect(state.db.schedule_proposals[0].status).toBe("pending");
  });

  it("before 0370 (no hours columns): the day is added at the job's usual hours, and the note says so", async () => {
    honeysuckle();
    state.noHours = true;
    const r = await actions.addJobDay("j011", { day: "2026-09-28", start: "12:00", length: 300 });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("needs a quick database update, so for now it shows the job's usual hours");
    expect(state.db.job_schedule_segments.filter((s) => s.job_id === "j011").map((s) => s.start_date).sort()).toEqual([
      "2026-09-18",
      "2026-09-22",
      "2026-09-24",
      "2026-09-28",
    ]);
    expect(state.db.job_schedule_segments.every((s) => !("start_time" in s) || s.start_time == null)).toBe(true);
  });
});

describe("This Day: one day's time, that day only (setJobDayTimes)", () => {
  function twoDays() {
    state.db.jobs.push({ id: "t1", name: "Kitchen", status: "scheduled", scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-29", "17:00"), planned_minutes: 960, assigned_to: [] });
    state.db.job_schedule_segments.push({ job_id: "t1", start_date: "2026-09-28", end_date: "2026-09-29", start_time: null, end_time: null });
  }

  it("a day of several gets its own hours; the other day and the job's usual hours stay", async () => {
    twoDays();
    expect(await actions.setJobDayTimes("t1", "2026-09-29", { start: "12:00" })).toEqual({ ok: true });
    // Sized two days: a new start runs to closing.
    expect(days("t1")).toEqual(["2026-09-28..2026-09-28 usual", "2026-09-29..2026-09-29 12:00-17:00"]);
    expect(job("t1")).toMatchObject({ scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-29", "17:00"), planned_minutes: 960 });
    expect(await actions.setJobDayTimes("t1", "2026-09-29", { length: 120 })).toEqual({ ok: true });
    expect(days("t1")).toContain("2026-09-29..2026-09-29 12:00-14:00");
    expect(await actions.setJobDayTimes("t1", "2026-09-29", { usual: true })).toEqual({ ok: true });
    expect(days("t1")).toEqual(["2026-09-28..2026-09-29 usual"]);
  });

  it("the job's one day IS the job's time: the job's hours move (and a day's leftover own hours give way)", async () => {
    state.db.jobs.push({ id: "o1", name: "Siskin", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null, assigned_to: [] });
    state.db.job_schedule_segments.push({ job_id: "o1", start_date: "2026-09-28", end_date: "2026-09-28", start_time: "07:00:00", end_time: "08:00:00" });
    expect(await actions.setJobDayTimes("o1", "2026-09-28", { start: "13:00" })).toEqual({ ok: true });
    // The block drawn was the day's own 7 to 8: a new start keeps that hour on the clock.
    expect(job("o1")).toMatchObject({ scheduled_start: at("2026-09-28", "13:00"), scheduled_end: at("2026-09-28", "14:00"), planned_minutes: null });
    expect(days("o1")).toEqual(["2026-09-28..2026-09-28 usual"]);
  });

  it("refused in words: a day it isn't on, and a day's own hours before 0370", async () => {
    twoDays();
    expect((await actions.setJobDayTimes("t1", "2026-10-02", { start: "12:00" })).error).toBe("That job isn't on Fri, Oct 2 any more. Reload the schedule to see where it is.");
    state.noHours = true;
    expect((await actions.setJobDayTimes("t1", "2026-09-29", { start: "12:00" })).error).toBe(
      "A day keeping its own hours needs a quick database update first. Until then, set the time on the job page; it sets every day.",
    );
  });
});

describe("every rewrite carries each day's hours through (writeScheduleRanges)", () => {
  function withOwnDay() {
    state.db.jobs.push({ id: "w1", name: "Honeysuckle", status: "in_progress", scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-10-01", "17:00"), planned_minutes: null, assigned_to: [] });
    state.db.job_schedule_segments.push(
      { job_id: "w1", start_date: "2026-09-28", end_date: "2026-09-28", start_time: "12:00:00", end_time: "17:00:00" },
      { job_id: "w1", start_date: "2026-09-29", end_date: "2026-10-01", start_time: null, end_time: null },
    );
  }

  it("the job page's time control (the usual hours) leaves a day's own hours alone", async () => {
    withOwnDay();
    expect((await actions.setJobTimes("w1", { start: "08:00" })).ok).toBe(true);
    expect(days("w1")).toEqual(["2026-09-28..2026-09-28 12:00-17:00", "2026-09-29..2026-10-01 usual"]);
  });

  it("the range editor's dates (no hours said) keep each day's hours; a new day is the usual", async () => {
    withOwnDay();
    expect((await actions.setJobScheduleRanges("w1", [{ start: "2026-09-28", end: "2026-10-02" }])).ok).toBe(true);
    expect(days("w1")).toEqual(["2026-09-28..2026-09-28 12:00-17:00", "2026-09-29..2026-10-02 usual"]);
  });

  it("the days can't be read: nothing is written, and it says so (hours are never dropped by a blind rewrite)", async () => {
    withOwnDay();
    state.failSegRead = true;
    expect(await actions.setJobScheduleRanges("w1", [{ start: "2026-09-28", end: "2026-10-02" }])).toEqual({
      ok: false,
      error: "Couldn't read the job's days, so nothing changed. Try again.",
    });
    expect(state.writes).toEqual([]);
    state.failSegRead = false;
    expect(days("w1")).toEqual(["2026-09-28..2026-09-28 12:00-17:00", "2026-09-29..2026-10-01 usual"]);
  });

  it("a move keeps the moved day's own hours on its new day", async () => {
    withOwnDay();
    expect((await actions.moveJobDay("w1", "2026-09-28", "2026-10-05")).ok).toBe(true);
    expect(days("w1")).toContain("2026-10-05..2026-10-05 12:00-17:00");
  });

  it("the fitter reads a day's own hours: noon to 5 is busy, the morning is open", async () => {
    withOwnDay();
    expect(await actions.planDayTimes("2026-09-28", [{ minutes: 120 }], "09:00", { jobIds: [] })).toEqual({ ok: true, times: ["09:00"] });
    expect(await actions.planDayTimes("2026-09-28", [{ minutes: 240 }], "11:00", { jobIds: [] })).toEqual({ ok: true, times: ["17:00"] });
  });
});

describe("a plan that shrinks back to one day: the job's time is the block that day draws", () => {
  const WD = { startMin: 9 * 60, endMin: 17 * 60 };
  /** Where the grid draws the job on `day` (its own hours when it keeps them, else the job's usual). */
  function drawn(id: string, day: string) {
    const j = job(id);
    const seg = (state.db.job_schedule_segments ?? []).find((s) => s.job_id === id && s.start_date <= day && day <= s.end_date);
    const own = seg?.start_time ? { start: String(seg.start_time).slice(0, 5), end: String(seg.end_time).slice(0, 5) } : null;
    const b = jobDayBlock({ day, scheduledStart: j.scheduled_start, scheduledEnd: j.scheduled_end, plannedMinutes: j.planned_minutes, tz: LA, wd: WD, dayHours: own });
    return `${b.startMin / 60}-${b.endMin / 60}`;
  }
  async function siskinPlusWed() {
    state.db.jobs.push({ id: "s1", name: "Siskin", status: "scheduled", scheduled_start: at("2026-10-05", "10:00"), scheduled_end: at("2026-10-05", "12:00"), planned_minutes: null, assigned_to: [] });
    state.db.job_schedule_segments.push({ job_id: "s1", start_date: "2026-10-05", end_date: "2026-10-05", start_time: null, end_time: null });
    expect((await actions.addJobDay("s1", { day: "2026-10-07", start: "13:00", length: 120 })).ok).toBe(true);
    // Mon keeps no hours of its own: the job's 10 to 12 is its hours on every day, so Mon draws it as is.
    expect(days("s1")).toEqual(["2026-10-05..2026-10-05 usual", "2026-10-07..2026-10-07 13:00-15:00"]);
    expect(drawn("s1", "2026-10-05")).toBe("10-12");
  }

  it("the range editor takes Wed off: Mon's 10 to 12 is the job's time again, not 10 to closing", async () => {
    await siskinPlusWed();
    expect((await actions.setJobScheduleRanges("s1", [{ start: "2026-10-05", end: "2026-10-05" }])).ok).toBe(true);
    expect(job("s1")).toMatchObject({ scheduled_start: at("2026-10-05", "10:00"), scheduled_end: at("2026-10-05", "12:00"), planned_minutes: null });
    expect(days("s1")).toEqual(["2026-10-05..2026-10-05 usual"]);
    expect(drawn("s1", "2026-10-05")).toBe("10-12");
  });

  it("Wed's block moved onto Mon: the job's time is the 1 to 3 drawn there, and a 1h tap keeps its 1 PM start", async () => {
    await siskinPlusWed();
    expect((await actions.moveJobDay("s1", "2026-10-07", "2026-10-05")).ok).toBe(true);
    expect(job("s1")).toMatchObject({ scheduled_start: at("2026-10-05", "13:00"), scheduled_end: at("2026-10-05", "15:00") });
    expect(days("s1")).toEqual(["2026-10-05..2026-10-05 usual"]);
    expect(drawn("s1", "2026-10-05")).toBe("13-15");
    expect((await actions.setJobTimes("s1", { length: 60 })).ok).toBe(true);
    expect(drawn("s1", "2026-10-05")).toBe("13-14");
  });
});

describe("before 0370, Add To Schedule never redraws the job's other days", () => {
  it("Siskin's one day 10 to 12 stays 10 to 12 when Wed joins it (a job's hours are each day's), so the add goes on and Wed lands at the usual 10 to 12", async () => {
    state.noHours = true;
    state.db.jobs.push({ id: "s2", name: "Siskin", status: "scheduled", scheduled_start: at("2026-10-05", "10:00"), scheduled_end: at("2026-10-05", "12:00"), planned_minutes: 120, assigned_to: [] });
    state.db.job_schedule_segments.push({ job_id: "s2", start_date: "2026-10-05", end_date: "2026-10-05" });
    state.db.schedule_proposals.push({ id: "sp9", job_id: "s2", status: "pending" });
    const r = await actions.addJobDay("s2", { day: "2026-10-07", start: "13:00", length: 120 }, { cancelProposals: true });
    expect(r.ok).toBe(true);
    // Said: Wed shows the job's usual hours (its own can't be stored before 0370), which are 10 to 12.
    expect(r.note).toContain("Added Wed, Oct 7, 10:00 AM – 12:00 PM.");
    expect(r.note).toContain("shows the job's usual hours");
    expect(job("s2")).toMatchObject({ scheduled_start: at("2026-10-05", "10:00"), scheduled_end: at("2026-10-07", "12:00") });
    const WD = { startMin: 9 * 60, endMin: 17 * 60 };
    for (const day of ["2026-10-05", "2026-10-07"]) {
      const j = job("s2");
      expect(jobDayBlock({ day, scheduledStart: j.scheduled_start, scheduledEnd: j.scheduled_end, plannedMinutes: j.planned_minutes, tz: LA, wd: WD }), day).toEqual({ startMin: 600, endMin: 720, allDay: false });
    }
  });

  it("a day that redraws no other day goes on, and the note says the hours it draws, not the ones asked", async () => {
    honeysuckle();
    state.noHours = true;
    const r = await actions.addJobDay("j011", { day: "2026-09-28", start: "12:00", length: 120 });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("Added Mon, Sep 28, 9:00 AM – 5:00 PM.");
  });
});
