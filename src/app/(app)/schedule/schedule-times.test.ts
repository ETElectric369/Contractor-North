import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE SCHEDULE WRITERS, on the server, without a database: a job lands exactly where and as long as
 * chosen (Erik, 2026-09-28, J-058: "i set it for 2 hours and it jumped to a later time block for many
 * hours"). An in-memory stand-in for the Supabase client applies each write to rows the next read
 * sees, so a length saved by one door is what the next door reads.
 */
type Row = Record<string, any>;
type Write = { table: string; op: "insert" | "update" | "delete"; row?: any; filters: Record<string, unknown> };

const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  writes: [] as Write[],
}));

function builder(table: string) {
  const q = {
    op: "select" as "select" | "insert" | "update" | "delete",
    filters: [] as [string, "eq" | "in" | "is", unknown][],
    row: undefined as any,
  };
  const match = (r: Row) =>
    q.filters.every(([k, op, v]) =>
      op === "eq" ? r[k] === v : op === "in" ? (v as unknown[]).includes(r[k]) : (r[k] ?? null) === v,
    );
  const filtersOf = () => Object.fromEntries(q.filters.map(([k, , v]) => [k, v]));
  const run = (single: boolean) => {
    const rows = state.db[table] ?? (state.db[table] = []);
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
    select: () => b,
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
    maybeSingle: async () => run(true),
    single: async () => run(true),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad),
  };
  for (const m of ["neq", "not", "or", "order", "limit", "lt", "lte", "gt", "gte"]) b[m] = () => b;
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
const { rescheduleAppointment } = await import("../appointments/actions");
const { tzDateTimeUtc } = await import("@/lib/tz");

const LA = "America/Los_Angeles";
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA);
const job = (id: string) => state.db.jobs.find((j) => j.id === id)!;
const jobUpdates = (id: string) => state.writes.filter((w) => w.table === "jobs" && w.op === "update" && w.filters.id === id);
const segs = (id: string) =>
  (state.db.job_schedule_segments ?? [])
    .filter((s) => s.job_id === id)
    .map((s) => `${s.start_date}..${s.end_date}`)
    .sort();

beforeEach(() => {
  state.writes = [];
  state.db = {
    // ET Electric's shape: Pacific, a 9-to-5 day.
    organizations: [{ id: "org-1", settings: { timezone: LA, work_day_start: "09:00", work_day_end: "17:00" } }],
    jobs: [],
    job_schedule_segments: [],
    time_entries: [],
    appointments: [],
    schedule_proposals: [],
    customers: [],
  };
  vi.mocked(rescheduleAppointment).mockClear();
});

describe("a chosen length is saved WITH the block, in one row write", () => {
  it("a 2h pick on J-058 (stored 10 AM to the 5 PM stamp) writes 10:00–12:00 and planned_minutes 120 together", async () => {
    state.db.jobs.push({ id: "j058", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "17:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j058", start_date: "2026-09-28", end_date: "2026-09-28" });

    expect(await actions.setJobTimes("j058", { length: 120 })).toEqual({ ok: true });
    const ups = jobUpdates("j058").filter((w) => "scheduled_start" in (w.row ?? {}));
    expect(ups).toHaveLength(1);
    expect(ups[0].row).toMatchObject({
      scheduled_start: "2026-09-28T17:00:00.000Z",
      scheduled_end: "2026-09-28T19:00:00.000Z",
      planned_minutes: 120,
    });
  });

  it("Full Day is the company's day, sized as a day", async () => {
    state.db.jobs.push({ id: "j1", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j1", start_date: "2026-09-28", end_date: "2026-09-28" });
    await actions.setJobTimes("j1", { length: "full" });
    expect(job("j1")).toMatchObject({ scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-28", "17:00"), planned_minutes: 480 });
  });

  it("a new start keeps the length (10–12 moved to 1 PM is 1–3), and writes no size nobody chose", async () => {
    state.db.jobs.push({ id: "j1", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j1", start_date: "2026-09-28", end_date: "2026-09-28" });
    await actions.setJobTimes("j1", { start: "13:00" });
    expect(job("j1")).toMatchObject({ scheduled_start: at("2026-09-28", "13:00"), scheduled_end: at("2026-09-28", "15:00"), planned_minutes: null });
    const up = jobUpdates("j1").find((w) => "scheduled_start" in (w.row ?? {}))!;
    expect(up.row).not.toHaveProperty("planned_minutes");
  });
});

describe("a length change keeps worked days", () => {
  it("Sep 22 was worked and stays as history; the plan on the 28th gets its four hours; the listed start stays the 28th", async () => {
    state.db.jobs.push({ id: "j2", status: "in_progress", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push(
      { job_id: "j2", start_date: "2026-09-22", end_date: "2026-09-22" },
      { job_id: "j2", start_date: "2026-09-28", end_date: "2026-09-28" },
    );
    state.db.time_entries.push({ id: "t1", job_id: "j2", clock_in: "2026-09-22T17:00:00Z" });

    expect((await actions.setJobTimes("j2", { length: 240 })).ok).toBe(true);
    expect(segs("j2")).toEqual(["2026-09-22..2026-09-22", "2026-09-28..2026-09-28"]);
    expect(job("j2")).toMatchObject({ scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "14:00"), planned_minutes: 240 });
  });
});

describe("a length is saved before the placement reads it", () => {
  it("sized 2h on the rail, then placed at 10:00: the placement reads the stored size and lands 10 to 12", async () => {
    state.db.jobs.push({ id: "j3", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    expect(await actions.sizeJob("j3", 120)).toEqual({ ok: true });
    const res = await actions.placeJobOnDay("j3", "2026-09-28", "10:00");
    // `prior`: what the place changed, read before the write, for the rail's Undo (W2-05).
    expect(res).toEqual({ ok: true, prior: expect.any(Object) });
    expect(job("j3")).toMatchObject({ scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: 120, status: "scheduled" });
    expect(segs("j3")).toEqual(["2026-09-28..2026-09-28"]);
  });

  it("no length anywhere: two hours from the start, the size left blank, and the answer says so", async () => {
    state.db.jobs.push({ id: "j4", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    const res = await actions.placeJobOnDay("j4", "2026-09-28", "09:00");
    expect(res).toEqual({ ok: true, defaulted: true, prior: expect.any(Object) });
    expect(job("j4")).toMatchObject({ scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-28", "11:00"), planned_minutes: null });
  });

  it("the tray's Schedule (no time) on an unsized job: from the opening, two hours", async () => {
    state.db.jobs.push({ id: "j5", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    await actions.placeJobOnDay("j5", "2026-11-02");
    expect(job("j5")).toMatchObject({ scheduled_start: "2026-11-02T17:00:00.000Z", scheduled_end: "2026-11-02T19:00:00.000Z" });
  });
});

describe("the range writer takes a length too", () => {
  it("Full Day through setJobScheduleRanges: the company's day, sized as a day", async () => {
    state.db.jobs.push({ id: "r1", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    expect(await actions.setJobScheduleRanges("r1", [{ start: "2026-09-28", end: "2026-09-28" }], undefined, "full")).toEqual({ ok: true });
    expect(job("r1")).toMatchObject({ scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-28", "17:00"), planned_minutes: 480 });
  });

  it("a length no job can have is refused in words, and nothing is written", async () => {
    state.db.jobs.push({ id: "r2", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null });
    expect((await actions.setJobScheduleRanges("r2", [{ start: "2026-09-28", end: "2026-09-28" }], undefined, 0)).ok).toBe(false);
    expect(state.writes).toEqual([]);
  });
});

describe("a move keeps the block", () => {
  it("10–12 on Monday moved to Tuesday is 10–12 on Tuesday", async () => {
    state.db.jobs.push({ id: "j6", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j6", start_date: "2026-09-28", end_date: "2026-09-28" });
    expect((await actions.moveJobDay("j6", "2026-09-28", "2026-09-29")).ok).toBe(true);
    expect(job("j6")).toMatchObject({ scheduled_start: at("2026-09-29", "10:00"), scheduled_end: at("2026-09-29", "12:00") });
  });

  it("an all-day job moved stays all day", async () => {
    state.db.jobs.push({ id: "j7", status: "scheduled", scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-28", "17:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j7", start_date: "2026-09-28", end_date: "2026-09-28" });
    await actions.moveJobDay("j7", "2026-09-28", "2026-10-05");
    expect(job("j7")).toMatchObject({ scheduled_start: at("2026-10-05", "09:00"), scheduled_end: at("2026-10-05", "17:00") });
  });
});

describe("setJobTimes says no in words", () => {
  it("a bad start or length is refused in words, and nothing is written", async () => {
    state.db.jobs.push({ id: "j8", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j8", start_date: "2026-09-28", end_date: "2026-09-28" });
    expect(await actions.setJobTimes("j8", { start: "noon" })).toEqual({ ok: false, error: "Pick a start time." });
    expect((await actions.setJobTimes("j8", { length: -30 })).ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it("a job with no day is asked for one first", async () => {
    state.db.jobs.push({ id: "j9", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    expect(await actions.setJobTimes("j9", { length: 120 })).toEqual({ ok: false, error: "Give the job a day first, then its time." });
    // Nor onto a worked day kept as history after its date was cleared: that past day would become the plan.
    state.db.jobs.push({ id: "j9b", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j9b", start_date: "2026-09-22", end_date: "2026-09-22" });
    expect(await actions.setJobTimes("j9b", { start: "10:00" })).toEqual({ ok: false, error: "Give the job a day first, then its time." });
    expect(state.writes).toEqual([]);
  });

  it("a job that isn't there (another company's, or gone) says so", async () => {
    expect(await actions.setJobTimes("nope", { length: 120 })).toEqual({ ok: false, error: "Job not found." });
    expect(state.writes).toEqual([]);
  });
});

describe("Clear The Date", () => {
  it("the plan leaves, the worked day stays, and a Scheduled job waits for a day again", async () => {
    state.db.jobs.push({ id: "j10", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push(
      { job_id: "j10", start_date: "2026-09-22", end_date: "2026-09-22" },
      { job_id: "j10", start_date: "2026-09-28", end_date: "2026-09-28" },
    );
    state.db.time_entries.push({ id: "t1", job_id: "j10", clock_in: "2026-09-22T17:00:00Z" });
    state.db.schedule_proposals.push({ id: "p1", job_id: "j10", status: "pending" });

    const res = await actions.clearJobDate("j10");
    expect(res.ok).toBe(true);
    expect(res.kept).toEqual(["2026-09-22"]);
    expect(res.note).toContain("Kept Sep 22 on the calendar");
    expect(res.note).toContain("pick-a-date link was withdrawn");
    expect(job("j10")).toMatchObject({ scheduled_start: null, scheduled_end: null, status: "to_be_scheduled" });
    expect(segs("j10")).toEqual(["2026-09-22..2026-09-22"]);
    expect(state.db.schedule_proposals[0].status).toBe("cancelled");
  });

  it("a job already under way keeps its status", async () => {
    state.db.jobs.push({ id: "j11", status: "in_progress", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j11", start_date: "2026-09-28", end_date: "2026-09-28" });
    expect((await actions.clearJobDate("j11")).ok).toBe(true);
    expect(job("j11").status).toBe("in_progress");
    expect(job("j11").scheduled_start).toBeNull();
  });
});

describe("Clear The Date, then put back: lands exactly where and as long as chosen, the history stays history", () => {
  const cleared = async (id: string) => {
    state.db.jobs.push({ id, status: "scheduled", scheduled_start: at("2026-09-29", "10:00"), scheduled_end: at("2026-09-29", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push(
      { job_id: id, start_date: "2026-09-22", end_date: "2026-09-22" },
      { job_id: id, start_date: "2026-09-29", end_date: "2026-09-29" },
    );
    state.db.time_entries.push({ id: `t-${id}`, job_id: id, clock_in: "2026-09-22T17:00:00Z" });
    expect((await actions.clearJobDate(id)).ok).toBe(true);
    expect(job(id).scheduled_start).toBeNull();
  };

  it("placed again from the rail on Oct 5 at 9:00: a 9:00–11:00 block on Oct 5 (the default, said), Sep 22 kept as history", async () => {
    await cleared("c1");
    expect(await actions.placeJobOnDay("c1", "2026-10-05", "09:00")).toEqual({ ok: true, defaulted: true, prior: expect.any(Object) });
    expect(job("c1")).toMatchObject({ scheduled_start: at("2026-10-05", "09:00"), scheduled_end: at("2026-10-05", "11:00") });
    expect(segs("c1")).toEqual(["2026-09-22..2026-09-22", "2026-10-05..2026-10-05"]);
  });

  it("a size it had lands with it (sized 2h, placed at 1:00 PM: 1 to 3), never a full day", async () => {
    await cleared("c2");
    job("c2").planned_minutes = 120;
    await actions.placeJobOnDay("c2", "2026-10-05", "13:00");
    expect(job("c2")).toMatchObject({ scheduled_start: at("2026-10-05", "13:00"), scheduled_end: at("2026-10-05", "15:00") });
  });

  it("placed from the tray (no time): from the opening, two hours, on the new day", async () => {
    await cleared("c3");
    await actions.placeJobOnDay("c3", "2026-10-05");
    expect(job("c3")).toMatchObject({ scheduled_start: at("2026-10-05", "09:00"), scheduled_end: at("2026-10-05", "11:00") });
  });

  it("the tray's Undo takes the plan off again and leaves the worked day as history, never as the plan", async () => {
    await cleared("c4");
    await actions.placeJobOnDay("c4", "2026-10-05");
    expect(await actions.unplaceJob("c4")).toEqual({ ok: true });
    expect(job("c4")).toMatchObject({ scheduled_start: null, scheduled_end: null, status: "to_be_scheduled" });
    expect(segs("c4")).toEqual(["2026-09-22..2026-09-22"]);
  });

  it("Move from its history tile gives it a day (a placement), never a block stretched from the worked day", async () => {
    await cleared("c5");
    expect((await actions.moveJobDay("c5", "2026-09-22", "2026-10-06")).ok).toBe(true);
    expect(job("c5")).toMatchObject({ scheduled_start: at("2026-10-06", "09:00"), scheduled_end: at("2026-10-06", "11:00") });
    expect(segs("c5")).toEqual(["2026-09-22..2026-09-22", "2026-10-06..2026-10-06"]);
  });

  it("an on-hold job with a stale day nobody worked: the stale day goes, the new day is the plan", async () => {
    state.db.jobs.push({ id: "h1", status: "on_hold", scheduled_start: at("2026-09-24", "09:00"), scheduled_end: at("2026-09-24", "17:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "h1", start_date: "2026-09-24", end_date: "2026-09-24" });
    await actions.placeJobOnDay("h1", "2026-10-05", "09:00");
    expect(segs("h1")).toEqual(["2026-10-05..2026-10-05"]);
    expect(job("h1")).toMatchObject({ status: "scheduled", scheduled_start: at("2026-10-05", "09:00"), scheduled_end: at("2026-10-05", "11:00") });
  });

  it("the same on-hold job with a stale 10-to-5 stamp placed on that day at 1:00 PM: 1 to 3 (the fitter's two hours), never 1 to 8", async () => {
    state.db.jobs.push({ id: "h2", status: "on_hold", scheduled_start: at("2026-10-05", "10:00"), scheduled_end: at("2026-10-05", "17:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "h2", start_date: "2026-10-05", end_date: "2026-10-05" });
    expect(await actions.placeJobOnDay("h2", "2026-10-05", "13:00")).toEqual({ ok: true, defaulted: true, prior: expect.any(Object) });
    expect(job("h2")).toMatchObject({ scheduled_start: at("2026-10-05", "13:00"), scheduled_end: at("2026-10-05", "15:00") });
  });

  it("a job with a live plan and a kept worked day: a placed day joins the plan, the listed start never goes back to history", async () => {
    state.db.jobs.push({ id: "p1", status: "in_progress", scheduled_start: at("2026-10-05", "10:00"), scheduled_end: at("2026-10-05", "12:00"), planned_minutes: null });
    state.db.job_schedule_segments.push(
      { job_id: "p1", start_date: "2026-09-22", end_date: "2026-09-22" },
      { job_id: "p1", start_date: "2026-10-05", end_date: "2026-10-05" },
    );
    await actions.placeJobOnDay("p1", "2026-10-06");
    expect(job("p1").scheduled_start).toBe(at("2026-10-05", "10:00"));
    // The job's 10 to 12 is its hours on the added day too: the end lands on the last day at 12, never closing.
    expect(job("p1").scheduled_end).toBe(at("2026-10-06", "12:00"));
  });
});

describe("a length typed as an End is the block's clock, and the job's load stays one day", () => {
  it("8:00 to 5:00 PM on an 8-to-5 company, cleared and put back: one day, not two", async () => {
    state.db.organizations[0].settings = { timezone: LA, work_day_start: "08:00", work_day_end: "17:00" };
    state.db.jobs.push({ id: "e1", status: "scheduled", scheduled_start: at("2026-10-05", "08:00"), scheduled_end: at("2026-10-05", "10:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "e1", start_date: "2026-10-05", end_date: "2026-10-05" });
    expect((await actions.setJobTimes("e1", { length: 540 })).ok).toBe(true);
    expect(job("e1")).toMatchObject({ scheduled_end: at("2026-10-05", "17:00"), planned_minutes: 480 });
    await actions.clearJobDate("e1");
    await actions.placeJobOnDay("e1", "2026-10-07", "08:00");
    expect(segs("e1")).toEqual(["2026-10-07..2026-10-07"]);
    // Its size is a day, so the day it lands on is its whole day, 8 to 5, and only that one.
    expect(job("e1")).toMatchObject({ scheduled_start: at("2026-10-07", "08:00"), scheduled_end: at("2026-10-07", "17:00") });
  });

  it("7:00–4:00 PM on a 7-to-5 company, moved a day by the tile's Move: still 7:00–4:00 PM", async () => {
    state.db.organizations[0].settings = { timezone: LA, work_day_start: "07:00", work_day_end: "17:00" };
    state.db.jobs.push({ id: "e2", status: "scheduled", scheduled_start: at("2026-10-05", "07:00"), scheduled_end: at("2026-10-05", "09:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "e2", start_date: "2026-10-05", end_date: "2026-10-05" });
    await actions.setJobTimes("e2", { length: 540 });
    expect((await actions.moveJobDay("e2", "2026-10-05", "2026-10-06")).ok).toBe(true);
    expect(job("e2")).toMatchObject({ scheduled_start: at("2026-10-06", "07:00"), scheduled_end: at("2026-10-06", "16:00") });
  });

  it("J-058 as stored (10 AM to the 5 PM stamp, unsized) with its start moved to 2:00 PM: 2 to 4, said", async () => {
    state.db.jobs.push({ id: "j058b", status: "scheduled", scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "17:00"), planned_minutes: null });
    state.db.job_schedule_segments.push({ job_id: "j058b", start_date: "2026-09-28", end_date: "2026-09-28" });
    expect(await actions.setJobTimes("j058b", { start: "14:00" })).toEqual({ ok: true, defaulted: true });
    expect(job("j058b")).toMatchObject({ scheduled_start: at("2026-09-28", "14:00"), scheduled_end: at("2026-09-28", "16:00") });
  });
});

describe("a visit's times, on the company's clock", () => {
  it("9 to 11 on Mon Nov 2 (after the clocks go back) goes to the visit's own writer as 17:00Z–19:00Z", async () => {
    expect(await actions.setVisitTimes("a1", { day: "2026-11-02", start: "09:00", end: "11:00" })).toEqual({ ok: true });
    expect(rescheduleAppointment).toHaveBeenCalledWith("a1", "2026-11-02T17:00:00.000Z", "2026-11-02T19:00:00.000Z");
  });

  it("an end before the start is refused in words, and the writer is never called", async () => {
    expect(await actions.setVisitTimes("a1", { day: "2026-09-28", start: "11:00", end: "09:00" })).toEqual({ ok: false, error: "The end has to be after the start." });
    expect(rescheduleAppointment).not.toHaveBeenCalled();
  });
});

describe("the fitter: where \"morning\" lands", () => {
  const morning = (jobIds: string[] = ["j058"]) =>
    actions.planDayTimes("2026-09-28", [{ minutes: 120 }], "09:00", { jobIds });

  it("J-058's hop, reproduced: a 9:00 visit on the day (no end, so an hour) puts the job at 10:00", async () => {
    state.db.appointments.push({ id: "v1", starts_at: at("2026-09-28", "09:00"), ends_at: null, type: "inspection", status: "scheduled", job_id: null, absorbed: false });
    expect(await morning()).toEqual({ ok: true, times: ["10:00"] });
  });

  it("the job's OWN visit never pushes it (the calendar hides that visit behind the job)", async () => {
    state.db.appointments.push({ id: "v1", starts_at: at("2026-09-28", "09:00"), ends_at: null, type: "inspection", status: "scheduled", job_id: "j058", absorbed: false });
    expect(await morning()).toEqual({ ok: true, times: ["09:00"] });
  });

  it("nor its own block already on that day", async () => {
    state.db.jobs.push({ id: "j058", status: "scheduled", scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-28", "11:00"), planned_minutes: null });
    expect(await morning()).toEqual({ ok: true, times: ["09:00"] });
    // Someone else's job there does push it.
    expect(await morning(["other"])).toEqual({ ok: true, times: ["11:00"] });
  });

  it("a job sized 2h still holds only its 2h (the stamp to 5 PM doesn't fill the day)", async () => {
    state.db.jobs.push({ id: "k1", status: "scheduled", scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-28", "17:00"), planned_minutes: 120 });
    expect(await morning()).toEqual({ ok: true, times: ["11:00"] });
  });
});

describe("Nort's job.scheduleDay", () => {
  it("a job with no length lands as two hours from the opening, and the answer says so for Nort to read back", async () => {
    state.db.jobs.push({ id: "n1", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    expect(await actions.scheduleJobWindow("n1", "2026-10-05")).toMatchObject({ ok: true, defaulted: true });
    expect(job("n1")).toMatchObject({ scheduled_start: at("2026-10-05", "09:00"), scheduled_end: at("2026-10-05", "11:00") });
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/lib/actions/entities/job.ts"), "utf8");
    const verb = src.slice(src.indexOf('"job.scheduleDay": {'), src.indexOf('"job.move": {'));
    expect(verb).toContain("r.defaulted");
    expect(verb).toContain("it went down as 2 hours from the start of the work day");
    expect(verb).toContain("recorded: said");
  });

  it("a window over several days is full days, the last to closing", async () => {
    state.db.jobs.push({ id: "n2", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    const r = await actions.scheduleJobWindow("n2", "2026-10-05", "2026-10-07");
    expect(r.ok).toBe(true);
    expect(r.defaulted).toBeUndefined();
    expect(job("n2")).toMatchObject({ scheduled_start: at("2026-10-05", "09:00"), scheduled_end: at("2026-10-07", "17:00") });
  });
});

describe("New Job: a dated job lands as two hours, never the rest of the day", () => {
  const fd = (e: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(e)) f.append(k, v);
    return f;
  };
  const inserted = () => state.writes.find((w) => w.table === "jobs" && w.op === "insert")!.row;

  it("a day with no time: from the opening, two hours", async () => {
    expect((await actions.createJob(fd({ name: "A", scheduled_date: "2026-11-02", scheduled_time: "", billing_type: "tm" }))).ok).toBe(true);
    expect(inserted()).toMatchObject({ scheduled_start: "2026-11-02T17:00:00.000Z", scheduled_end: "2026-11-02T19:00:00.000Z" });
  });

  it("a day and a time: from that time, two hours", async () => {
    await actions.createJob(fd({ name: "B", scheduled_date: "2026-07-15", scheduled_time: "13:15", billing_type: "tm" }));
    expect(inserted()).toMatchObject({ scheduled_start: at("2026-07-15", "13:15"), scheduled_end: at("2026-07-15", "15:15") });
  });

  it("no day: no start, no end", async () => {
    await actions.createJob(fd({ name: "C", scheduled_date: "", billing_type: "tm" }));
    expect(inserted()).toMatchObject({ scheduled_start: null, scheduled_end: null });
  });
});
