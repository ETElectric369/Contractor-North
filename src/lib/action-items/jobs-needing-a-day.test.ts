import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEEDS_A_DAY_STATUSES, WHY_MAX, companyDay, jobsNeedingADay, needDayWhy, type NeedDayJob } from "./jobs-needing-a-day";

/**
 * JOBS NEEDING A DAY: one question, "is anything ahead of this job?", in place of "to schedule" and
 * "nothing scheduled next". A job still being done needs a day when nothing is ahead of it: no day
 * today or later, no segment ending today or later, no visit booked, nobody on it now. No three-day
 * window. Its why line says what is behind it.
 */
const TODAY = "2026-09-27";
const TZ = "America/Los_Angeles";
let seq = 0;
const job = (o: Partial<NeedDayJob> = {}): NeedDayJob => ({ id: `j${++seq}`, job_number: `J-0${seq}`, name: `Job ${seq}`, status: "to_be_scheduled", ...o });
const ids = (jobs: NeedDayJob[], extra: Partial<Parameters<typeof jobsNeedingADay>[0]> = {}) =>
  jobsNeedingADay({ jobs, todayStr: TODAY, tz: TZ, ...extra }).map((f) => f.job.id);
const whyOf = (j: NeedDayJob, extra: Partial<Parameters<typeof jobsNeedingADay>[0]> = {}) =>
  jobsNeedingADay({ jobs: [j], todayStr: TODAY, tz: TZ, ...extra })[0]?.why;

describe("who needs a day", () => {
  it("a job still being done with nothing ahead of it, whatever its status among the three", () => {
    const a = job({ status: "to_be_scheduled" });
    const b = job({ status: "scheduled", scheduled_start: "2026-09-02T15:00:00Z" });
    const c = job({ status: "in_progress", time_entries: [{ clock_in: "2026-09-20T15:00:00Z" }] });
    expect(ids([a, b, c])).toEqual([a.id, b.id, c.id]);
    expect(NEEDS_A_DAY_STATUSES).toEqual(["to_be_scheduled", "scheduled", "in_progress"]);
  });

  it("never a job on hold (it waits with its own day), done or cancelled", () => {
    expect(ids([job({ status: "on_hold" }), job({ status: "complete" }), job({ status: "cancelled" })])).toEqual([]);
  });

  it("a day today or later is ahead of it: its start or its end, on the company's calendar", () => {
    expect(ids([job({ scheduled_start: "2026-09-28T15:00:00Z" })])).toEqual([]);
    expect(ids([job({ scheduled_start: "2026-09-20T15:00:00Z", scheduled_end: "2026-09-29T00:00:00Z" })])).toEqual([]);
    // 11 PM Pacific on the 26th is the 27th in UTC: still yesterday for the company.
    const lateYesterday = job({ scheduled_start: "2026-09-27T06:00:00Z" });
    expect(companyDay(lateYesterday.scheduled_start, TZ)).toBe("2026-09-26");
    expect(ids([lateYesterday])).toEqual([lateYesterday.id]);
    // 5 PM Pacific today is tomorrow in UTC, and it is today for the company: ahead of it.
    expect(ids([job({ scheduled_start: "2026-09-28T00:00:00Z" })])).toEqual([]);
  });

  it("a segment ending today or later is ahead of it; one that ended isn't", () => {
    expect(ids([job({ job_schedule_segments: [{ start_date: "2026-09-25", end_date: "2026-09-27" }] })])).toEqual([]);
    const ended = job({ job_schedule_segments: [{ start_date: "2026-09-20", end_date: "2026-09-22" }] });
    expect(ids([ended])).toEqual([ended.id]);
  });

  it("a visit booked today or later, or someone clocked in now, is ahead of it", () => {
    const j = job();
    expect(ids([j], { futureApptJobIds: new Set([j.id]) })).toEqual([]);
    expect(ids([j], { clockedInJobIds: new Set([j.id]) })).toEqual([]);
  });

  it("a job shown as Won is one line, not two", () => {
    const j = job();
    expect(ids([j], { wonJobIds: new Set([j.id]) })).toEqual([]);
  });

  it("no three-day window: worked a month ago with nothing ahead still needs a day", () => {
    const j = job({ status: "in_progress", time_entries: [{ clock_in: "2026-08-20T15:00:00Z" }] });
    expect(ids([j])).toEqual([j.id]);
  });
});

describe("the why line", () => {
  it("Never had a day", () => {
    expect(whyOf(job())).toBe("Never had a day");
  });

  it("Dated Sep 2, never worked", () => {
    expect(whyOf(job({ status: "scheduled", scheduled_start: "2026-09-02T15:00:00Z" }))).toBe("Dated Sep 2, never worked");
    // A segmented schedule that nobody worked reads from its first day.
    expect(whyOf(job({ job_schedule_segments: [{ start_date: "2026-09-10", end_date: "2026-09-12" }] }))).toBe("Dated Sep 10, never worked");
  });

  it("Worked Sep 25, with its open lines to buy riding along", () => {
    const j = job({ status: "in_progress", time_entries: [{ clock_in: "2026-09-25T15:00:00Z" }] });
    expect(whyOf(j)).toBe("Worked Sep 25");
    expect(whyOf(j, { toBuy: new Map([[j.id, 6]]) })).toBe("Worked Sep 25 · 6 to buy");
    expect(jobsNeedingADay({ jobs: [j], todayStr: TODAY, tz: TZ, toBuy: new Map([[j.id, 6]]) })[0].toBuy).toBe(6);
  });

  it("Quiet since Sep 11: worked, but not for over a week", () => {
    expect(whyOf(job({ status: "in_progress", time_entries: [{ clock_in: "2026-09-11T15:00:00Z" }] }))).toBe("Quiet since Sep 11");
  });

  it("Last day Jun 12: the schedule ran past the last day anyone worked it", () => {
    const j = job({
      status: "in_progress",
      job_schedule_segments: [{ start_date: "2026-06-08", end_date: "2026-06-12" }],
      time_entries: [{ clock_in: "2026-06-09T15:00:00Z" }],
    });
    expect(whyOf(j)).toBe("Last day Jun 12");
  });

  it("always at most 140 characters", () => {
    const long = needDayWhy({ lastWorked: "2026-09-25", firstDated: null, lastDated: null, todayStr: TODAY, toBuy: 9_999_999 });
    expect(long.length).toBeLessThanOrEqual(WHY_MAX);
  });

  it("carries the day it last had anything, for the pile's pips", () => {
    const worked = job({ time_entries: [{ clock_in: "2026-09-11T15:00:00Z" }], status: "in_progress" });
    const made = job({ created_at: "2026-09-01T15:00:00Z" });
    const [a, b] = jobsNeedingADay({ jobs: [worked, made], todayStr: TODAY, tz: TZ });
    expect(a.since).toBe("2026-09-11");
    expect(b.since).toBe("2026-09-01");
  });
});

describe("the build reads it", () => {
  const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");

  it("one jobs read replaces the dateless feeder and the three-day return detector", () => {
    expect(query).toContain("jobsNeedingADay({");
    expect(query).not.toContain("detectNeedsReturn(");
    expect(query).not.toContain('kind: "job_needs_return"');
    expect(query).not.toContain('.is("scheduled_start", null)');
    // The entries' own foreign key is named (time_entries also points at itself).
    expect(query).toContain("time_entries!time_entries_job_id_fkey(clock_in)");
  });

  it("a lost read never calls every job dateless: one Couldn't Check line instead", () => {
    expect(query).toContain("if (isStaff && (jobsR.error || futureApptR.error)) {");
    expect(query).toContain(`title: "Jobs Needing A Day · Couldn't Check"`);
    // And a lost costs read never invents No Costs Yet.
    expect(query).toContain("const costsReadable = ![previewListsR, wBillsR, wPosR, wInvR].some((r) => (r as Read)?.error);");
  });
});
