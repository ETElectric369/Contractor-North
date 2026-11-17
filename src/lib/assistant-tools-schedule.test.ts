import { describe, it, expect } from "vitest";
import { runDataTool } from "@/lib/assistant-tools";

/**
 * WHAT NORT READS ABOUT A DAY IS WHAT THE CALENDAR DRAWS (cn-v1165).
 *
 * 2026-11-16: the owner booked tomorrow by voice, Nort made visits of type Job, gave no job a day and
 * said the jobs were scheduled with the crew. schedule_overview could not have shown him otherwise: it
 * listed a job only on the day its scheduled_start fell in the window, with no hours of a day and no
 * crew. These run the tools against a stand-in database that answers by table and applies the filters
 * the tools send (eq, in, gte, lte, lt, and the jobs' overlap `or`), so the reads themselves are
 * exercised, not their source. The company is the default one: America/Los_Angeles, 08:00 to 17:00.
 */

type Row = Record<string, any>;

const isInstant = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s);
function cmp(a: unknown, b: unknown): number | null {
  if (a == null || b == null) return null;
  if (isInstant(a) && isInstant(b)) return Date.parse(a as string) - Date.parse(b as string);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function fakeDb(tables: Record<string, Row[]>) {
  const reads: { table: string; filters: string[] }[] = [];
  return {
    reads,
    from(table: string) {
      const preds: ((r: Row) => boolean)[] = [];
      const filters: string[] = [];
      reads.push({ table, filters });
      const rows = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      const q: any = {
        select: () => q,
        order: () => q,
        limit: () => q,
        neq: () => q,
        not: () => q,
        is: () => q,
        eq(col: string, v: unknown) {
          filters.push(`eq:${col}`);
          preds.push((r) => r[col] === v);
          return q;
        },
        in(col: string, vs: unknown[]) {
          filters.push(`in:${col}`);
          preds.push((r) => vs.includes(r[col]));
          return q;
        },
        gte(col: string, v: unknown) {
          preds.push((r) => (cmp(r[col], v) ?? -1) >= 0);
          return q;
        },
        lte(col: string, v: unknown) {
          preds.push((r) => (cmp(r[col], v) ?? 1) <= 0);
          return q;
        },
        lt(col: string, v: unknown) {
          preds.push((r) => (cmp(r[col], v) ?? 1) < 0);
          return q;
        },
        or(expr: string) {
          // Only the jobs' overlap test is sent through here.
          const m = /^scheduled_end\.gte\.([^,]+),and\(scheduled_end\.is\.null,scheduled_start\.gte\.([^)]+)\)$/.exec(expr);
          if (!m) throw new Error(`unexpected or(): ${expr}`);
          preds.push((r) => (r.scheduled_end != null ? (cmp(r.scheduled_end, m[1]) ?? -1) >= 0 : (cmp(r.scheduled_start, m[2]) ?? -1) >= 0));
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: any, err: any) => Promise.resolve({ data: rows(), error: null }).then(ok, err),
      };
      return q;
    },
  };
}

const P1 = "00000000-0000-0000-0000-0000000000a1";
const P2 = "00000000-0000-0000-0000-0000000000a2";
const P3 = "00000000-0000-0000-0000-0000000000a3";
const profiles = [
  { id: P1, full_name: "Dana Rook" },
  { id: P2, full_name: "Theo Vance" },
  { id: P3, full_name: "Casey Loam" },
];

/** Started Sat Nov 14 at 8 AM Pacific, runs through Tue Nov 17 at 5 PM, no ranges of its own. */
const longJob = {
  id: "job-long",
  job_number: "J-101",
  name: "Larkspur panel swap",
  status: "in_progress",
  scheduled_start: "2026-11-14T16:00:00Z",
  scheduled_end: "2026-11-18T01:00:00Z",
  planned_minutes: null,
  assigned_to: [P1, P2, P3],
  customers: { name: "Sam Tillery" },
};
/** Two ranges, Nov 17 at its own 7 to 11, Nov 19 at the job's usual 9 to 11; its listed span covers
 *  Nov 18 too, and it is NOT on Nov 18 (segments first). */
const splitJob = {
  id: "job-split",
  job_number: "J-102",
  name: "Snowbell rewire",
  status: "scheduled",
  scheduled_start: "2026-11-17T17:00:00Z",
  scheduled_end: "2026-11-19T19:00:00Z",
  planned_minutes: 120,
  assigned_to: [],
  customers: { name: "Casey Loam" },
};
/** Says Scheduled, has no day: under Waiting for a Day. */
const noDayJob = {
  id: "job-noday",
  job_number: "J-103",
  name: "Bayberry deck lights",
  status: "scheduled",
  scheduled_start: null,
  scheduled_end: null,
  planned_minutes: null,
  assigned_to: [P1],
  customers: { name: "Theo Vance" },
};
/** Its date was cleared; a worked day on Nov 17 is kept as a range (history): drawn all day. */
const historyJob = {
  id: "job-history",
  job_number: "J-104",
  name: "Larkspur service call",
  status: "to_be_scheduled",
  scheduled_start: null,
  scheduled_end: null,
  planned_minutes: null,
  assigned_to: [P2],
  customers: { name: "Dana Rook" },
};
const segments = [
  { job_id: "job-split", start_date: "2026-11-17", end_date: "2026-11-17", start_time: "07:00:00", end_time: "11:00:00" },
  { job_id: "job-split", start_date: "2026-11-19", end_date: "2026-11-19", start_time: null, end_time: null },
  { job_id: "job-history", start_date: "2026-11-17", end_date: "2026-11-17", start_time: null, end_time: null },
];
/** A visit of type job attached to the long job: a visit, never the job's day. */
const jobVisit = {
  id: "visit-job",
  title: null,
  type: "job",
  starts_at: "2026-11-17T18:00:00Z",
  ends_at: "2026-11-17T20:00:00Z",
  location: null,
  status: "scheduled",
  absorbed: false,
  customers: { name: "Sam Tillery" },
  jobs: { name: "Larkspur panel swap" },
};

function db() {
  return fakeDb({
    jobs: [longJob, splitJob, noDayJob, historyJob],
    job_schedule_segments: segments,
    appointments: [jobVisit],
    tasks: [],
    profiles,
    organizations: [],
  });
}

async function overview(date: string, d = db()) {
  return JSON.parse(await runDataTool("schedule_overview", { date }, d));
}

describe("schedule_overview: the jobs are the jobs' own days, as the calendar draws them", () => {
  it("a job that started before the window is on its later day, at its hours, with its crew", async () => {
    const out = await overview("2026-11-17");
    const row = out.jobs.find((j: any) => j.id === "job-long");
    expect(row).toMatchObject({
      kind: "job_day",
      job: "J-101",
      name: "Larkspur panel swap",
      status: "in_progress",
      customer: "Sam Tillery",
      day: "2026-11-17",
      start: "08:00",
      end: "17:00",
      all_day: true,
      own_hours: false,
      crew: ["Dana Rook", "Theo Vance", "Casey Loam"],
    });
    // The same moments as instants: 8 AM and 5 PM Pacific (UTC-8 in November).
    expect(row.starts_at).toBe("2026-11-17T16:00:00.000Z");
    expect(row.ends_at).toBe("2026-11-18T01:00:00.000Z");
    expect(out.timezone).toBe("America/Los_Angeles");
  });

  it("the old fields still come back on a job row (job, name, status, customer, the listed span)", async () => {
    const out = await overview("2026-11-17");
    const row = out.jobs.find((j: any) => j.id === "job-long");
    expect(row.scheduled_start).toBe(longJob.scheduled_start);
    expect(row.scheduled_end).toBe(longJob.scheduled_end);
    expect(Object.keys(row)).toEqual(expect.arrayContaining(["job", "name", "status", "customer", "scheduled_start", "scheduled_end"]));
    expect(out.window).toBe("2026-11-17");
  });

  it("a job with two ranges is on both days, each at that day's hours, and not on the day between", async () => {
    const d17 = (await overview("2026-11-17")).jobs.find((j: any) => j.id === "job-split");
    expect(d17).toMatchObject({ day: "2026-11-17", start: "07:00", end: "11:00", own_hours: true, all_day: false, crew: [] });
    const d19 = (await overview("2026-11-19")).jobs.find((j: any) => j.id === "job-split");
    expect(d19).toMatchObject({ day: "2026-11-19", start: "09:00", end: "11:00", own_hours: false, all_day: false });
    // Its listed span covers the 18th; its ranges do not, and the calendar draws ranges first.
    const d18 = await overview("2026-11-18");
    expect(d18.jobs.find((j: any) => j.id === "job-split")).toBeUndefined();
  });

  it("over a week, one row per job per day, in day order", async () => {
    const out = JSON.parse(await runDataTool("schedule_overview", { around: "2026-11-17" }, db()));
    const days = (id: string) => out.jobs.filter((j: any) => j.id === id).map((j: any) => j.day);
    expect(days("job-long")).toEqual(["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"]);
    expect(days("job-split")).toEqual(["2026-11-17", "2026-11-19"]);
    const all = out.jobs.map((j: any) => j.day);
    expect(all).toEqual([...all].sort());
  });

  it("a job whose date was cleared but kept a worked day is on that day, read by id", async () => {
    const d = db();
    const out = await overview("2026-11-17", d);
    expect(out.jobs.find((j: any) => j.id === "job-history")).toMatchObject({ day: "2026-11-17", all_day: true, crew: ["Theo Vance"] });
    expect(d.reads.some((r) => r.table === "jobs" && r.filters.includes("in:id"))).toBe(true);
  });

  it("a job that says Scheduled with no day has no job day", async () => {
    const out = await overview("2026-11-17");
    expect(out.jobs.find((j: any) => j.id === "job-noday")).toBeUndefined();
  });

  it("a visit of type job is a visit, and never a job day", async () => {
    const out = await overview("2026-11-17");
    expect(out.appointments).toHaveLength(1);
    expect(out.appointments[0]).toMatchObject({ kind: "visit", id: "visit-job", type: "Job", job: "Larkspur panel swap" });
    expect(out.jobs.every((j: any) => j.kind === "job_day")).toBe(true);
    expect(out.jobs.filter((j: any) => j.id === "job-long")).toHaveLength(1);
    expect(out.lists_cut).toBeUndefined();
  });

  it("names the crew as null, and says so, when the names cannot be read", async () => {
    const d = db();
    const from = d.from.bind(d);
    (d as any).from = (table: string) => {
      if (table !== "profiles") return from(table);
      const q: any = { select: () => q, in: () => q, limit: () => q, then: (ok: any) => Promise.resolve({ data: null, error: { message: "down" } }).then(ok) };
      return q;
    };
    const out = await overview("2026-11-17", d);
    expect(out.jobs.find((j: any) => j.id === "job-long").crew).toBeNull();
    expect(out.lists_cut.join(" ")).toMatch(/crew/);
  });
});

describe("schedule_overview at the edge, and beside the read-back", () => {
  it("a block that runs to midnight says 23:59 in end and in ends_at: the same moment", async () => {
    const late = { ...longJob, id: "job-late", job_number: "J-105", scheduled_start: "2026-11-18T06:00:00Z", scheduled_end: null, planned_minutes: 240, assigned_to: [] };
    const d = fakeDb({ jobs: [late], job_schedule_segments: [], appointments: [], tasks: [], profiles, organizations: [] });
    const row = (await overview("2026-11-17", d)).jobs.find((j: any) => j.id === "job-late");
    expect(row).toMatchObject({ day: "2026-11-17", start: "22:00", end: "23:59" });
    expect(row.starts_at).toBe("2026-11-18T06:00:00.000Z");
    // 23:59 Pacific on the 17th, never the next midnight.
    expect(row.ends_at).toBe("2026-11-18T07:59:00.000Z");
  });

  it("the tool and readJobDay say the same day for every job and day", async () => {
    const { readJobDay } = await import("@/lib/schedule/job-day-read");
    for (const day of ["2026-11-17", "2026-11-18", "2026-11-19"]) {
      const out = await overview(day);
      for (const id of ["job-long", "job-split", "job-noday", "job-history"]) {
        const row = out.jobs.find((j: any) => j.id === id);
        const back = await readJobDay(db(), id, day);
        expect(back.ok).toBe(true);
        if (!back.ok) continue;
        if (!row) expect(back.block).toBeNull();
        else expect(back.block).toEqual({ day: row.day, start: row.start, end: row.end, all_day: row.all_day, own_hours: row.own_hours });
      }
    }
  });
});

describe("list_jobs and get_job: has_day and the crew", () => {
  it("list_jobs says a Scheduled job with no day has no day, and names its crew", async () => {
    const out = JSON.parse(await runDataTool("list_jobs", {}, db()));
    const byId = Object.fromEntries(out.jobs.map((j: any) => [j.id, j]));
    expect(byId["job-noday"]).toMatchObject({ status: "scheduled", has_day: false, crew: ["Dana Rook"] });
    expect(byId["job-long"]).toMatchObject({ has_day: true, crew: ["Dana Rook", "Theo Vance", "Casey Loam"] });
    expect(byId["job-split"].crew).toEqual([]);
    // The old fields.
    expect(byId["job-long"]).toMatchObject({ job: "J-101", name: "Larkspur panel swap", scheduled_start: longJob.scheduled_start, scheduled_end: longJob.scheduled_end });
  });

  it("get_job returns its planned days with each range's own hours, and its usual hours", async () => {
    const out = JSON.parse(await runDataTool("get_job", { job_id: "job-split" }, db()));
    expect(out).toMatchObject({ found: true, has_day: true, crew: [], timezone: "America/Los_Angeles" });
    expect(out.planned_days).toEqual([
      { from: "2026-11-17", to: "2026-11-17", start: "07:00", end: "11:00" },
      { from: "2026-11-19", to: "2026-11-19", start: null, end: null },
    ]);
    expect(out.usual_hours).toEqual({ start: "09:00", end: "11:00", all_day: false });
  });

  it("get_job: a job with no ranges is its listed span on the company's days; one with no day has none", async () => {
    const long = JSON.parse(await runDataTool("get_job", { job_id: "job-long" }, db()));
    expect(long.planned_days).toEqual([{ from: "2026-11-14", to: "2026-11-17", start: null, end: null }]);
    expect(long.usual_hours).toEqual({ start: "08:00", end: "17:00", all_day: true });
    const none = JSON.parse(await runDataTool("get_job", { job_id: "job-noday" }, db()));
    expect(none).toMatchObject({ has_day: false, planned_days: [], usual_hours: null, crew: ["Dana Rook"], status: "scheduled" });
  });
});
