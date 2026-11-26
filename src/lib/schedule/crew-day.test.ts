import { describe, it, expect } from "vitest";
import { crewDayFrom, readCrewDay, type CrewDayJobRow, type CrewDayRow, type CrewDayVisitRow } from "./crew-day";
import type { SegmentRow } from "./segment-hours";

/**
 * ONE COMPANY'S DAY (cn-v1192), rows in, blocks out. Thursday 2001-01-04 in Pacific (PST, UTC-8): the
 * company's midnight is 08:00 UTC. Larkspur, Snowbell and the J-9xx jobs, Sam Tillery and Dana Rook
 * are stand-ins.
 */
const TZ = "America/Los_Angeles";
const DAY = "2001-01-04";
const WORK_DAY = { start: "08:00", end: "17:00" };
const utc = (hm: string, day = DAY) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.parse(`${day}T08:00:00.000Z`) + (h * 60 + m) * 60_000).toISOString();
};
const ms = (hm: string) => Date.parse(utc(hm));

// J-901 Larkspur: segments today with its own hours 1 PM to 7:30 PM. J-902 Snowbell: no segments, its
// span is today 9 to 5. J-903: a span over today, but its ranges are yesterday and tomorrow (a gap day).
// J-904: span next week, used only by a day row.
const JOBS: CrewDayJobRow[] = [
  { id: "j-901", scheduled_start: utc("08:00"), scheduled_end: utc("17:00"), assigned_to: ["sam"] },
  { id: "j-902", scheduled_start: utc("09:00"), scheduled_end: utc("17:00"), assigned_to: ["sam", "dana", "rook-2"] },
  { id: "j-903", scheduled_start: utc("08:00", "2001-01-03"), scheduled_end: utc("17:00", "2001-01-05"), assigned_to: ["gap-1"] },
  { id: "j-904", scheduled_start: utc("08:00", "2001-01-11"), scheduled_end: utc("17:00", "2001-01-11"), assigned_to: [] },
];
const SEGS: SegmentRow[] = [
  { job_id: "j-901", start_date: DAY, end_date: DAY, start_time: "13:00", end_time: "19:30" },
  { job_id: "j-903", start_date: "2001-01-03", end_date: "2001-01-03" },
  { job_id: "j-903", start_date: "2001-01-05", end_date: "2001-01-05" },
];
const day = (dayRows: CrewDayRow[] = [], visits: CrewDayVisitRow[] = []) =>
  crewDayFrom({ day: DAY, tz: TZ, workDay: WORK_DAY, jobs: JOBS, segments: SEGS, dayRows, visits });

describe("crewDayFrom: the jobs on the day, with their hours", () => {
  it("segments first with a day's own hours; a span for a job with none; a gap day is not a day", () => {
    const d = day();
    expect([...d.jobs.keys()].sort()).toEqual(["j-901", "j-902"]);
    expect(d.jobs.get("j-901")).toMatchObject({ startMin: 13 * 60, endMin: 19 * 60 + 30, startMs: ms("13:00"), endMs: ms("19:30") });
    expect(d.jobs.get("j-902")).toMatchObject({ startMin: 9 * 60, endMin: 17 * 60 });
  });
});

describe("crewDayFrom: who is scheduled, and their first start", () => {
  it("the roster: every job on the day whose crew holds the person; the first start is the earliest", () => {
    const d = day();
    expect(d.people.get("sam")?.blocks.map((b) => b.id)).toEqual(["j-902", "j-901"]);
    expect(d.people.get("sam")?.firstStartMs).toBe(ms("09:00"));
    expect(d.people.get("gap-1")).toBeUndefined();
  });

  it("an off day row: not scheduled at all, whatever the roster and the visits say", () => {
    const d = day([{ profile_id: "dana", job_id: null, kind: "off" }], [{ id: "a-1", assigned_to: "dana", starts_at: utc("07:00"), ends_at: null, status: "scheduled" }]);
    expect(d.people.get("dana")).toMatchObject({ off: true, blocks: [], firstStartMs: null });
  });

  it("a job day row overrides the roster: that job alone (its hours today)", () => {
    const d = day([{ profile_id: "sam", job_id: "j-901", kind: "job" }]);
    expect(d.people.get("sam")?.blocks.map((b) => b.id)).toEqual(["j-901"]);
    expect(d.people.get("sam")?.firstStartMs).toBe(ms("13:00"));
  });

  it("a day row on a job that is not on today's plan is the company's work day; one on a job no longer in flight falls through", () => {
    expect(day([{ profile_id: "dana", job_id: "j-904", kind: "job" }]).people.get("dana")?.firstStartMs).toBe(ms("08:00"));
    // j-999 is not among the in-flight jobs read: the roster decides (j-902 at 9).
    expect(day([{ profile_id: "dana", job_id: "j-999", kind: "job" }]).people.get("dana")?.firstStartMs).toBe(ms("09:00"));
  });

  it("a job ON HOLD schedules nobody by its stale span: Sam on its crew gets no block; its hours stay among the day's jobs", () => {
    const held: CrewDayJobRow = { id: "j-903", status: "on_hold", scheduled_start: utc("08:00"), scheduled_end: utc("17:00"), assigned_to: ["sam"] };
    const d = crewDayFrom({ day: DAY, tz: TZ, workDay: WORK_DAY, jobs: [held], segments: [], dayRows: [], visits: [] });
    expect(d.jobs.has("j-903")).toBe(true);
    expect(d.people.get("sam")).toBeUndefined();
    // A day row naming the held job is still the person's own pick for the day.
    const picked = crewDayFrom({ day: DAY, tz: TZ, workDay: WORK_DAY, jobs: [held], segments: [], dayRows: [{ profile_id: "sam", job_id: "j-903", kind: "job" }], visits: [] });
    expect(picked.people.get("sam")?.firstStartMs).toBe(ms("08:00"));
  });

  it("a visit on the person's name counts, an hour when it has no end; cancelled, completed, absorbed, a call, another day: not", () => {
    const visits: CrewDayVisitRow[] = [
      { id: "a-ok", assigned_to: "rook-2", starts_at: utc("07:30"), ends_at: null, type: "inspection", status: "scheduled" },
      { id: "a-x1", assigned_to: "rook-2", starts_at: utc("06:00"), ends_at: null, status: "cancelled" },
      { id: "a-x2", assigned_to: "rook-2", starts_at: utc("06:00"), ends_at: null, status: "completed" },
      { id: "a-x3", assigned_to: "rook-2", starts_at: utc("06:00"), ends_at: null, status: "scheduled", absorbed: true },
      { id: "a-x4", assigned_to: "rook-2", starts_at: utc("06:00"), ends_at: null, status: "scheduled", type: "call" },
      { id: "a-x5", assigned_to: "rook-2", starts_at: utc("06:00", "2001-01-03"), ends_at: utc("09:00"), status: "scheduled" },
      { id: "a-solo", assigned_to: "visit-only", starts_at: utc("10:00"), ends_at: utc("11:30"), status: "scheduled" },
    ];
    const d = day([], visits);
    expect(d.people.get("rook-2")?.blocks.map((b) => b.id)).toEqual(["a-ok", "j-902"]);
    expect(d.people.get("rook-2")?.firstStartMs).toBe(ms("07:30"));
    expect(d.people.get("rook-2")?.blocks[0].endMs).toBe(ms("08:30"));
    expect(d.people.get("visit-only")).toMatchObject({ off: false, firstStartMs: ms("10:00") });
  });
});

describe("readCrewDay: every read names the company, and a failed read throws", () => {
  type Q = { table: string; filters: unknown[][] };
  const client = (fail?: string | ((q: Q) => boolean), seen: Q[] = []) => ({
    from(table: string) {
      const q: Q = { table, filters: [] };
      seen.push(q);
      const chain: any = {
        select: () => chain,
        then(res: any) {
          if (typeof fail === "function" ? fail(q) : fail === table) return res({ data: null, error: { message: "boom" } });
          const rows = table === "jobs" ? JOBS : table === "job_schedule_segments" ? SEGS : [];
          res({ data: rows, error: null });
        },
      };
      for (const m of ["eq", "in", "lt", "lte", "gte", "or", "not"]) chain[m] = (...a: unknown[]) => (q.filters.push([m, ...a]), chain);
      return chain;
    },
  });

  it("names the company on every read", async () => {
    const seen: Q[] = [];
    const d = await readCrewDay(client(undefined, seen), { orgId: "org-larkspur", tz: TZ, workDay: WORK_DAY, day: DAY });
    expect(d.jobs.has("j-901")).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const q of seen) expect(q.filters, q.table).toContainEqual(["eq", "org_id", "org-larkspur"]);
  });

  it.each(["jobs", "job_schedule_segments", "crew_day_assignments", "appointments"])("a failed %s read throws, never an empty day", async (table) => {
    await expect(readCrewDay(client(table), { orgId: "org-larkspur", tz: TZ, workDay: WORK_DAY, day: DAY })).rejects.toThrow(/read failed: boom/);
  });

  it("a failed read of every range of the jobs read (the segments-first rule's input) throws too", async () => {
    const allRanges = (q: Q) => q.table === "job_schedule_segments" && q.filters.some((f) => f[0] === "in" && f[1] === "job_id");
    await expect(readCrewDay(client(allRanges), { orgId: "org-larkspur", tz: TZ, workDay: WORK_DAY, day: DAY })).rejects.toThrow(/job days read failed: boom/);
  });
});
