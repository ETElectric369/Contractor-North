import { describe, it, expect } from "vitest";
import {
  blockWords,
  dayBlockWords,
  DEFAULT_JOB_MINUTES,
  dayWords,
  keptEndMin,
  endAfter,
  hmWords,
  jobDayBlock,
  lengthWords,
  planJobTimes,
  readJobBlock,
  readVisitBlock,
  workDayMinutes,
} from "./job-block";
import { tzDateTimeUtc } from "../tz";
import { daysNeeded } from "./work-shape";

/**
 * A JOB LANDS EXACTLY WHERE AND AS LONG AS CHOSEN, in the company's timezone on any date.
 *
 * Erik, 2026-09-28, J-058 Seiler · 3-way switches: "i set it for 2 hours and it jumped to a later time
 * block for many hours". Stored: 2026-09-28T17:00Z to 2026-09-29T00:00Z, planned_minutes NULL, i.e.
 * 10:00 AM to 5:00 PM Pacific. The 5 PM was the writer's closing-time stamp; the 10:00 was a wall-clock
 * time it was handed, not a daylight-saving slip (see "not a DST slip" below).
 */
const LA = "America/Los_Angeles";
const ET_DAY = { start: "09:00", end: "17:00" }; // ET Electric's work day
const DEFAULT_DAY = { start: "08:00", end: "17:00" }; // a company that never set one
const none = { scheduledStart: null, scheduledEnd: null, plannedMinutes: null };
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA);
const wd = workDayMinutes(ET_DAY);

describe("not a DST slip: J-058's stored pair, decoded", () => {
  it("reads 10:00 AM to 5:00 PM Pacific on Mon Sep 28", () => {
    expect(at("2026-09-28", "10:00")).toBe("2026-09-28T17:00:00.000Z");
    expect(at("2026-09-28", "17:00")).toBe("2026-09-29T00:00:00.000Z");
  });

  it("a fixed -8 (the PST-in-summer class) would have put the end at 01:00Z, not the 00:00Z stored", () => {
    // The same write stores both ends with the same offset. The end is 5 PM at -7 (PDT), so the start
    // it was handed was 10:00 local, never a 9:00 shifted an hour.
    const minusEight = (ymd: string, hm: string) => new Date(Date.parse(`${ymd}T${hm}:00Z`) + 8 * 3_600_000).toISOString();
    expect(minusEight("2026-09-28", "17:00")).toBe("2026-09-29T01:00:00.000Z");
    expect(minusEight("2026-09-28", "09:00")).toBe("2026-09-28T17:00:00.000Z");
    expect(at("2026-09-28", "09:00")).toBe("2026-09-28T16:00:00.000Z");
  });

  it("as it stands, J-058 draws 10–5 (unsized, so the stored end is what there is) and says nobody chose it", () => {
    const j058 = { scheduledStart: "2026-09-28T17:00:00Z", scheduledEnd: "2026-09-29T00:00:00Z", plannedMinutes: null };
    expect(jobDayBlock({ day: "2026-09-28", ...j058, tz: LA, wd })).toEqual({ startMin: 600, endMin: 1020, allDay: false });
    const b = readJobBlock({ ...j058, tz: LA, workDay: ET_DAY });
    expect(blockWords(b)).toBe("7 hours — change it");
  });

  it("a 2h pick on it now lands 10:00 to 12:00, and says 2 hours", () => {
    const t = planJobTimes({
      firstDay: "2026-09-28",
      lastDay: "2026-09-28",
      tz: LA,
      workDay: ET_DAY,
      length: 120,
      prior: { scheduledStart: "2026-09-28T17:00:00Z", scheduledEnd: "2026-09-29T00:00:00Z", plannedMinutes: null },
    });
    expect(t).toEqual({ startIso: "2026-09-28T17:00:00.000Z", endIso: "2026-09-28T19:00:00.000Z", plannedMinutes: 120, defaulted: false });
  });
});

describe("the company's clock on any date: a 9:00 start in March, July and November", () => {
  // 2026: clocks go forward Sun Mar 8 and back Sun Nov 1 in Los Angeles.
  const cases: [string, string, string][] = [
    ["2026-03-06", "2026-03-06T17:00:00.000Z", "2026-03-06T19:00:00.000Z"], // Fri, still PST (-8)
    ["2026-03-08", "2026-03-08T16:00:00.000Z", "2026-03-08T18:00:00.000Z"], // the change day, PDT by 9
    ["2026-03-09", "2026-03-09T16:00:00.000Z", "2026-03-09T18:00:00.000Z"], // Mon, PDT (-7)
    ["2026-07-15", "2026-07-15T16:00:00.000Z", "2026-07-15T18:00:00.000Z"], // summer
    ["2026-11-01", "2026-11-01T17:00:00.000Z", "2026-11-01T19:00:00.000Z"], // the change day, PST by 9
    ["2026-11-02", "2026-11-02T17:00:00.000Z", "2026-11-02T19:00:00.000Z"], // Mon, PST (-8)
  ];
  for (const [day, start, end] of cases) {
    it(`${day}: 9:00 AM with a 2h pick is 9 to 11 local`, () => {
      const t = planJobTimes({ firstDay: day, lastDay: day, tz: LA, workDay: ET_DAY, startTime: "09:00", length: 120, prior: none });
      expect(t.startIso).toBe(start);
      expect(t.endIso).toBe(end);
      expect(t.plannedMinutes).toBe(120);
      // …and the calendar draws it back at 9 to 11 on that day.
      expect(jobDayBlock({ day, scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: 120, tz: LA, wd })).toEqual({
        startMin: 540,
        endMin: 660,
        allDay: false,
      });
    });
  }

  it("New York's 9:00 is its own 9:00 too", () => {
    const t = planJobTimes({ firstDay: "2026-11-02", lastDay: "2026-11-02", tz: "America/New_York", workDay: ET_DAY, startTime: "09:00", length: 60, prior: none });
    expect(t.startIso).toBe("2026-11-02T14:00:00.000Z");
    expect(t.endIso).toBe("2026-11-02T15:00:00.000Z");
  });
});

describe("no length chosen: two hours, said out loud, never the rest of the day", () => {
  it("a job getting its first day at 10:00 with no size lands 10 to 12, and planned_minutes is left blank", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "10:00", prior: none });
    expect(DEFAULT_JOB_MINUTES).toBe(120);
    expect(t).toEqual({ startIso: "2026-09-28T17:00:00.000Z", endIso: "2026-09-28T19:00:00.000Z", defaulted: true });
    expect("plannedMinutes" in t).toBe(false);
    const b = readJobBlock({ scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: null, tz: LA, workDay: ET_DAY });
    expect(blockWords(b)).toBe("2 hours — change it");
  });

  it("no time either: from the opening, two hours", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, prior: none });
    expect(t.startIso).toBe(at("2026-09-28", "09:00"));
    expect(t.endIso).toBe(at("2026-09-28", "11:00"));
    expect(t.defaulted).toBe(true);
  });

  it("a size somebody chose earlier (the rail's How Long) is used, never the default", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "13:00", prior: { ...none, plannedMinutes: 180 } });
    expect(t).toEqual({ startIso: at("2026-09-28", "13:00"), endIso: at("2026-09-28", "16:00"), defaulted: false });
  });

  it("a size of a day or more fills the day it lands on (the extra days are the placement's)", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "13:00", prior: { ...none, plannedMinutes: 960 } });
    expect(t.endIso).toBe(at("2026-09-28", "17:00"));
  });
});

describe("a chosen length: 1h 2h 4h, an End time, Full Day", () => {
  const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "12:00"), plannedMinutes: null };

  it("a 4h pick keeps the start and runs four hours", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, length: 240, prior });
    expect(t).toEqual({ startIso: at("2026-09-28", "10:00"), endIso: at("2026-09-28", "14:00"), plannedMinutes: 240, defaulted: false });
  });

  it("an End time is its minutes: 10:00 to 3:30 PM is 330", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, length: 330, prior });
    expect(t.endIso).toBe(at("2026-09-28", "15:30"));
    expect(t.plannedMinutes).toBe(330);
  });

  it("Full Day is the company's whole day, sized as a day", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, length: "full", prior });
    expect(t).toEqual({ startIso: at("2026-09-28", "09:00"), endIso: at("2026-09-28", "17:00"), plannedMinutes: 480, defaulted: false });
    const b = readJobBlock({ scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: 480, tz: LA, workDay: ET_DAY });
    expect(b.allDay).toBe(true);
    expect(blockWords(b)).toBe("All day");
  });

  it("Full Day at an 8-to-5 company draws 8 to 5, not 8 to 4", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: DEFAULT_DAY, length: "full", prior: none });
    const block = jobDayBlock({ day: "2026-09-28", scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: 480, tz: LA, wd: workDayMinutes(DEFAULT_DAY) });
    expect(block).toEqual({ startMin: 480, endMin: 1020, allDay: true });
  });

  it("an end never runs past midnight", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "22:00", length: 240, prior: none });
    expect(t.endIso).toBe(at("2026-09-28", "23:59"));
  });
});

describe("a move keeps the block: the same start, the same length, on the new day", () => {
  it("a timed block nobody sized keeps its two hours", () => {
    const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "12:00"), plannedMinutes: null };
    const t = planJobTimes({ firstDay: "2026-09-29", lastDay: "2026-09-29", tz: LA, workDay: ET_DAY, prior });
    expect(t).toEqual({ startIso: at("2026-09-29", "10:00"), endIso: at("2026-09-29", "12:00"), defaulted: false });
  });

  it("a sized block keeps its size, even when its stored end was the old closing-time stamp", () => {
    const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "17:00"), plannedMinutes: 120 };
    const t = planJobTimes({ firstDay: "2026-09-30", lastDay: "2026-09-30", tz: LA, workDay: ET_DAY, prior });
    expect(t.endIso).toBe(at("2026-09-30", "12:00"));
  });

  it("an all-day job stays all day", () => {
    const prior = { scheduledStart: at("2026-09-28", "09:00"), scheduledEnd: at("2026-09-28", "17:00"), plannedMinutes: null };
    const t = planJobTimes({ firstDay: "2026-10-01", lastDay: "2026-10-01", tz: LA, workDay: ET_DAY, prior });
    expect(t).toEqual({ startIso: at("2026-10-01", "09:00"), endIso: at("2026-10-01", "17:00"), defaulted: false });
  });

  it("a new start on a timed block moves its end with it (10–12 to 1 PM is 1–3)", () => {
    const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "12:00"), plannedMinutes: null };
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "13:00", prior });
    expect(t.endIso).toBe(at("2026-09-28", "15:00"));
  });

  it("a new start on an all-day job nobody sized is the two-hour default from there", () => {
    const prior = { scheduledStart: at("2026-09-28", "09:00"), scheduledEnd: at("2026-09-28", "17:00"), plannedMinutes: null };
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "10:00", prior });
    expect(t).toEqual({ startIso: at("2026-09-28", "10:00"), endIso: at("2026-09-28", "12:00"), defaulted: true });
  });

  it("clearing the time (the old editor's blank) is all day", () => {
    const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "12:00"), plannedMinutes: 120 };
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: null, prior });
    expect(t).toEqual({ startIso: at("2026-09-28", "09:00"), endIso: at("2026-09-28", "17:00"), defaulted: false });
  });
});

describe("several days: the job's hours on each of them (Erik, 2026-09-29, 700 North Lake Boulevard)", () => {
  it("Erik's case: a 10–12 job given a second range keeps 10 to 12 on both days, and its End stays its own", () => {
    const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "12:00"), plannedMinutes: null };
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-10-01", tz: LA, workDay: ET_DAY, prior });
    // The end is stored on the LAST day, at the end each day has: never closing.
    expect(t).toEqual({ startIso: at("2026-09-28", "10:00"), endIso: at("2026-10-01", "12:00"), defaulted: false });
    const s = t.startIso!;
    const e = t.endIso!;
    for (const day of ["2026-09-28", "2026-09-29", "2026-10-01"]) {
      expect(jobDayBlock({ day, scheduledStart: s, scheduledEnd: e, tz: LA, wd }), day).toEqual({ startMin: 600, endMin: 720, allDay: false });
    }
    const b = readJobBlock({ scheduledStart: s, scheduledEnd: e, plannedMinutes: null, tz: LA, workDay: ET_DAY });
    expect(b).toMatchObject({ multiDay: true, day: "2026-09-28", lastDay: "2026-10-01", startHm: "10:00", endHm: "12:00", minutes: 120, allDay: false });
    expect(blockWords(b)).toBe("2 hours — change it");
  });

  it("Mon to Wed from 10 with no length: 10 to 12 each day, the default, said", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-30", tz: LA, workDay: ET_DAY, startTime: "10:00", prior: none });
    expect(t).toEqual({ startIso: at("2026-09-28", "10:00"), endIso: at("2026-09-30", "12:00"), defaulted: true });
  });

  it("a number sent to a multi-day schedule is each day's length; its size keeps what was asked", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-30", tz: LA, workDay: ET_DAY, length: 120, prior: none });
    expect(t.endIso).toBe(at("2026-09-30", "11:00"));
    expect(t.plannedMinutes).toBe(120);
    for (const day of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
      expect(jobDayBlock({ day, scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: 120, tz: LA, wd }), day).toEqual({ startMin: 540, endMin: 660, allDay: false });
    }
  });

  it("a window of several days with nothing else chosen is full days: the days were the choice", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-30", tz: LA, workDay: ET_DAY, prior: none });
    expect(t).toEqual({ startIso: at("2026-09-28", "09:00"), endIso: at("2026-09-30", "17:00"), defaulted: false });
    for (const day of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
      expect(jobDayBlock({ day, scheduledStart: t.startIso, scheduledEnd: t.endIso, tz: LA, wd }), day).toEqual({ startMin: 540, endMin: 1020, allDay: true });
    }
  });

  it("a new start on a multi-day timed block keeps its clock length, on the screen and in the writer", () => {
    const before = { multiDay: true, allDay: false, endHm: "12:00", minutes: 120 };
    expect(keptEndMin({ startMin: 13 * 60, typedStart: true, before, plannedMinutes: 0, wd })).toEqual({ endMin: 15 * 60, defaulted: false });
    const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-10-01", "12:00"), plannedMinutes: null };
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-10-01", tz: LA, workDay: ET_DAY, startTime: "13:00", prior });
    expect(t).toEqual({ startIso: at("2026-09-28", "13:00"), endIso: at("2026-10-01", "15:00"), defaulted: false });
  });

  it("a legacy multi-day row (the old closing stamp on its last day) draws its start to closing on each day", () => {
    const s = at("2026-09-28", "10:00");
    const e = at("2026-09-30", "17:00");
    for (const day of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
      expect(jobDayBlock({ day, scheduledStart: s, scheduledEnd: e, plannedMinutes: 1440, tz: LA, wd }), day).toEqual({ startMin: 600, endMin: 1020, allDay: false });
    }
  });

  it("Full Day on Erik's two-day 10–12 job (the 2h chip stored 120) is a full day on each of its days, and the chip reads pressed", () => {
    // 10:00 + the 2h chip on Tue, then Add Date Range through Thu: 10 to 12 each day, size 120.
    const two = planJobTimes({ firstDay: "2026-09-29", lastDay: "2026-10-01", tz: LA, workDay: ET_DAY, prior: { scheduledStart: at("2026-09-29", "10:00"), scheduledEnd: at("2026-09-29", "12:00"), plannedMinutes: 120 } });
    expect(two).toEqual({ startIso: at("2026-09-29", "10:00"), endIso: at("2026-10-01", "12:00"), defaulted: false });
    // Then the Full Day chip. Before the fix the size stayed 120 beside the new 9-to-5 end, and
    // jobDayBlock's "a size beats the closing stamp" rule re-drew 9:00 to 11:00 on every day.
    const t = planJobTimes({ firstDay: "2026-09-29", lastDay: "2026-10-01", tz: LA, workDay: ET_DAY, length: "full", prior: { scheduledStart: two.startIso, scheduledEnd: two.endIso, plannedMinutes: 120 } });
    expect(t).toEqual({ startIso: at("2026-09-29", "09:00"), endIso: at("2026-10-01", "17:00"), plannedMinutes: 480, defaulted: false });
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-01"]) {
      expect(jobDayBlock({ day, scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: t.plannedMinutes, tz: LA, wd }), day).toEqual({ startMin: wd.startMin, endMin: wd.endMin, allDay: true });
    }
    const b = readJobBlock({ scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: t.plannedMinutes, tz: LA, workDay: ET_DAY });
    expect(b).toMatchObject({ multiDay: true, allDay: true, startHm: "09:00", endHm: "17:00", sized: true });
    expect(blockWords(b)).toBe("All day");
    expect(dayBlockWords({ day: "2026-09-30", scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: t.plannedMinutes, tz: LA, workDay: ET_DAY })).toEqual({ words: "9:00 AM – 5:00 PM · All day", history: false });
  });

  it("Full Day after an End typed on several days (a 4-hour clock stored) is a full day too", () => {
    const prior = { scheduledStart: at("2026-09-28", "09:00"), scheduledEnd: at("2026-09-30", "13:00"), plannedMinutes: 240 };
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-30", tz: LA, workDay: ET_DAY, length: "full", prior });
    expect(t.plannedMinutes).toBe(480);
    expect(readJobBlock({ scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: t.plannedMinutes, tz: LA, workDay: ET_DAY })).toMatchObject({ allDay: true, endHm: "17:00" });
  });

  it("Full Day on several days keeps a load of several days already on file (1440 stays 1440), and still draws full days", () => {
    const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-30", "12:00"), plannedMinutes: 1440 };
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-30", tz: LA, workDay: ET_DAY, length: "full", prior });
    expect(t.plannedMinutes).toBe(1440);
    expect(jobDayBlock({ day: "2026-09-29", scheduledStart: t.startIso, scheduledEnd: t.endIso, plannedMinutes: 1440, tz: LA, wd })).toEqual({ startMin: wd.startMin, endMin: wd.endMin, allDay: true });
    // One day never stores more than a day (the Full Day chip's 480), as before.
    const one = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, length: "full", prior: { ...prior, scheduledEnd: at("2026-09-28", "12:00"), plannedMinutes: 120 } });
    expect(one.plannedMinutes).toBe(480);
  });

  it("a legacy multi-day row with a sub-day size and the old closing stamp draws its size each day (its hours are each day's), never full days", () => {
    // A 4h-sized job later given a week, written before this fix: start 9:00 Mon, the stamp at closing
    // Thu, planned_minutes 240. cn-v1030 drew full days over the size somebody chose; now the size is
    // each day's block, the same rule as one day.
    const s = at("2026-10-05", "09:00");
    const e = at("2026-10-08", "17:00");
    for (const day of ["2026-10-05", "2026-10-06", "2026-10-08"]) {
      expect(jobDayBlock({ day, scheduledStart: s, scheduledEnd: e, plannedMinutes: 240, tz: LA, wd }), day).toEqual({ startMin: 540, endMin: 780, allDay: false });
    }
  });

  it("a worked day kept outside the plan draws as a full day of the job", () => {
    const s = at("2026-09-28", "10:00");
    const e = at("2026-09-28", "12:00");
    expect(jobDayBlock({ day: "2026-09-22", scheduledStart: s, scheduledEnd: e, tz: LA, wd })).toEqual({ startMin: 540, endMin: 1020, allDay: true });
  });

  it("the words say the length, never 'full days'", () => {
    const b = readJobBlock({ scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-30", "17:00"), plannedMinutes: 1440, tz: LA, workDay: ET_DAY });
    expect(b.multiDay).toBe(true);
    expect(blockWords(b)).toBe("7 hours");
    expect(blockWords({ ...b, sized: false })).toBe("7 hours — change it");
  });
});

describe("what the calendar draws, for the rows already stored", () => {
  const day = "2026-09-28";
  const draw = (s: string | null, e: string | null, planned: number | null = null) =>
    jobDayBlock({ day, scheduledStart: s, scheduledEnd: e, plannedMinutes: planned, tz: LA, wd });

  it("all day stays all day", () => {
    expect(draw(at(day, "09:00"), at(day, "17:00"))).toEqual({ startMin: 540, endMin: 1020, allDay: true });
  });

  it("Nora's 9–11 at a 9 o'clock shop is timed, not the all-day marker", () => {
    expect(draw(at(day, "09:00"), at(day, "11:00"))).toEqual({ startMin: 540, endMin: 660, allDay: false });
  });

  it("a size beats the closing-time stamp, at the opening or anywhere else", () => {
    expect(draw(at(day, "09:00"), at(day, "17:00"), 120)).toEqual({ startMin: 540, endMin: 660, allDay: false });
    expect(draw(at(day, "10:00"), at(day, "17:00"), 120)).toEqual({ startMin: 600, endMin: 720, allDay: false });
  });

  it("an older row with a start and no end runs to closing, as it always drew; sized, it draws its size", () => {
    expect(draw(at(day, "14:15"), null)).toEqual({ startMin: 855, endMin: 1020, allDay: false });
    expect(draw(at(day, "14:15"), null, 180)).toEqual({ startMin: 855, endMin: 1035, allDay: false });
  });

  it("a start after closing still draws an hour, never inverted", () => {
    expect(draw(at(day, "19:00"), null)).toEqual({ startMin: 1140, endMin: 1200, allDay: false });
  });

  it("no day at all is simply the work day (never used to draw, never a crash)", () => {
    expect(draw(null, null)).toEqual({ startMin: 540, endMin: 1020, allDay: true });
  });
});

describe("the words", () => {
  it("lengths as a person says them", () => {
    expect(lengthWords(60)).toBe("1 hour");
    expect(lengthWords(120)).toBe("2 hours");
    expect(lengthWords(90)).toBe("1.5 hours");
    expect(lengthWords(45)).toBe("45 minutes");
    expect(lengthWords(80)).toBe("1 hour 20 minutes");
  });

  it("times and days", () => {
    expect(hmWords("10:00")).toBe("10:00 AM");
    expect(hmWords("13:30")).toBe("1:30 PM");
    expect(hmWords("00:15")).toBe("12:15 AM");
    expect(dayWords("2026-09-28")).toBe("Mon, Sep 28");
    expect(endAfter("10:00", 120)).toBe("12:00");
    expect(endAfter("23:00", 120)).toBe("23:59");
  });

  it("a job with no day yet reads as the default it will get", () => {
    const b = readJobBlock({ ...none, tz: LA, workDay: ET_DAY });
    expect(b).toMatchObject({ day: null, startHm: "09:00", endHm: "11:00", minutes: 120, sized: false });
  });
});

describe("a visit's block, for the same controls", () => {
  it("no end is the calendar's hour, and the app's, not a person's", () => {
    const b = readVisitBlock({ startsAt: at("2026-09-28", "09:00")!, endsAt: null, tz: LA, workDay: ET_DAY });
    expect(b).toMatchObject({ day: "2026-09-28", startHm: "09:00", endHm: "10:00", minutes: 60, sized: false, allDay: false });
    expect(blockWords(b)).toBe("1 hour — change it");
  });

  it("an end is somebody's", () => {
    const b = readVisitBlock({ startsAt: at("2026-09-28", "09:00")!, endsAt: at("2026-09-28", "11:00"), tz: LA, workDay: ET_DAY });
    expect(blockWords(b)).toBe("2 hours");
  });

  it("over several days it is full days", () => {
    const b = readVisitBlock({ startsAt: at("2026-09-28", "09:00")!, endsAt: at("2026-10-02", "17:00"), tz: LA, workDay: ET_DAY });
    expect(b).toMatchObject({ multiDay: true, lastDay: "2026-10-02" });
  });
});

describe("one day's clock is not the job's load (planned_minutes is work, 480 a day)", () => {
  const EARLY_DAY = { start: "07:00", end: "17:00" };

  it("8:00 to 5:00 PM typed into the End box (540 on the clock) is one day of work, like Full Day", () => {
    const t = planJobTimes({ firstDay: "2026-10-07", lastDay: "2026-10-07", tz: LA, workDay: DEFAULT_DAY, startTime: "08:00", length: 540, prior: none });
    expect(t).toMatchObject({ startIso: at("2026-10-07", "08:00"), endIso: at("2026-10-07", "17:00"), plannedMinutes: 480 });
    expect(daysNeeded(t.plannedMinutes)).toBe(1);
    const full = planJobTimes({ firstDay: "2026-10-07", lastDay: "2026-10-07", tz: LA, workDay: DEFAULT_DAY, length: "full", prior: none });
    expect(full.plannedMinutes).toBe(t.plannedMinutes);
  });

  it("a 7:00–3:30 trade day is its 8.5 hours on the clock and still one day", () => {
    const t = planJobTimes({ firstDay: "2026-10-07", lastDay: "2026-10-07", tz: LA, workDay: EARLY_DAY, startTime: "07:00", length: 510, prior: none });
    expect(t.endIso).toBe(at("2026-10-07", "15:30"));
    expect(daysNeeded(t.plannedMinutes)).toBe(1);
  });

  it("a 540-minute 07:00–16:00 block moved a day stays 07:00–16:00 (not rounded up to closing)", () => {
    const prior = { scheduledStart: at("2026-10-07", "07:00"), scheduledEnd: at("2026-10-07", "16:00"), plannedMinutes: 540 };
    const t = planJobTimes({ firstDay: "2026-10-08", lastDay: "2026-10-08", tz: LA, workDay: EARLY_DAY, prior });
    expect(t).toEqual({ startIso: at("2026-10-08", "07:00"), endIso: at("2026-10-08", "16:00"), defaulted: false });
  });

  it("on the default day, 10:00–6:00 PM (sized 480) moved stays 8 hours, and 7:00–3:00 PM stays 8 hours", () => {
    const late = { scheduledStart: at("2026-10-07", "10:00"), scheduledEnd: at("2026-10-07", "18:00"), plannedMinutes: 480 };
    expect(planJobTimes({ firstDay: "2026-10-09", lastDay: "2026-10-09", tz: LA, workDay: DEFAULT_DAY, prior: late }).endIso).toBe(at("2026-10-09", "18:00"));
    const early = { scheduledStart: at("2026-10-07", "07:00"), scheduledEnd: at("2026-10-07", "15:00"), plannedMinutes: 480 };
    expect(planJobTimes({ firstDay: "2026-10-09", lastDay: "2026-10-09", tz: LA, workDay: DEFAULT_DAY, prior: early }).endIso).toBe(at("2026-10-09", "15:00"));
  });

  it("a size of a day whose end was the old closing stamp still runs to closing from a new start", () => {
    const prior = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "17:00"), plannedMinutes: 480 };
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "11:00", prior });
    expect(t.endIso).toBe(at("2026-09-28", "17:00"));
  });
});

describe("the old closing-time stamp is not a length anybody chose (rows written before the fix)", () => {
  const j058 = { scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-28", "17:00"), plannedMinutes: null };

  it("J-058 with its start moved to 2:00 PM is 2 to 4 (the default, said), never 2 to 9 PM", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "14:00", prior: j058 });
    expect(t).toEqual({ startIso: at("2026-09-28", "14:00"), endIso: at("2026-09-28", "16:00"), defaulted: true });
  });

  it("placed on its own day at 1:00 PM (the fitter's two hours), it lands 1 to 3, never past closing", () => {
    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: ET_DAY, startTime: "13:00", prior: j058 });
    expect(t.endIso).toBe(at("2026-09-28", "15:00"));
  });

  it("a plain move (no new start) keeps what it draws", () => {
    const t = planJobTimes({ firstDay: "2026-09-29", lastDay: "2026-09-29", tz: LA, workDay: ET_DAY, prior: j058 });
    expect(t).toEqual({ startIso: at("2026-09-29", "10:00"), endIso: at("2026-09-29", "17:00"), defaulted: false });
  });

  it("the Start box predicts the same end the writer stores (one rule: keptEndMin)", () => {
    const before = readJobBlock({ ...j058, tz: LA, workDay: ET_DAY });
    expect(keptEndMin({ startMin: 14 * 60, typedStart: true, before, plannedMinutes: 0, wd })).toEqual({ endMin: 16 * 60, defaulted: true });
    // A timed block that ends before closing keeps its clock length.
    const tenToNoon = { multiDay: false, allDay: false, endHm: "12:00", minutes: 120 };
    expect(keptEndMin({ startMin: 13 * 60, typedStart: true, before: tenToNoon, plannedMinutes: 0, wd })).toEqual({ endMin: 15 * 60, defaulted: false });
  });
});

describe("the day drill's line says what the grid draws on THAT day", () => {
  const plan = { scheduledStart: at("2026-09-29", "09:00"), scheduledEnd: at("2026-09-29", "11:00"), plannedMinutes: 120, tz: LA, workDay: ET_DAY };

  it("on the plan's day: its block", () => {
    expect(dayBlockWords({ day: "2026-09-29", ...plan })).toEqual({ words: "9:00 AM – 11:00 AM · 2 hours", history: false });
  });

  it("on a worked day kept as history (the grid draws it all day): a worked day, and where the plan is", () => {
    expect(jobDayBlock({ day: "2026-09-22", ...plan, wd })).toEqual({ startMin: 540, endMin: 1020, allDay: true });
    expect(dayBlockWords({ day: "2026-09-22", ...plan })).toEqual({ words: "Worked day · planned Tue, Sep 29", history: true });
  });

  it("a job with no plan left (its date cleared): a worked day, no day planned", () => {
    expect(dayBlockWords({ day: "2026-09-22", ...plan, scheduledStart: null, scheduledEnd: null })).toEqual({
      words: "Worked day · no day planned yet",
      history: true,
    });
  });

  it("every day of several reads the job's hours, the first, a middle one and the last alike", () => {
    const many = { ...plan, scheduledStart: at("2026-09-28", "10:00"), scheduledEnd: at("2026-09-30", "12:00"), plannedMinutes: 120 };
    for (const day of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
      expect(dayBlockWords({ day, ...many }).words, day).toBe("10:00 AM – 12:00 PM · 2 hours");
    }
  });
});
