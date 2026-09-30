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
 *  - A JOB'S USUAL HOURS ARE ITS HOURS ON EACH OF ITS DAYS. Erik, 2026-09-29, on 700 North Lake
 *    Boulevard: a second date range (Add Date Range) turned his 10–12 job into "full days", stamped the
 *    end at closing over the end he set, and hid the End box and the length chips. The "several days
 *    are full days" rule (cn-v1030) was written for one contiguous stretch and fired for two separate
 *    days. Now a 10–12 job is 10–12 on every day it has; scheduled_end is that end on the LAST day, and
 *    a day that keeps its own hours (0370) still draws its own. The one thing several days decide on
 *    their own: a window with nothing else chosen (no start, no length, no block before) is full days,
 *    because the days were the choice.
 */
import { todayStrInTz, tzDateTimeUtc, tzMinutesOfDay } from "../tz";
import type { DayHours } from "../schedule-math";
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

/** A day's own hours (0370, job_schedule_segments.start_time / end_time) as minutes past midnight, or
 *  null when the day has none (or they don't read as a start before an end). */
export function ownDayMinutes(h: DayHours | null | undefined): { startMin: number; endMin: number } | null {
  if (!h) return null;
  const startMin = readHm(h.start);
  const endMin = readHm(h.end);
  if (startMin == null || endMin == null || endMin <= startMin) return null;
  return { startMin, endMin };
}

/**
 * WHERE THE JOB SITS ON ONE DAY of the calendar, in minutes past the company's midnight.
 *
 *   its own hours (0370): a day that keeps its own hours (Herringbone added today, noon to 5, beside
 *               its other days) draws exactly those, on any day, in the plan or kept as history. The
 *               rest of this is the job's USUAL hours, for every day without its own:
 *   any day of the plan: its start to its stored end, AS TIMES OF DAY, on the first day, a middle day or
 *               the last (the end is stored on the last day; its clock time is the end on every day). A
 *               SIZED job whose stored end is just the closing-time stamp (every write before this fix)
 *               draws its size, never closing: the length somebody chose beats a time the writer made
 *               up. An older row with no end runs to closing, as it always drew. Start and end both on
 *               the work-day edges (and not sized shorter) is all day.
 *   outside:    a day outside the plan's span (a worked day kept as history) is full.
 */
export function jobDayBlock(p: {
  day: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  plannedMinutes?: number | null;
  tz: string;
  wd: WorkDayMin;
  /** The day's own hours, when it keeps them (null or absent: the job's usual hours). */
  dayHours?: DayHours | null;
}): { startMin: number; endMin: number; allDay: boolean } {
  const { day, tz, wd } = p;
  const own = ownDayMinutes(p.dayHours);
  if (own) return { ...own, allDay: own.startMin === wd.startMin && own.endMin === wd.endMin };
  const full = { startMin: wd.startMin, endMin: wd.endMin, allDay: true };
  if (!p.scheduledStart) return full;
  const first = todayStrInTz(tz, new Date(p.scheduledStart));
  const endDay = p.scheduledEnd ? todayStrInTz(tz, new Date(p.scheduledEnd)) : first;
  const last = endDay < first ? first : endDay;
  if (day < first || day > last) return full;

  const sized = Math.max(0, Number(p.plannedMinutes ?? 0) || 0);
  const startMin = tzMinutesOfDay(p.scheduledStart, tz);
  // The end's clock time is the end on EVERY day of the plan, whatever day it is stored on.
  const endOnDay = p.scheduledEnd ? tzMinutesOfDay(p.scheduledEnd, tz) : null;
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
  /** The end, on each of its days. */
  endHm: string;
  /** The day's length in minutes: the same on each of its days. */
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
  // The same hours on each of its days: the first day's block is every day's (multiDay is a label).
  const a = jobDayBlock({ day: first, scheduledStart: p.scheduledStart, scheduledEnd: p.scheduledEnd, plannedMinutes: p.plannedMinutes, tz: p.tz, wd });
  return {
    day: first,
    lastDay: last,
    multiDay: last !== first,
    allDay: a.allDay,
    startHm: minutesToHm(a.startMin),
    endHm: minutesToHm(Math.min(LAST_MINUTE, a.endMin)),
    minutes: Math.max(1, a.endMin - a.startMin),
    sized,
  };
}

/**
 * A VISIT'S BLOCK, in the same shape, for the same controls. A visit is its starts_at → ends_at, drawn
 * as an hour when it has no end (the calendar's rule), and that hour is the app's, not a person's
 * ("1 hour — change it"). A visit over several days is one span, its own rule: the first day from its
 * start, drawn as full days between.
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
 *  it", "All day", "4 hours". A job over several days reads the same: its hours are each day's. */
export function blockWords(b: Pick<JobBlock, "allDay" | "minutes" | "sized"> & { multiDay?: boolean }): string {
  const words = b.allDay ? "All day" : lengthWords(b.minutes);
  return b.sized ? words : `${words} — change it`;
}

/**
 * THE JOB'S BLOCK ON ONE DAY, IN WORDS: the day drill's line under a job, which must say what the grid
 * right above it draws on THAT day (jobDayBlock), never the plan's block printed on every day. A worked
 * day kept as history (outside the plan, or with no plan left) is drawn all day and reads as what it is:
 * "Worked day · planned Thu, Oct 1", or "Worked day · no day planned yet".
 */
export function dayBlockWords(p: {
  day: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  plannedMinutes?: number | null;
  tz: string;
  workDay: { start: string; end: string };
  /** The day's own hours (0370), when it keeps them. */
  dayHours?: DayHours | null;
}): { words: string; history: boolean } {
  const plan = readJobBlock(p);
  const history = !plan.day || p.day < plan.day || p.day > (plan.lastDay ?? plan.day);
  // A DAY WITH ITS OWN HOURS reads them, the way the grid draws it (a worked day kept as history
  // still says so).
  const own = ownDayMinutes(p.dayHours);
  if (own) {
    const hours = `${hmWords(minutesToHm(own.startMin))} – ${hmWords(minutesToHm(Math.min(LAST_MINUTE, own.endMin)))} · ${lengthWords(own.endMin - own.startMin)}`;
    return { words: history ? `Worked day · ${hours}` : hours, history };
  }
  if (!plan.day) return { words: "Worked day · no day planned yet", history: true };
  if (p.day < plan.day || p.day > (plan.lastDay ?? plan.day)) return { words: `Worked day · planned ${dayWords(plan.day)}`, history: true };
  // On any day of the plan: the job's hours, the same on each of its days.
  const b = jobDayBlock({ ...p, wd: workDayMinutes(p.workDay) });
  return {
    words: `${hmWords(minutesToHm(b.startMin))} – ${hmWords(minutesToHm(Math.min(LAST_MINUTE, b.endMin)))} · ${blockWords({ allDay: b.allDay, minutes: Math.max(1, b.endMin - b.startMin), sized: plan.sized })}`,
    history: false,
  };
}

/**
 * WHAT A SCHEDULE WRITE STORES FOR THE TIMES. Three intents each, like the writer's start time always had:
 *
 *   startTime  undefined keep the start the job has · "HH:MM" set it · null/"" all day (the old
 *              "clear the time")
 *   length     undefined keep the length the job has · minutes set it (and planned_minutes) · "full"
 *              the company's whole day (planned_minutes = one working day)
 *
 * Keeping the length means (keptEndMin): the clock length of the timed block the job already has on its
 * day (never the closing-time stamp older writes put on every end); else the size somebody chose; else
 * all day when it was all day and nothing new was asked of it; else, a job getting a day and a time for
 * the first time with no length, the two-hour DEFAULT (planned_minutes left blank). A length in minutes
 * on one day is its clock length, and it stores at most one working day as planned_minutes (the work
 * load). Several days take the same hours on each day (the end is stored on the last day, at the
 * clock time each day ends); their size keeps what was asked (the work load of several days). The one
 * exception: a window of several days with nothing chosen at all, no start, no length and no block
 * before, is full days, since the days themselves were the choice. `plannedMinutes` undefined = leave
 * the column alone.
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
  /** The block's clock minutes, when a length came in minutes (a chip, or the End box). */
  let clockMinutes: number | undefined;
  const numeric = typeof p.length === "number" && Number.isFinite(p.length) && p.length > 0;
  if (p.length === "full" || (clearsTime && p.length === undefined)) {
    startMin = wd.startMin;
    if (p.length === "full" && !multiDay) plannedMinutes = WORK_DAY_MINUTES;
  } else if (numeric) {
    clockMinutes = Math.min(60 * 24 * 30, Math.round(p.length as number));
    // ONE DAY'S CLOCK IS NOT THE JOB'S LOAD. planned_minutes is a work-load figure (WORK_DAY_MINUTES is
    // one working day, and a placement lands ceil(size / that) days), so one day's block is never
    // stored as more than a day: 8:00 to 5:00 PM typed into the End box is 540 on the clock and one
    // day of work, the same 480 the Full Day chip stores. Several days keep what was asked.
    plannedMinutes = multiDay ? clockMinutes : Math.min(clockMinutes, WORK_DAY_MINUTES);
  }
  startMin = Math.min(startMin, LAST_MINUTE - 1);

  // A WINDOW OF SEVERAL DAYS WITH NOTHING ELSE CHOSEN is full days: the days were the choice.
  const bareWindow = multiDay && !hadDay && typedStart == null && !clearsTime && p.length === undefined;

  let endMin: number;
  let defaulted = false;
  if (p.length === "full" || (clearsTime && p.length === undefined) || bareWindow) {
    startMin = wd.startMin;
    endMin = wd.endMin;
  } else if (clockMinutes !== undefined) {
    endMin = startMin + clockMinutes;
  } else {
    const kept = keptEndMin({ startMin, typedStart: typedStart != null, before: hadDay ? before : null, plannedMinutes: sized, wd });
    endMin = kept.endMin;
    defaulted = kept.defaulted;
  }
  endMin = Math.max(startMin + 1, Math.min(LAST_MINUTE, endMin));
  // The end lands on the LAST day: its clock time is the end on each day (jobDayBlock).
  return {
    startIso: tzDateTimeUtc(firstDay, minutesToHm(startMin), p.tz),
    endIso: tzDateTimeUtc(lastDay, minutesToHm(endMin), p.tz),
    ...(plannedMinutes !== undefined ? { plannedMinutes } : {}),
    defaulted,
  };
}

/**
 * WHERE A ONE-DAY BLOCK ENDS WHEN NOBODY GAVE IT A NEW LENGTH: a move (the same start on a new day), a
 * new start typed in, or a placement at a chosen time. The writer (planJobTimes) and the Start box
 * (components/block-time-controls, the end it shows before the save comes back) both ask THIS, so the
 * screen never predicts an end the save won't store.
 *
 *   A TIMED BLOCK KEEPS ITS CLOCK LENGTH: 7:00–4:00 PM moved is 7:00–4:00 PM, 10–12 moved to 1 PM is
 *   1–3, whatever the size says (the size is the work load, not the block).
 *   Except an end that is only CLOSING TIME. Every write before 2026-09-28 stamped the end at closing
 *   whatever the length (J-058: 10:00 AM to the 5 PM stamp, unsized), so that end is not a length
 *   anybody chose:
 *     sized a day or more  → it still runs to closing from the new start;
 *     unsized, a new start → the two-hour default, said ("2 hours — change it"), never the stamp's
 *                            7 hours carried past closing to 9 PM.
 *   A block that was ALL DAY stays a full day on a move; a new start on it takes the size, else the
 *   two-hour default. No block before: the size, else the two-hour default. A block over several days
 *   is judged the same as one day's: its hours are each day's.
 */
export function keptEndMin(p: {
  startMin: number;
  /** A start time was given (typed, or the placement's chosen time), not just kept. */
  typedStart: boolean;
  /** The block as it stands, or null when the job had no day. */
  before: Pick<JobBlock, "multiDay" | "allDay" | "endHm" | "minutes"> | null;
  /** planned_minutes (0 = nobody sized it). */
  plannedMinutes: number;
  wd: WorkDayMin;
}): { endMin: number; defaulted: boolean } {
  const { startMin, before, wd } = p;
  const sized = Math.max(0, Number(p.plannedMinutes) || 0);
  const toClosing = (s: number) => (wd.endMin > s ? wd.endMin : s + 60);
  if (before && !before.allDay) {
    const endsAtClosing = readHm(before.endHm) === wd.endMin;
    if (endsAtClosing && sized >= WORK_DAY_MINUTES) return { endMin: toClosing(startMin), defaulted: false };
    if (endsAtClosing && sized === 0 && p.typedStart) return { endMin: startMin + DEFAULT_JOB_MINUTES, defaulted: true };
    return { endMin: startMin + before.minutes, defaulted: false };
  }
  if (sized > 0) return { endMin: sized >= WORK_DAY_MINUTES ? toClosing(startMin) : startMin + sized, defaulted: false };
  // It was all day and nothing new was asked of it: its day stays a full day.
  if (before && !p.typedStart) return { endMin: toClosing(startMin), defaulted: false };
  return { endMin: startMin + DEFAULT_JOB_MINUTES, defaulted: true };
}

/** The end a length gives a start, as "HH:MM" on the same day (clamped before midnight). */
export function endAfter(startHm: string, minutes: number): string {
  const s = readHm(startHm) ?? 8 * 60;
  return minutesToHm(Math.min(LAST_MINUTE, s + Math.max(1, Math.round(minutes))));
}
