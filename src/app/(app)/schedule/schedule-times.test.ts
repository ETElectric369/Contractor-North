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

describe("a length is saved before the placement reads it", () => {
  it("sized 2h on the rail, then placed at 10:00: the placement reads the stored size and lands 10 to 12", async () => {
    state.db.jobs.push({ id: "j3", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    expect(await actions.sizeJob("j3", 120)).toEqual({ ok: true });
    const res = await actions.placeJobOnDay("j3", "2026-09-28", "10:00");
    expect(res).toEqual({ ok: true });
    expect(job("j3")).toMatchObject({ scheduled_start: at("2026-09-28", "10:00"), scheduled_end: at("2026-09-28", "12:00"), planned_minutes: 120, status: "scheduled" });
    expect(segs("j3")).toEqual(["2026-09-28..2026-09-28"]);
  });

  it("no length anywhere: two hours from the start, the size left blank, and the answer says so", async () => {
    state.db.jobs.push({ id: "j4", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null });
    const res = await actions.placeJobOnDay("j4", "2026-09-28", "09:00");
    expect(res).toEqual({ ok: true, defaulted: true });
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
