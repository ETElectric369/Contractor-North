import { describe, it, expect } from "vitest";
import { readDayBusy } from "./day-busy";
import { makeDayStandIn } from "./day-stand-in.test-support";
import { tzDateTimeUtc } from "@/lib/tz";

/**
 * WHAT FILLS A DAY, the one rule (cn-v1185), against a stand-in that honours every filter and select
 * list. The staff caller (planDayTimes) reads exactly as before; a caller with a company names it on
 * every read and a failed read throws.
 */
const LA = "America/Los_Angeles";
const D = "2026-09-28"; // a Monday, Pacific daylight time
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA)!;
const DAY = { dateISO: D, tz: LA, dayStartHm: "09:00", dayEndHm: "17:00" };

const job = (id: string, start: string | null, end: string | null, planned: number | null, status = "scheduled", org = "org-1") => ({
  id, org_id: org, status, scheduled_start: start, scheduled_end: end, planned_minutes: planned, name: "J-9xx Larkspur",
});
const visit = (id: string, start: string, end: string | null, extra: Record<string, unknown> = {}, org = "org-1") => ({
  id, org_id: org, starts_at: start, ends_at: end, type: "inspection", status: "scheduled", job_id: null, absorbed: false, title: "Sam Tillery", ...extra,
});

function theDay() {
  return {
    jobs: [
      job("jt", at(D, "13:00"), at(D, "14:30"), null), // timed: its real span
      job("js", at(D, "09:00"), at(D, "17:00"), 60), // sized, the closing stamp: its size from its start
      job("ju", at(D, "09:00"), at(D, "17:00"), null), // unsized all-day: elastic, never busy
      job("jh", at(D, "09:00"), at(D, "17:00"), null), // keeps its own hours today: 15:00–16:00
      job("jc", at(D, "10:00"), at(D, "12:00"), null, "complete"), // not scheduled / in progress
      job("jn", at("2026-09-30", "09:00"), at("2026-09-30", "11:00"), null), // another day
    ],
    job_schedule_segments: [
      { org_id: "org-1", job_id: "jh", start_date: D, end_date: D, start_time: "15:00", end_time: "16:00" },
    ],
    appointments: [
      visit("multi", at("2026-09-27", "10:00"), at("2026-09-29", "11:00")), // the middle day of a multi-day visit
      visit("noend", at(D, "11:00"), null), // no end: the hour it is drawn as
      visit("call", at(D, "10:00"), null, { type: "call" }),
      visit("gone", at(D, "10:00"), at(D, "11:00"), { status: "cancelled" }),
      visit("absorbed", at(D, "12:00"), at(D, "13:00"), { absorbed: true }),
      visit("yesterday", at("2026-09-27", "09:00"), at("2026-09-27", "10:00")),
    ],
  };
}

describe("readDayBusy: the same busy list planDayTimes always built", () => {
  it("a timed job, a sized untimed job, an unsized all-day job, own hours, a multi-day visit, a visit with no end, a call, a cancelled visit and an absorbed one", async () => {
    const { client } = makeDayStandIn(theDay());
    expect(await readDayBusy(client, DAY)).toEqual([
      { startMin: 13 * 60, endMin: 14 * 60 + 30 }, // jt
      { startMin: 9 * 60, endMin: 10 * 60 }, // js, its hour
      { startMin: 15 * 60, endMin: 16 * 60 }, // jh, its own hours
      { startMin: 0, endMin: 24 * 60 }, // the middle day of the multi-day visit
      { startMin: 11 * 60, endMin: 12 * 60 }, // the visit with no end
    ]);
  });

  it("the jobs being placed are never in their own way (their block, their visit)", async () => {
    const day = theDay();
    day.appointments.push(visit("ownv", at(D, "07:00"), at(D, "08:00"), { job_id: "jt" }));
    const { client } = makeDayStandIn(day);
    const busy = await readDayBusy(client, { ...DAY, ownJobIds: ["jt"] });
    expect(busy).not.toContainEqual({ startMin: 13 * 60, endMin: 14 * 60 + 30 });
    expect(busy).not.toContainEqual({ startMin: 7 * 60, endMin: 8 * 60 });
    expect(busy).toHaveLength(4);
  });

  it("the staff caller's reads are as they were: no company named, a failed read reads as nothing there", async () => {
    const { client, log } = makeDayStandIn(theDay(), { failOn: ["appointments"] });
    const busy = await readDayBusy(client, DAY);
    expect(busy).toHaveLength(3); // the jobs still count; the failed visits read is empty, as before
    expect(log.every((q) => !q.filters.some((f) => f.startsWith("org_id.")))).toBe(true);
    expect(log.find((q) => q.table === "appointments")!.filters.at(-1)).toBe("limit.200");
    expect(log.find((q) => q.table === "jobs")!.filters.at(-1)).toBe("limit.100");
  });
});

describe("readDayBusy with a company (the signed-out caller)", () => {
  it("every read names the company, and another company's visits and jobs never fill the day", async () => {
    const day = theDay();
    day.jobs.push(job("theirs", at(D, "09:00"), at(D, "12:00"), null, "scheduled", "org-2"));
    day.appointments.push(visit("theirv", at(D, "14:00"), at(D, "16:00"), {}, "org-2"));
    day.job_schedule_segments.push({ org_id: "org-2", job_id: "ju", start_date: D, end_date: D, start_time: "12:00", end_time: "13:00" });
    const { client, log } = makeDayStandIn(day);
    const busy = await readDayBusy(client, { ...DAY, orgId: "org-1" });
    expect(busy).toEqual(await readDayBusy(makeDayStandIn(theDay()).client, DAY));
    const reads = log.filter((q) => ["appointments", "jobs", "job_schedule_segments"].includes(q.table));
    expect(reads).toHaveLength(3);
    for (const q of reads) expect(q.filters).toContain("org_id.eq.org-1");
  });

  it.each(["appointments", "jobs", "job_schedule_segments"])("a failed %s read throws (never 'nothing is busy')", async (t) => {
    const { client } = makeDayStandIn(theDay(), { failOn: [t] });
    await expect(readDayBusy(client, { ...DAY, orgId: "org-1" })).rejects.toThrow(/read failed/);
  });
});
