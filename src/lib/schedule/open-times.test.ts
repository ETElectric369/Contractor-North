import { describe, it, expect } from "vitest";
import {
  inspectionDaysFrom,
  INSPECTION_SLOT_MIN,
  OFFER_FIRST_DAY_OFFSET,
  OFFER_LOOKAHEAD_DAYS,
  OFFER_MAX_DAYS,
  OFFER_PER_DAY,
  offersOpenTimes,
  openInspectionTimes,
  openStartsInWindow,
  openTimeLabel,
  openTimesOnDay,
} from "./open-times";
import { makeDayStandIn } from "./day-stand-in.test-support";
import { getOrgSettings } from "@/lib/org-settings";
import { tzDateTimeUtc } from "@/lib/tz";

/**
 * OPEN INSPECTION TIMES (cn-v1185): the grid of 90-minute starts on a company's inspection days, by
 * the schedule's own rule for what fills a day, against a stand-in that honours every filter.
 */
const LA = "America/Los_Angeles";
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA)!;
const NOW = new Date("2026-11-22T20:00:00Z"); // Sunday Nov 22, noon in the company's timezone
const settings = (days: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  getOrgSettings({
    timezone: LA,
    work_day_start: "08:00",
    work_day_end: "17:00",
    inspection_days: { offer: true, days: ["tue", "thu"], start: "09:00", end: "15:00", per_day: 3, ...days },
    ...extra,
  });
const job = (id: string, start: string, end: string, org = "org-1") => ({
  id, org_id: org, status: "scheduled", scheduled_start: start, scheduled_end: end, planned_minutes: null,
});
const visit = (id: string, start: string, end: string | null, extra: Record<string, unknown> = {}, org = "org-1") => ({
  id, org_id: org, starts_at: start, ends_at: end, type: "inspection", status: "scheduled", job_id: null, absorbed: false, ...extra,
});
const db = (t: { jobs?: unknown[]; appointments?: unknown[] } = {}) =>
  makeDayStandIn({ jobs: (t.jobs ?? []) as never, appointments: (t.appointments ?? []) as never, job_schedule_segments: [] });
const hms = (ts: { ymd: string; hm: string }[]) => ts.map((t) => `${t.ymd} ${t.hm}`);

describe("the numbers", () => {
  it("are the contract's", () => {
    expect([INSPECTION_SLOT_MIN, OFFER_FIRST_DAY_OFFSET, OFFER_LOOKAHEAD_DAYS, OFFER_MAX_DAYS, OFFER_PER_DAY]).toEqual([90, 2, 6, 3, 2]);
  });
});

describe("openStartsInWindow (pure)", () => {
  const W = { startMin: 9 * 60, endMin: 15 * 60, slotMin: 90 };
  it("09:00–15:00 gives 09:00, 10:30, 12:00, 13:30; a window shorter than 90 minutes gives none", () => {
    expect(openStartsInWindow([], W)).toEqual([540, 630, 720, 810]);
    expect(openStartsInWindow([], { startMin: 540, endMin: 620, slotMin: 90 })).toEqual([]);
    expect(openStartsInWindow([], { startMin: 600, endMin: 540, slotMin: 90 })).toEqual([]);
  });
  it("a busy block removes exactly the starts it overlaps; touching is not overlapping", () => {
    expect(openStartsInWindow([{ startMin: 600, endMin: 660 }], W)).toEqual([720, 810]);
    expect(openStartsInWindow([{ startMin: 450, endMin: 540 }, { startMin: 900, endMin: 960 }], W)).toEqual([540, 630, 720, 810]);
    expect(openStartsInWindow([{ startMin: 0, endMin: 1440 }], W)).toEqual([]);
  });
});

describe("inspectionDaysFrom (pure)", () => {
  it("the next six ticked days, from today + 2: today and tomorrow are never offered", () => {
    expect(inspectionDaysFrom("2026-11-22", ["tue", "thu"])).toEqual(["2026-11-24", "2026-11-26", "2026-12-01", "2026-12-03", "2026-12-08", "2026-12-10"]);
    expect(inspectionDaysFrom("2026-11-22", ["sun", "mon"], { count: 3 })).toEqual(["2026-11-29", "2026-11-30", "2026-12-06"]);
    expect(inspectionDaysFrom("2026-11-22", [])).toEqual([]);
  });
});

describe("openTimeLabel (pure)", () => {
  it("reads like a person says it, from ymd + hm only", () => {
    expect(openTimeLabel({ ymd: "2026-11-24", hm: "09:00" })).toBe("Tue, Nov 24 · 9:00 AM");
    expect(openTimeLabel({ ymd: "2026-11-24", hm: "13:30" })).toBe("Tue, Nov 24 · 1:30 PM");
    expect(openTimeLabel({ ymd: "2026-12-01", hm: "12:00" })).toBe("Tue, Dec 1 · 12:00 PM");
    expect(openTimeLabel({ ymd: "2027-01-03", hm: "00:15" })).toBe("Sun, Jan 3 · 12:15 AM");
  });
});

describe("offersOpenTimes", () => {
  it("on only with the switch, a day ticked, a 90-minute start in the window, and Leads & Inspections on", () => {
    expect(offersOpenTimes(settings())).toBe(true);
    expect(offersOpenTimes(settings({ offer: false }))).toBe(false);
    expect(offersOpenTimes(settings({ days: [] }))).toBe(false);
    expect(offersOpenTimes(settings({ start: "09:00", end: "10:00" }))).toBe(false);
    expect(offersOpenTimes(settings({ start: "14:00", end: "10:00" }))).toBe(false);
    expect(offersOpenTimes(settings({}, { features: { leads: false } }))).toBe(false);
  });
});

describe("openInspectionTimes: THE OFFER", () => {
  it("an empty calendar: the first two starts of the first three inspection days, in order, on the company's clock", async () => {
    const { client } = db();
    const offer = await openInspectionTimes(client, "org-1", settings(), NOW);
    expect(hms(offer)).toEqual(["2026-11-24 09:00", "2026-11-24 10:30", "2026-11-26 09:00", "2026-11-26 10:30", "2026-12-01 09:00", "2026-12-01 10:30"]);
    expect(offer[0].at).toBe("2026-11-24T17:00:00.000Z");
  });

  it("a placed job removes the starts it overlaps", async () => {
    const { client } = db({ jobs: [job("j1", at("2026-11-24", "09:00"), at("2026-11-24", "11:00"))] });
    expect(hms(await openTimesOnDay(client, "org-1", settings(), "2026-11-24", NOW))).toEqual(["2026-11-24 12:00", "2026-11-24 13:30"]);
  });

  it("a full day offers nothing, never an after-hours time; the offer moves on to the next day", async () => {
    const { client } = db({ jobs: [job("j1", at("2026-11-24", "08:00"), at("2026-11-24", "16:00"))] });
    expect(await openTimesOnDay(client, "org-1", settings(), "2026-11-24", NOW)).toEqual([]);
    const offer = await openInspectionTimes(client, "org-1", settings(), NOW);
    expect(offer[0].ymd).toBe("2026-11-26");
    expect([...new Set(offer.map((t) => t.ymd))]).toEqual(["2026-11-26", "2026-12-01", "2026-12-03"]); // a day with none takes no place
    expect(offer.every((t) => t.hm >= "09:00" && t.hm <= "13:30")).toBe(true);
  });

  it("a day holding per_day inspections offers nothing (a cancelled one and another company's do not count)", async () => {
    const day = "2026-11-26";
    const three = ["15:00", "15:30", "16:00"].map((hm, i) => visit(`v${i}`, at(day, hm), null));
    const { client } = db({ appointments: three });
    expect(await openTimesOnDay(client, "org-1", settings(), day, NOW)).toEqual([]);
    expect(await openTimesOnDay(client, "org-1", settings({ per_day: 4 }), day, NOW)).toHaveLength(4);
    const two = db({ appointments: [...three.slice(0, 2), visit("vc", at(day, "16:00"), null, { status: "cancelled" }), visit("vo", at(day, "16:00"), null, {}, "org-2")] });
    expect(await openTimesOnDay(two.client, "org-1", settings(), day, NOW)).toHaveLength(4);
  });

  it("another company's visits and jobs never block or fill a time; every read names the company", async () => {
    const theirs = db({
      jobs: [job("t1", at("2026-11-24", "08:00"), at("2026-11-24", "16:00"), "org-2")],
      appointments: ["09:00", "10:00", "11:00"].map((hm, i) => visit(`t${i}`, at("2026-11-24", hm), null, {}, "org-2")),
    });
    expect(await openTimesOnDay(theirs.client, "org-1", settings(), "2026-11-24", NOW)).toHaveLength(4);
    expect(theirs.log.length).toBeGreaterThan(0);
    for (const q of theirs.log) expect(q.filters).toContain("org_id.eq.org-1");
  });

  it("an unticked weekday, today, tomorrow and a day past the lookahead are never offered", async () => {
    const { client, log } = db();
    const s = settings({ days: ["sun", "mon", "tue", "thu"] });
    for (const ymd of ["2026-11-25", "2026-11-22", "2026-11-23"]) expect(await openTimesOnDay(client, "org-1", s, ymd, NOW)).toEqual([]);
    expect(await openTimesOnDay(client, "org-1", settings(), "2026-12-15", NOW)).toEqual([]); // the 7th Tue/Thu
    expect(await openTimesOnDay(client, "org-1", settings(), "2026-12-10", NOW)).toHaveLength(4); // the 6th
    expect(log.filter((q) => q.table === "appointments").length).toBe(2); // only the 6th day was read
  });

  it("with the offer off nothing is read and nothing offered", async () => {
    const { client, log } = db();
    expect(await openInspectionTimes(client, "org-1", settings({ offer: false }), NOW)).toEqual([]);
    expect(await openTimesOnDay(client, "org-1", settings({ offer: false }), "2026-11-24", NOW)).toEqual([]);
    expect(log).toEqual([]);
  });

  it("a daylight-saving change day lands on the right instant (Sun Nov 1 2026, the clocks go back)", async () => {
    const { client } = db({ appointments: [visit("v1", "2026-11-01T17:00:00.000Z", null)] }); // 9:00 AM PST
    const s = settings({ days: ["sun"] });
    const day = await openTimesOnDay(client, "org-1", s, "2026-11-01", new Date("2026-10-29T19:00:00Z"));
    expect(day.map((t) => [t.hm, t.at])).toEqual([
      ["10:30", "2026-11-01T18:30:00.000Z"],
      ["12:00", "2026-11-01T20:00:00.000Z"],
      ["13:30", "2026-11-01T21:30:00.000Z"],
    ]);
  });

  it.each(["appointments", "jobs", "job_schedule_segments"])("a failed %s read throws (never 'nothing is busy')", async (t) => {
    const { client } = makeDayStandIn({ jobs: [], appointments: [], job_schedule_segments: [] }, { failOn: [t] });
    await expect(openInspectionTimes(client, "org-1", settings(), NOW)).rejects.toThrow(/read failed/);
    await expect(openTimesOnDay(client, "org-1", settings(), "2026-11-24", NOW)).rejects.toThrow(/read failed/);
  });
});

describe("the day's count of inspections", () => {
  it("a failed count read throws (never 'the day holds none')", async () => {
    const { client } = makeDayStandIn(
      { jobs: [], appointments: [], job_schedule_segments: [] },
      { failWhen: (q) => q.table === "appointments" && q.cols.join(",") === "id" },
    );
    await expect(openTimesOnDay(client, "org-1", settings(), "2026-11-24", NOW)).rejects.toThrow(/read failed/);
  });
});
