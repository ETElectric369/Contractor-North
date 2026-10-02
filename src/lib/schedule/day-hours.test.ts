import { describe, it, expect } from "vitest";
import { tzDateTimeUtc } from "@/lib/tz";
import {
  addDaySegment,
  carryHours,
  datesOnly,
  hoursOnDay,
  keepWorkedDays,
  mergeSegments,
  moveKeepingWorkedDays,
  segmentDays,
  setDayHours,
  type DaySegment,
} from "@/lib/schedule-math";
import { dayBlockWords, jobDayBlock, planJobTimes, workDayMinutes } from "./job-block";
import { dayHoursOf, freezeDrawnDays, nextDayHours, readDayHours } from "./day-hours";
import { ownHoursByJobDay } from "./segment-hours";

/**
 * EACH DAY KEEPS ITS OWN HOURS (0370), as math. Erik, 2026-09-28: "i want to put honysuckle on the page
 * for the rest of the day after Siskin". A job over several days had one time of day for all of them;
 * a day now carries its own (job_schedule_segments.start_time / end_time), drawn exactly, carried
 * through every rewrite, and adding a day never moves another.
 */
const LA = "America/Los_Angeles";
const WORK_DAY = { start: "09:00", end: "17:00" };
const wd = workDayMinutes(WORK_DAY);
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA)!;
const noon5 = { start: "12:00", end: "17:00" };

describe("the calendar draws a day by its own hours", () => {
  // Honeysuckle: 9/24 to 9/28 on its usual hours (9:00 start, full days), today with its own noon to 5.
  const honeysuckle = { scheduledStart: at("2026-09-24", "09:00"), scheduledEnd: at("2026-09-28", "17:00"), plannedMinutes: null, tz: LA, wd };

  it("a day with its own hours draws exactly those; the job's other days draw its usual hours", () => {
    expect(jobDayBlock({ day: "2026-09-28", ...honeysuckle, dayHours: noon5 })).toEqual({ startMin: 720, endMin: 1020, allDay: false });
    // The same day without its own: the last day of the span, the opening to the end.
    expect(jobDayBlock({ day: "2026-09-28", ...honeysuckle })).toEqual({ startMin: 540, endMin: 1020, allDay: true });
    expect(jobDayBlock({ day: "2026-09-25", ...honeysuckle, dayHours: null })).toEqual({ startMin: 540, endMin: 1020, allDay: true });
  });

  it("own hours on the company's whole day read as all day; hours that don't read as a start before an end are ignored", () => {
    expect(jobDayBlock({ day: "2026-09-26", ...honeysuckle, dayHours: { start: "09:00", end: "17:00" } }).allDay).toBe(true);
    expect(jobDayBlock({ day: "2026-09-28", ...honeysuckle, dayHours: { start: "17:00", end: "12:00" } })).toEqual({ startMin: 540, endMin: 1020, allDay: true });
  });

  it("a worked day kept as history with its own hours draws them (outside the plan it's otherwise all day)", () => {
    const plan = { scheduledStart: at("2026-10-05", "09:00"), scheduledEnd: at("2026-10-05", "11:00"), plannedMinutes: null, tz: LA, wd };
    expect(jobDayBlock({ day: "2026-09-22", ...plan, dayHours: noon5 })).toEqual({ startMin: 720, endMin: 1020, allDay: false });
    expect(jobDayBlock({ day: "2026-09-22", ...plan })).toEqual({ startMin: 540, endMin: 1020, allDay: true });
  });

  it("across both clock changes, a day's own hours are its wall clock and the usual days keep theirs", () => {
    // Fall back (Nov 1, PDT → PST) in the middle of a three-day job; spring forward (Mar 8) likewise.
    for (const [first, mid, last] of [
      ["2026-10-31", "2026-11-01", "2026-11-02"],
      ["2026-03-07", "2026-03-08", "2026-03-09"],
    ]) {
      const job = { scheduledStart: at(first, "10:00"), scheduledEnd: at(last, "17:00"), plannedMinutes: 1440, tz: LA, wd };
      expect(jobDayBlock({ day: mid, ...job, dayHours: noon5 }), mid).toEqual({ startMin: 720, endMin: 1020, allDay: false });
      // The usual days: the job's hours on each of them (a legacy closing stamp on the last day draws to closing).
      expect(jobDayBlock({ day: first, ...job }), first).toEqual({ startMin: 600, endMin: 1020, allDay: false });
      expect(jobDayBlock({ day: last, ...job }), last).toEqual({ startMin: 600, endMin: 1020, allDay: false });
      expect(jobDayBlock({ day: mid, ...job }), mid).toEqual({ startMin: 600, endMin: 1020, allDay: false });
    }
  });

  it("the day drill says the day's own hours, and still says a worked day is history", () => {
    const plan = { scheduledStart: at("2026-09-24", "09:00"), scheduledEnd: at("2026-09-28", "17:00"), plannedMinutes: null, tz: LA, workDay: WORK_DAY };
    expect(dayBlockWords({ day: "2026-09-28", ...plan, dayHours: noon5 })).toEqual({ words: "12:00 PM – 5:00 PM · 5 hours", history: false });
    expect(dayBlockWords({ day: "2026-09-20", ...plan, dayHours: noon5 })).toEqual({ words: "Worked day · 12:00 PM – 5:00 PM · 5 hours", history: true });
    expect(dayBlockWords({ day: "2026-09-28", ...plan }).words).toBe("9:00 AM – 5:00 PM · All day — change it");
  });
});

describe("one day's new hours (the schedule tile's This Day, the writer's own rule)", () => {
  const block = (s: number, e: number) => ({ startMin: s, endMin: e, allDay: s === wd.startMin && e === wd.endMin });

  it("a new start keeps the day's length: its own noon to 5 moved to 1 PM is 1 to 6", () => {
    expect(nextDayHours({ before: block(720, 1020), own: true, plannedMinutes: null, patch: { start: "13:00" }, wd })).toEqual({ start: "13:00", end: "18:00" });
  });

  it("a full usual day given a start: the job's size when it has one, else the two-hour default", () => {
    expect(nextDayHours({ before: block(540, 1020), own: false, plannedMinutes: 240, patch: { start: "13:00" }, wd })).toEqual({ start: "13:00", end: "17:00" });
    expect(nextDayHours({ before: block(540, 1020), own: false, plannedMinutes: null, patch: { start: "13:00" }, wd })).toEqual({ start: "13:00", end: "15:00" });
    // Sized a day or more: to closing from the new start.
    expect(nextDayHours({ before: block(540, 1020), own: false, plannedMinutes: 1440, patch: { start: "11:00" }, wd })).toEqual({ start: "11:00", end: "17:00" });
  });

  it("a length runs from the start it has; Full Day is the company's day; an End past midnight stops at 11:59 PM", () => {
    expect(nextDayHours({ before: block(720, 1020), own: true, plannedMinutes: null, patch: { length: 120 }, wd })).toEqual({ start: "12:00", end: "14:00" });
    expect(nextDayHours({ before: block(720, 1020), own: true, plannedMinutes: null, patch: { length: "full" }, wd })).toEqual({ start: "09:00", end: "17:00" });
    expect(nextDayHours({ before: block(1320, 1380), own: true, plannedMinutes: null, patch: { length: 240 }, wd })).toEqual({ start: "22:00", end: "23:59" });
    expect(nextDayHours({ before: block(720, 1020), own: true, plannedMinutes: null, patch: { start: "nope" }, wd })).toBeNull();
  });

  it("minutes to the stored pair, and the database's time type back to it", () => {
    expect(dayHoursOf(720, 1440)).toEqual({ start: "12:00", end: "23:59" });
    expect(dayHoursOf(1439, 1439)).toEqual({ start: "23:58", end: "23:59" });
    expect(readDayHours("12:00:00", "17:30:00")).toEqual({ start: "12:00", end: "17:30" });
    expect(readDayHours(null, null)).toBeNull();
    expect(readDayHours("17:00:00", "12:00:00")).toBeNull();
  });
});

describe("adding a day never moves another (freezeDrawnDays)", () => {
  const siskin: { scheduledStart: string; scheduledEnd: string; plannedMinutes: number | null } = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "12:00"), plannedMinutes: null };
  const grown = (first: string, last: string, prior: typeof siskin) => {
    const t = planJobTimes({ firstDay: first, lastDay: last, tz: LA, workDay: WORK_DAY, prior });
    return { scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: t.plannedMinutes ?? prior.plannedMinutes };
  };

  it("Siskin's one day, 10 to 12, gets a second day: it stays 10 to 12 by the rule itself, so nothing needs freezing", () => {
    const days = addDaySegment([{ start: "2026-09-28", end: "2026-09-28", hours: null }], "2026-09-30", noon5);
    const after = grown("2026-09-28", "2026-09-30", siskin);
    // The grown span keeps the job's hours on the 28th (a job's hours are each day's), never 10 to 5.
    expect(after).toMatchObject({ scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-30", "12:00") });
    expect(jobDayBlock({ day: "2026-09-28", ...after, tz: LA, wd })).toEqual({ startMin: 600, endMin: 720, allDay: false });
    const f = freezeDrawnDays({ segments: days, before: siskin, after, tz: LA, wd, skip: ["2026-09-30"] });
    expect(f.frozen).toEqual([]);
    expect(hoursOnDay(f.segments, "2026-09-28")).toBeNull();
    expect(hoursOnDay(f.segments, "2026-09-30")).toEqual(noon5);
  });

  it("a day added after a job's full days changes none of them: nothing is frozen", () => {
    const job = { scheduledStart: at("2026-09-24", "09:00"), scheduledEnd: at("2026-09-25", "17:00"), plannedMinutes: 960 };
    const days = addDaySegment([{ start: "2026-09-24", end: "2026-09-25", hours: null }], "2026-09-28", noon5);
    const f = freezeDrawnDays({ segments: days, before: job, after: grown("2026-09-24", "2026-09-28", job), tz: LA, wd, skip: ["2026-09-28"] });
    expect(f.frozen).toEqual([]);
  });

  it("a day added BEFORE a job that runs 10 to closing: every day still draws 10 to closing, so nothing is frozen", () => {
    const job = { scheduledStart: at("2026-09-24", "10:00"), scheduledEnd: at("2026-09-25", "17:00"), plannedMinutes: 960 };
    const days = addDaySegment([{ start: "2026-09-24", end: "2026-09-25", hours: null }], "2026-09-22", noon5);
    const after = grown("2026-09-22", "2026-09-25", job);
    expect(jobDayBlock({ day: "2026-09-24", ...after, tz: LA, wd })).toEqual(jobDayBlock({ day: "2026-09-24", ...job, tz: LA, wd }));
    const f = freezeDrawnDays({ segments: days, before: job, after, tz: LA, wd, skip: ["2026-09-22"] });
    expect(f.frozen).toEqual([]);
    expect(hoursOnDay(f.segments, "2026-09-24")).toBeNull();
    expect(hoursOnDay(f.segments, "2026-09-25")).toBeNull();
  });

  it("a day that already keeps its own hours is left alone", () => {
    const days = addDaySegment([{ start: "2026-09-28", end: "2026-09-28", hours: { start: "07:00", end: "08:00" } }], "2026-09-30", noon5);
    const f = freezeDrawnDays({ segments: days, before: siskin, after: grown("2026-09-28", "2026-09-30", siskin), tz: LA, wd, skip: ["2026-09-30"] });
    expect(f.frozen).toEqual([]);
    expect(hoursOnDay(f.segments, "2026-09-28")).toEqual({ start: "07:00", end: "08:00" });
  });
});

describe("a rewrite keeps each day's hours (writeScheduleRanges' carryHours)", () => {
  const stored: DaySegment[] = [
    { start: "2026-09-22", end: "2026-09-22", hours: { start: "07:00", end: "15:00" } },
    { start: "2026-09-24", end: "2026-09-26", hours: null },
    { start: "2026-09-28", end: "2026-09-28", hours: noon5 },
  ];

  it("ranges handed in with no hours said get, day by day, the hours those days had; a new day gets the usual", () => {
    // The job page's range editor: the 24th-26th stretched to the 29th, as dates only.
    const r = carryHours([{ start: "2026-09-22", end: "2026-09-22" }, { start: "2026-09-24", end: "2026-09-29" }], stored);
    expect(r).toEqual([
      { start: "2026-09-22", end: "2026-09-22", hours: { start: "07:00", end: "15:00" } },
      { start: "2026-09-24", end: "2026-09-27", hours: null },
      { start: "2026-09-28", end: "2026-09-28", hours: noon5 },
      { start: "2026-09-29", end: "2026-09-29", hours: null },
    ]);
  });

  it("a range that says its hours keeps them; nothing is dropped", () => {
    const r = carryHours([{ start: "2026-09-28", end: "2026-09-28", hours: null }], stored);
    expect(r).toEqual([{ start: "2026-09-28", end: "2026-09-28", hours: null }]);
  });

  it("a move keeps the moved range's own hours; a kept worked day keeps the hours it ran", () => {
    const m = moveKeepingWorkedDays(stored, "2026-09-28", "2026-10-02", [], "2026-09-27");
    expect(hoursOnDay(m.segments, "2026-10-02")).toEqual(noon5);
    expect(hoursOnDay(m.segments, "2026-09-22")).toEqual({ start: "07:00", end: "15:00" });
    const k = keepWorkedDays(stored, [{ start: "2026-10-05", end: "2026-10-05", hours: null }], ["2026-09-22"], "2026-09-27");
    expect(k.segments).toEqual([
      { start: "2026-09-22", end: "2026-09-22", hours: { start: "07:00", end: "15:00" } },
      { start: "2026-10-05", end: "2026-10-05", hours: null },
    ]);
    expect(k.mirror).toEqual({ start: "2026-10-05", end: "2026-10-05" });
  });
});

describe("ranges merge only when their hours match", () => {
  it("neighbours with the same hours join; with different hours they stay apart; a later range wins a shared day", () => {
    expect(mergeSegments([{ start: "2026-09-24", end: "2026-09-25", hours: null }, { start: "2026-09-26", end: "2026-09-26", hours: null }])).toEqual([
      { start: "2026-09-24", end: "2026-09-26", hours: null },
    ]);
    expect(mergeSegments([{ start: "2026-09-24", end: "2026-09-25", hours: null }, { start: "2026-09-26", end: "2026-09-26", hours: noon5 }])).toHaveLength(2);
    expect(mergeSegments([{ start: "2026-09-24", end: "2026-09-28", hours: null }, { start: "2026-09-26", end: "2026-09-26", hours: noon5 }])).toEqual([
      { start: "2026-09-24", end: "2026-09-25", hours: null },
      { start: "2026-09-26", end: "2026-09-26", hours: noon5 },
      { start: "2026-09-27", end: "2026-09-28", hours: null },
    ]);
  });

  it("setDayHours splits a range around one day and joins it back when the day goes usual", () => {
    const one = setDayHours([{ start: "2026-09-24", end: "2026-09-28", hours: null }], "2026-09-26", noon5);
    expect(one).toHaveLength(3);
    expect(setDayHours(one, "2026-09-26", null)).toEqual([{ start: "2026-09-24", end: "2026-09-28", hours: null }]);
  });

  it("the days alone, as the range editor shows them, and each day listed", () => {
    const split = setDayHours([{ start: "2026-09-24", end: "2026-09-28", hours: null }], "2026-09-26", noon5);
    expect(datesOnly(split)).toEqual([{ start: "2026-09-24", end: "2026-09-28" }]);
    expect(segmentDays(split)).toEqual(["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"]);
  });

  it("the calendar's map of each job's own hours by day, from the rows as read", () => {
    const m = ownHoursByJobDay([
      { job_id: "j011", start_date: "2026-09-28", end_date: "2026-09-29", start_time: "12:00:00", end_time: "17:00:00" },
      { job_id: "j011", start_date: "2026-09-22", end_date: "2026-09-22", start_time: null, end_time: null },
      { job_id: "j058", start_date: "2026-09-28", end_date: "2026-09-28" },
    ]);
    expect([...(m.get("j011")?.keys() ?? [])]).toEqual(["2026-09-28", "2026-09-29"]);
    expect(m.get("j011")?.get("2026-09-29")).toEqual(noon5);
    expect(m.has("j058")).toBe(false);
  });
});
