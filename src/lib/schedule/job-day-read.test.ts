import { describe, it, expect } from "vitest";
import { blockEndMin, endAfterStart, jobDaysInWindow, readJobDay, toJobDayBlock } from "./job-day-read";

/**
 * ONE READ-BACK FOR A JOB'S DAY (cn-v1165, 2026-11-16). job.scheduleDay says what is STORED on a day
 * after it changes one, by the rule schedule_overview reads with (bookedKeys for the day, jobDayBlock
 * for its hours, the grid's end-after-start guard). These run readJobDay on a stand-in database that
 * answers by table and applies eq. The company is the default: America/Los_Angeles, 08:00 to 17:00.
 */

type Row = Record<string, any>;

function fakeDb(tables: Record<string, Row[]>, fail: Record<string, string> = {}) {
  return {
    from(table: string) {
      const preds: ((r: Row) => boolean)[] = [];
      const answer = () =>
        fail[table] ? { data: null, error: { message: fail[table] } } : { data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null };
      const q: any = {
        select: () => q,
        order: () => q,
        limit: () => q,
        eq(col: string, v: unknown) {
          preds.push((r) => r[col] === v);
          return q;
        },
        maybeSingle: async () => {
          const a = answer();
          return { data: a.data ? (a.data[0] ?? null) : null, error: a.error };
        },
        then: (ok: any, err: any) => Promise.resolve(answer()).then(ok, err),
      };
      return q;
    },
  };
}

/** Its usual hours 9 to 11 (Pacific, UTC-8 in November), on the 17th at its own 7 to 11, on the 19th
 *  at its usual hours, and not on the 18th; on the 20th, 8 PM to the last minute. */
const job = { id: "job-1", scheduled_start: "2026-11-17T17:00:00Z", scheduled_end: "2026-11-20T19:00:00Z", planned_minutes: 120 };
const segments = [
  { job_id: "job-1", start_date: "2026-11-17", end_date: "2026-11-17", start_time: "07:00:00", end_time: "11:00:00" },
  { job_id: "job-1", start_date: "2026-11-19", end_date: "2026-11-19", start_time: null, end_time: null },
  { job_id: "job-1", start_date: "2026-11-20", end_date: "2026-11-20", start_time: "20:00:00", end_time: "23:59:00" },
  { job_id: "job-other", start_date: "2026-11-18", end_date: "2026-11-18", start_time: null, end_time: null },
];
const db = (fail: Record<string, string> = {}) => fakeDb({ jobs: [job], job_schedule_segments: segments, organizations: [] }, fail);

describe("readJobDay: what is stored for one job on one day", () => {
  it("a day with its own hours", async () => {
    expect(await readJobDay(db(), "job-1", "2026-11-17")).toEqual({
      ok: true,
      block: { day: "2026-11-17", start: "07:00", end: "11:00", all_day: false, own_hours: true },
    });
  });

  it("a day at the job's usual hours", async () => {
    expect(await readJobDay(db(), "job-1", "2026-11-19")).toEqual({
      ok: true,
      block: { day: "2026-11-19", start: "09:00", end: "11:00", all_day: false, own_hours: false },
    });
  });

  it("a day the job is not on is null, even inside its listed span (its ranges come first)", async () => {
    expect(await readJobDay(db(), "job-1", "2026-11-18")).toEqual({ ok: true, block: null });
  });

  it("a day whose stored end was clamped at 23:59 says 23:59", async () => {
    expect(await readJobDay(db(), "job-1", "2026-11-20")).toEqual({
      ok: true,
      block: { day: "2026-11-20", start: "20:00", end: "23:59", all_day: false, own_hours: true },
    });
  });

  it("a failed read is said, never thrown and never a day off", async () => {
    const segs = await readJobDay(db({ job_schedule_segments: "boom" }), "job-1", "2026-11-17");
    expect(segs.ok).toBe(false);
    if (!segs.ok) expect(segs.error).toMatch(/boom/);
    const jobs = await readJobDay(db({ jobs: "down" }), "job-1", "2026-11-17");
    expect(jobs.ok).toBe(false);
    const missing = await readJobDay(db(), "job-none", "2026-11-17");
    expect(missing).toEqual({ ok: false, error: "Job not found." });
    const thrown = await readJobDay({ from: () => { throw new Error("no client"); } }, "job-1", "2026-11-17");
    expect(thrown.ok).toBe(false);
    expect((await readJobDay(db(), "job-1", "Nov 17")).ok).toBe(false);
  });
});

describe("the grid's guard and the said end", () => {
  it("an end not after its start is an hour from the start (the twin of the calendar's jobBlockOn)", () => {
    expect(endAfterStart(600, 600)).toBe(660);
    expect(endAfterStart(600, 540)).toBe(660);
    expect(endAfterStart(600, 720)).toBe(720);
    // jobDayBlock itself never hands back such a block today; the guard is there so a reader can never
    // say a length the grid would not draw.
  });

  it("a block that runs to midnight is said as 23:59, and the order keeps the real end", () => {
    expect(blockEndMin(24 * 60)).toBe(23 * 60 + 59);
    const [d] = jobDaysInWindow({
      jobs: [{ id: "late", scheduled_start: "2026-11-18T06:00:00Z", scheduled_end: null, planned_minutes: 240 }],
      segments: [],
      firstDay: "2026-11-17",
      lastDay: "2026-11-17",
      tz: "America/Los_Angeles",
      workDay: { start: "08:00", end: "17:00" },
    });
    expect(d).toMatchObject({ day: "2026-11-17", startMin: 22 * 60, endMin: 24 * 60 });
    expect(toJobDayBlock(d)).toMatchObject({ start: "22:00", end: "23:59" });
  });
});
