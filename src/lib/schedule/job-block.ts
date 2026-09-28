/**
 * A JOB'S BLOCK ON THE CALENDAR: WHERE IT STARTS AND HOW LONG IT RUNS. One rule, pure, shared by every
 * writer (schedule/actions writeScheduleRanges, the one choke point) and every reader (the calendar's
 * grid, the job page's time controls, the schedule tile's sheet).
 *
 * Erik, 2026-09-28, placing J-058 Seiler · 3-way switches: "i forgot to set an amount of time it took
 * or i set it for 2 hours and it jumped to a later time block for many hours and i had no way to adjust
 * the time ... within the job itself i could only set a start time and no end time".
 *
 * ── WHAT WAS WRONG (the root causes) ───────────────────────────────────────────────────────────
 *
 *  1. THE END WAS ALWAYS CLOSING TIME. writeScheduleRanges stamped scheduled_end at the company's
 *     work-day end on the last day, whatever the job's length, and the calendar preferred that stored
 *     end over planned_minutes (the old work-shape jobBlockEnd). So any job that did not start at the opening
 *     hour drew from its start to closing, and a chosen length never reached the picture. J-058 was
 *     stored 10:00 AM to 5:00 PM PDT (2026-09-28T17:00Z to 2026-09-29T00:00Z): the 5 PM is that stamp.
 *  2. NO LENGTH WAS A SILENT "REST OF THE DAY". Unsized, the block ran to closing (or all day), with
 *     nothing on screen saying nobody chose it.
 *  3. A DATED JOB HAD NO DOOR FOR A LENGTH. The only length control was the schedule rail's, and the
 *     rail lists only jobs with no day; the job page had a start time and no end.
 *  It was NOT a daylight-saving slip: every wall-clock conversion goes through lib/tz tzLocalHourUtc
 *  (the offset taken at the target instant) and the stored pair proves it. The same write stored the
 *  end at 00:00Z, 5 PM PDT (-7); a fixed -8 would have stored 01:00Z. The 10:00 was a wall-clock time
 *  the writer was handed (the placement fitter's first opening after 9, or a typed start).
 *
 * ── THE RULE NOW ────────────────────────────────────────────────────────────────────────────────
 *
 *  - A job lands exactly where and as long as chosen. Every write stores the block's real end:
 *    scheduled_end = the start + the length on that day, in the company's timezone on any date.
 *  - THE DEFAULT, said once: a job put on the calendar with no length is TWO HOURS from its start
 *    (DEFAULT_JOB_MINUTES). planned_minutes stays blank (nobody sized it) and every schedule surface
 *    says so in words: "2 hours — change it". All day is a choice (the Full Day chip), never a fallback.
 *  - A move keeps the block: the same start time and the same length on the new day.
 *  - A job over several days runs full days: the first day from its start, the last to closing.
 */
import { todayStrInTz, tzDateTimeUtc, tzMinutesOfDay } from "../tz";
import { hmToMinutes, minutesToHm } from "./fit-day";
import { WORK_DAY_MINUTES } from "./work-shape";

/** The length a job lands with when nobody chose one: two hours. */
export const DEFAULT_JOB_MINUTES = 120;

/** The quick lengths, once: the job page, the schedule tile's sheet and a visit's sheet all offer these. */
export const QUICK_LENGTHS: { minutes: number; label: string; words: string }[] = [
  { minutes: 60, label: "1h", words: "1 hour" },
  { minutes: 120, label: "2h", words: "2 hours" },
  { minutes: 240, label: "4h", words: "4 hours" },
];

/** A length: minutes, or "full" (the company's whole work day). */
export type JobLength = number | "full";

/** The company's work day in minutes past midnight. The end is never before the start. */
export type WorkDayMin = { startMin: number; endMin: number };

export function workDayMinutes(wd: { start: string; end: string }): WorkDayMin {
  const startMin = hmToMinutes(String(wd?.start ?? "").slice(0, 5)) ?? 8 * 60;
  const end = hmToMinutes(String(wd?.end ?? "").slice(0, 5)) ?? 17 * 60;
  return { startMin, endMin: Math.max(startMin + 60, end) };
}

const LAST_MINUTE = 23 * 60 + 59;

/** "HH:MM" (or "HH:MM:SS") → minutes; null for anything else. */
export function readHm(hm: string | null | undefined): number | null {
  return hmToMinutes(String(hm ?? "").slice(0, 5));
}

/**
 * WHERE THE JOB SITS ON ONE DAY of the calendar, in minutes past the company's midnight.
 *
 *   one day:    its start to its stored end. A SIZED job whose stored end is just the closing-time stamp
 *               (every write before this fix) draws its size, never closing: the length somebody chose
 *               beats a time the writer made up. An older row with no end runs to closing, as it always
 *               drew. Start and end both on the work-day edges (and not sized shorter) is all day.
 *   many days:  the first day from its start to closing, the middle days full, the last day from the
 *               opening to its end. A day outside the plan's span (a worked day kept as history) is full.
 */
export function jobDayBlock(p: {
  day: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  plannedMinutes?: number | null;
  tz: string;
  wd: WorkDayMin;
}): { startMin: number; endMin: number; allDay: boolean } {
  const { day, tz, wd } = p;
  const full = { startMin: wd.startMin, endMin: wd.endMin, allDay: true };
  if (!p.scheduledStart) return full;
  const first = todayStrInTz(tz, new Date(p.scheduledStart));
  const endDay = p.scheduledEnd ? todayStrInTz(tz, new Date(p.scheduledEnd)) : first;
  const last = endDay < first ? first : endDay;
  if (day < first || day > last) return full;

  const sized = Math.max(0, Number(p.plannedMinutes ?? 0) || 0);
  const startMin = tzMinutesOfDay(p.scheduledStart, tz);
  const endOnDay = p.scheduledEnd && endDay === day ? tzMinutesOfDay(p.scheduledEnd, tz) : null;

  if (first !== last) {
    if (day === first) {
      return { startMin, endMin: wd.endMin > startMin ? wd.endMin : Math.min(24 * 60, startMin + 60), allDay: startMin === wd.startMin };
    }
    if (day === last) {
      const endMin = endOnDay != null && endOnDay > wd.startMin ? endOnDay : wd.endMin;
      return { startMin: wd.startMin, endMin, allDay: endMin === wd.endMin };
    }
    return full;
  }

  const realEnd = endOnDay != null && endOnDay > startMin ? endOnDay : null;
  if (sized > 0 && sized < WORK_DAY_MINUTES && (realEnd == null || realEnd === wd.endMin)) {
    return { startMin, endMin: Math.min(24 * 60, startMin + sized), allDay: false };
  }
  if (realEnd != null) {
    return { startMin, endMin: realEnd, allDay: startMin === wd.startMin && realEnd === wd.endMin };
  }
  // An older row with no end on file: to closing, as it always drew.
  return {
    startMin,
    endMin: wd.endMin > startMin ? wd.endMin : Math.min(24 * 60, startMin + 60),
    allDay: startMin === wd.startMin,
  };
}

/** A job's block as the controls show it: its day(s), its start and end, its length, and whether
 *  anybody chose that length (planned_minutes) or the app did. */
export type JobBlock = {
  /** The first day (YYYY-MM-DD, the company's), or null when the job has no day. */
  day: string | null;
  lastDay: string | null;
  multiDay: boolean;
  allDay: boolean;
  startHm: string;
  /** The end on the (last) day. */
  endHm: string;
  /** The day's length in minutes (one-day jobs); a multi-day job's first day. */
  minutes: number;
  /** True when somebody chose the length (planned_minutes is set). */
  sized: boolean;
};

export function readJobBlock(p: {
  scheduledStart: string | null;
  scheduledEnd: string | null;
  plannedMinutes?: number | null;
  tz: string;
  workDay: { start: string; end: string };
}): JobBlock {
  const wd = workDayMinutes(p.workDay);
  const sized = Number(p.plannedMinutes ?? 0) > 0;
  if (!p.scheduledStart) {
    return {
      day: null,
      lastDay: null,
      multiDay: false,
      allDay: false,
      startHm: minutesToHm(wd.startMin),
      endHm: minutesToHm(Math.min(LAST_MINUTE, wd.startMin + DEFAULT_JOB_MINUTES)),
      minutes: DEFAULT_JOB_MINUTES,
      sized,
    };
  }
  const first = todayStrInTz(p.tz, new Date(p.scheduledStart));
  const endDay = p.scheduledEnd ? todayStrInTz(p.tz, new Date(p.scheduledEnd)) : first;
  const last = endDay < first ? first : endDay;
  const on = (day: string) =>
    jobDayBlock({ day, scheduledStart: p.scheduledStart, scheduledEnd: p.scheduledEnd, plannedMinutes: p.plannedMinutes, tz: p.tz, wd });
  const a = on(first);
  const z = last === first ? a : on(last);
  return {
    day: first,
    lastDay: last,
    multiDay: last !== first,
    allDay: last === first ? a.allDay : a.allDay && z.allDay,
    startHm: minutesToHm(a.startMin),
    endHm: minutesToHm(Math.min(LAST_MINUTE, z.endMin)),
    minutes: Math.max(1, a.endMin - a.startMin),
    sized,
  };
}

/**
 * A VISIT'S BLOCK, in the same shape, for the same controls. A visit is its starts_at → ends_at, drawn
 * as an hour when it has no end (the calendar's rule), and that hour is the app's, not a person's
 * ("1 hour — change it"). A visit over several days is full days, like a job's.
 */
export function readVisitBlock(p: {
  startsAt: string;
  endsAt: string | null;
  tz: string;
  workDay: { start: string; end: string };
}): JobBlock {
  const wd = workDayMinutes(p.workDay);
  const day = todayStrInTz(p.tz, new Date(p.startsAt));
  const startMin = tzMinutesOfDay(p.startsAt, p.tz);
  const hasEnd = !!p.endsAt && new Date(p.endsAt).getTime() > new Date(p.startsAt).getTime();
  const lastDay = hasEnd ? todayStrInTz(p.tz, new Date(p.endsAt as string)) : day;
  const multiDay = lastDay > day;
  const endMin = hasEnd ? tzMinutesOfDay(p.endsAt as string, p.tz) : Math.min(LAST_MINUTE, startMin + 60);
  return {
    day,
    lastDay,
    multiDay,
    allDay: !multiDay && startMin === wd.startMin && endMin === wd.endMin,
    startHm: minutesToHm(startMin),
    endHm: minutesToHm(Math.min(LAST_MINUTE, endMin)),
    minutes: multiDay ? Math.max(1, wd.endMin - startMin) : Math.max(1, endMin - startMin),
    sized: hasEnd,
  };
}

/** "2 hours", "1 hour", "45 minutes", "1.5 hours", "1 hour 20 minutes". */
export function lengthWords(minutes: number): string {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  if (m % 30 === 0) return `${m / 60} hours`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ${m % 60} minutes`;
}

/** "2026-09-28" → "Mon, Sep 28", the same in every timezone (a date is a date, never an instant). */
export function dayWords(ymd: string | null | undefined): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? ""))) return "";
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "10:00" → "10:00 AM", "13:30" → "1:30 PM". */
export function hmWords(hm: string): string {
  const m = readHm(hm);
  if (m == null) return hm;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The length in one line of plain words, with "— change it" when the app chose it: "2 hours — change
 *  it", "All day", "4 hours". A job over several days reads as full days. */
export function blockWords(b: Pick<JobBlock, "allDay" | "minutes" | "sized" | "multiDay">): string {
  const words = b.multiDay ? "Full days" : b.allDay ? "All day" : lengthWords(b.minutes);
  return b.sized ? words : `${words} — change it`;
}

/**
 * WHAT A SCHEDULE WRITE STORES FOR THE TIMES. Three intents each, like the writer's start time always had:
 *
 *   startTime  undefined keep the start the job has · "HH:MM" set it · null/"" all day (the old
 *              "clear the time")
 *   length     undefined keep the length the job has · minutes set it (and planned_minutes) · "full"
 *              the company's whole day (planned_minutes = one working day)
 *
 * Keeping the length means: the size somebody chose; else the length of the block the job already has
 * on its day; else all day when it was all day and nothing new was asked of it; else, a job getting a
 * day and a time for the first time with no length, the two-hour DEFAULT (planned_minutes left blank).
 * Several days are full days whatever the length (a length never collapses a multi-day schedule).
 * `plannedMinutes` undefined = leave the column alone.
 */
export function planJobTimes(p: {
  firstDay: string | null;
  lastDay: string | null;
  tz: string;
  workDay: { start: string; end: string };
  startTime?: string | null;
  length?: JobLength;
  prior: { scheduledStart: string | null; scheduledEnd: string | null; plannedMinutes: number | null };
}): { startIso: string | null; endIso: string | null; plannedMinutes?: number; defaulted: boolean } {
  if (!p.firstDay) return { startIso: null, endIso: null, defaulted: false };
  const firstDay = p.firstDay;
  const lastDay = p.lastDay && p.lastDay > firstDay ? p.lastDay : firstDay;
  const multiDay = lastDay > firstDay;
  const wd = workDayMinutes(p.workDay);
  const hadDay = !!p.prior.scheduledStart;
  const before = readJobBlock({ ...p.prior, tz: p.tz, workDay: p.workDay });
  const sized = Math.max(0, Number(p.prior.plannedMinutes ?? 0) || 0);

  const typedStart = typeof p.startTime === "string" ? readHm(p.startTime) : null;
  const clearsTime = p.startTime === null || p.startTime === "";
  let startMin = typedStart ?? (p.startTime === undefined && hadDay ? (readHm(before.startHm) ?? wd.startMin) : wd.startMin);

  let plannedMinutes: number | undefined;
  const numeric = typeof p.length === "number" && Number.isFinite(p.length) && p.length > 0;
  if (p.length === "full" || (clearsTime && p.length === undefined)) {
    startMin = wd.startMin;
    if (p.length === "full" && !multiDay) plannedMinutes = WORK_DAY_MINUTES;
  } else if (numeric) {
    plannedMinutes = Math.min(60 * 24 * 30, Math.round(p.length as number));
  }
  startMin = Math.min(startMin, LAST_MINUTE - 1);

  // SEVERAL DAYS ARE FULL DAYS: the last one ends at closing, whatever the length.
  if (multiDay) {
    return {
      startIso: tzDateTimeUtc(firstDay, minutesToHm(startMin), p.tz),
      endIso: tzDateTimeUtc(lastDay, minutesToHm(wd.endMin), p.tz),
      ...(plannedMinutes !== undefined ? { plannedMinutes } : {}),
      defaulted: false,
    };
  }

  const toClosing = (s: number) => (wd.endMin > s ? wd.endMin : s + 60);
  let endMin: number;
  let defaulted = false;
  if (p.length === "full" || (clearsTime && p.length === undefined)) {
    endMin = wd.endMin;
  } else if (plannedMinutes !== undefined) {
    endMin = startMin + plannedMinutes;
  } else if (sized > 0) {
    endMin = sized >= WORK_DAY_MINUTES ? toClosing(startMin) : startMin + sized;
  } else if (hadDay && !before.multiDay && !before.allDay) {
    endMin = startMin + before.minutes;
  } else if (hadDay && typedStart == null) {
    // It was all day (or several full days) and nothing new was asked of it: its day stays a full day.
    endMin = toClosing(startMin);
  } else {
    endMin = startMin + DEFAULT_JOB_MINUTES;
    defaulted = true;
  }
  endMin = Math.max(startMin + 1, Math.min(LAST_MINUTE, endMin));
  return {
    startIso: tzDateTimeUtc(firstDay, minutesToHm(startMin), p.tz),
    endIso: tzDateTimeUtc(firstDay, minutesToHm(endMin), p.tz),
    ...(plannedMinutes !== undefined ? { plannedMinutes } : {}),
    defaulted,
  };
}

/** The end a length gives a start, as "HH:MM" on the same day (clamped before midnight). */
export function endAfter(startHm: string, minutes: number): string {
  const s = readHm(startHm) ?? 8 * 60;
  return minutesToHm(Math.min(LAST_MINUTE, s + Math.max(1, Math.round(minutes))));
}
