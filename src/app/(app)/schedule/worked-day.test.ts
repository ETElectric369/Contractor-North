import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BOOK THIS DAY (Wave 2, SV-ghost), without a database: bookWorkedDay adds the worked day to the job's
 * days, at the hours actually worked, and NOTHING ELSE (the status, the listed day and a hold never
 * move); it is twice-safe; it refuses a day nobody clocked time on the job (never a back-dating door)
 * and a day that isn't past; unbookWorkedDay takes off just that day. The same writes run for real on
 * the TEST database in worked-day.integration.test.ts.
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  jobs: [] as Row[],
  segments: [] as Row[],
  entries: [] as Row[],
  appts: [] as Row[],
  writes: [] as { table: string; op: string; patch?: Row }[],
  tz: "America/Los_Angeles",
}));

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "insert" | "delete" = "select";
  let patch: Row | null = null;
  let inserted: Row[] = [];
  let returning = false;
  let single = false;
  let orderBy: string | null = null;
  const rowsOf = (): Row[] =>
    table === "jobs" ? db.jobs : table === "job_schedule_segments" ? db.segments : table === "time_entries" ? db.entries : table === "appointments" ? db.appts : [];
  const run = () => {
    if (table === "organizations") return { data: single ? { settings: { timezone: db.tz, work_day_start: "09:00", work_day_end: "17:00" } } : [], error: null };
    if (table === "schedule_proposals") return { data: [], error: null };
    const all = rowsOf();
    const hit = all.filter((r) => filters.every((f) => f(r)));
    if (op === "insert") {
      db.writes.push({ table, op });
      for (const r of inserted) all.push({ id: `row-${all.length + 1}`, ...r });
      return { data: returning ? inserted : null, error: null };
    }
    if (op === "delete") {
      db.writes.push({ table, op });
      for (const r of hit) all.splice(all.indexOf(r), 1);
      return { data: null, error: null };
    }
    if (op === "update") {
      db.writes.push({ table, op, patch: patch! });
      for (const r of hit) Object.assign(r, patch);
      return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    const out = orderBy ? [...hit].sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!]))) : hit;
    const copy = out.map((r) => ({ ...r }));
    return { data: single ? (copy[0] ?? null) : copy, error: null };
  };
  const b: any = {
    select: () => ((returning = op !== "select"), b),
    insert: (r: Row | Row[]) => ((op = "insert"), (inserted = Array.isArray(r) ? r : [r]), b),
    update: (p: Row) => ((op = "update"), (patch = p), b),
    delete: () => ((op = "delete"), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
    lte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) <= v), b),
    lt: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) < v), b),
    gte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) >= v), b),
    order: (c: string) => ((orderBy = c), b),
    limit: () => b,
    maybeSingle: async () => ((single = true), run()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const client = { from: (t: string) => builder(t) };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client, userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => undefined) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn(async () => undefined) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { bookWorkedDay, unbookWorkedDay } = await import("./actions");
const { todayStrInTz, tzDateTimeUtc } = await import("@/lib/tz");
const { addDays } = await import("@/lib/come-back-days");

const LA = "America/Los_Angeles";
const today = () => todayStrInTz(LA);
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA) as string;
const days = () => db.segments.map((s) => `${s.start_date}..${s.end_date} ${s.start_time ? `${s.start_time}-${s.end_time}` : "usual"}`).sort();

beforeEach(() => {
  db.jobs = [];
  db.segments = [];
  db.entries = [];
  db.appts = [];
  db.writes = [];
});

describe("bookWorkedDay", () => {
  const worked = addDays(today(), -3);
  const planned = addDays(today(), 4);

  it("adds that one day at the hours worked; the listed day, the status and a hold never move", () => {
    const start = at(planned, "09:00");
    const end = at(planned, "11:00");
    db.jobs = [{ id: "j11", name: "22 Honeysuckle Way", job_number: "J-011", status: "on_hold", scheduled_start: start, scheduled_end: end, planned_minutes: 120 }];
    db.segments = [{ id: "s1", job_id: "j11", start_date: planned, end_date: planned, start_time: null, end_time: null }];
    db.entries = [
      { id: "e1", profile_id: "p-brian", job_id: "j11", clock_in: at(worked, "11:04"), clock_out: at(worked, "13:46") },
      { id: "e2", profile_id: "p-erik", job_id: "j11", clock_in: at(worked, "12:30"), clock_out: at(worked, "17:30") },
    ];
    return bookWorkedDay("j11", worked).then((res) => {
      expect(res).toMatchObject({ ok: true, added: true });
      expect(res.note).toMatch(/^Added .+ to 22 Honeysuckle Way · J-011's schedule\.$/);
      expect(days()).toEqual([`${planned}..${planned} usual`, `${worked}..${worked} 11:04-17:30`].sort());
      expect(db.jobs[0]).toMatchObject({ status: "on_hold", scheduled_start: start, scheduled_end: end, planned_minutes: 120 });
      // No status write rode along (promote: false).
      expect(db.writes.filter((w) => w.table === "jobs" && w.patch && "status" in w.patch)).toEqual([]);
    });
  });

  it("a dateless job stays dateless (and on the rail), its status kept", async () => {
    db.jobs = [{ id: "j9", name: "12 Elm St", job_number: "J-009", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null }];
    db.entries = [{ id: "e1", profile_id: "p-erik", job_id: "j9", clock_in: at(worked, "08:00"), clock_out: at(worked, "12:00") }];
    expect((await bookWorkedDay("j9", worked)).ok).toBe(true);
    expect(db.jobs[0]).toMatchObject({ status: "to_be_scheduled", scheduled_start: null, scheduled_end: null });
    expect(days()).toEqual([`${worked}..${worked} 08:00-12:00`]);
  });

  it("twice is once: a day already on the schedule is left as it is, with no Undo offered", async () => {
    db.jobs = [{ id: "j9", name: "12 Elm St", job_number: "J-009", status: "in_progress", scheduled_start: null, scheduled_end: null }];
    db.entries = [{ id: "e1", profile_id: "p-erik", job_id: "j9", clock_in: at(worked, "08:00"), clock_out: at(worked, "12:00") }];
    await bookWorkedDay("j9", worked);
    db.writes = [];
    const again = await bookWorkedDay("j9", worked);
    expect(again).toMatchObject({ ok: true, added: false });
    expect(db.writes).toEqual([]);
  });

  it("never a back-dating door: a day nobody clocked time on the job is refused, nothing written", async () => {
    db.jobs = [{ id: "j9", name: "12 Elm St", job_number: "J-009", status: "in_progress", scheduled_start: null, scheduled_end: null }];
    // Time on another job that day, and on this job the day before, doesn't count.
    db.entries = [
      { id: "e1", profile_id: "p-erik", job_id: "other", clock_in: at(worked, "08:00"), clock_out: at(worked, "12:00") },
      { id: "e2", profile_id: "p-erik", job_id: "j9", clock_in: at(addDays(worked, -1), "08:00"), clock_out: at(addDays(worked, -1), "12:00") },
    ];
    const res = await bookWorkedDay("j9", worked);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Nobody clocked time on 12 Elm St · J-009 on .+, so there's nothing to book\.$/);
    expect(db.writes).toEqual([]);
  });

  it("an overnight shift's tail books the day it ran into", async () => {
    db.jobs = [{ id: "j9", name: "12 Elm St", job_number: "J-009", status: "in_progress", scheduled_start: null, scheduled_end: null }];
    db.entries = [{ id: "e1", profile_id: "p-erik", job_id: "j9", clock_in: at(addDays(worked, -1), "22:00"), clock_out: at(worked, "06:30") }];
    expect((await bookWorkedDay("j9", worked)).ok).toBe(true);
    expect(days()).toEqual([`${worked}..${worked} 00:00-06:30`]);
  });

  it("only a day already past: today and later are refused", async () => {
    db.jobs = [{ id: "j9", name: "12 Elm St", job_number: "J-009", status: "in_progress", scheduled_start: null, scheduled_end: null }];
    expect((await bookWorkedDay("j9", today())).error).toBe("Only a day already past can be booked from the time worked on it.");
    expect((await bookWorkedDay("j9", "nope")).error).toBe("Pick a day.");
    expect(db.writes).toEqual([]);
  });
});

describe("unbookWorkedDay: the Undo takes off just that day", () => {
  it("splits a range the day sits in the middle of, and leaves every other day", async () => {
    const worked = addDays(today(), -3);
    db.jobs = [{ id: "j9", name: "12 Elm St", job_number: "J-009", status: "in_progress", scheduled_start: null, scheduled_end: null }];
    db.segments = [{ id: "s1", job_id: "j9", start_date: addDays(worked, -1), end_date: addDays(worked, 1), start_time: null, end_time: null }];
    db.entries = [{ id: "e1", profile_id: "p-erik", job_id: "j9", clock_in: at(worked, "08:00"), clock_out: at(worked, "12:00") }];
    const res = await unbookWorkedDay("j9", worked);
    expect(res.ok).toBe(true);
    expect(days()).toEqual([`${addDays(worked, -1)}..${addDays(worked, -1)} usual`, `${addDays(worked, 1)}..${addDays(worked, 1)} usual`]);
    expect(db.jobs[0]).toMatchObject({ status: "in_progress", scheduled_start: null });
  });

  it("book, then Undo, is where it started", async () => {
    const worked = addDays(today(), -2);
    db.jobs = [{ id: "j9", name: "12 Elm St", job_number: "J-009", status: "scheduled", scheduled_start: null, scheduled_end: null }];
    db.entries = [{ id: "e1", profile_id: "p-erik", job_id: "j9", clock_in: at(worked, "08:00"), clock_out: at(worked, "12:00") }];
    await bookWorkedDay("j9", worked);
    expect(db.segments).toHaveLength(1);
    await unbookWorkedDay("j9", worked);
    expect(db.segments).toEqual([]);
    expect(db.jobs[0].status).toBe("scheduled");
  });
});

describe("the office only, every time", () => {
  it("both writers ask requireStaff first", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/actions.ts"), "utf8");
    for (const fn of ["bookWorkedDay", "unbookWorkedDay", "undoPlaceJob"]) {
      const from = src.indexOf(`export async function ${fn}(`);
      expect(from, fn).toBeGreaterThan(-1);
      expect(src.slice(from, from + 400), fn).toContain("await requireStaff()");
    }
    // Never the forward-adding, hold-waking, status-promoting placers.
    const book = src.slice(src.indexOf("export async function bookWorkedDay("), src.indexOf("export async function unbookWorkedDay("));
    expect(book).not.toMatch(/placeJobOnDay\(|setJobScheduleRanges\(|placeOnDays\(/);
    expect(book).toContain("promote: false");
  });
});
