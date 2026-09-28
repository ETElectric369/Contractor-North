/**
 * EACH DAY KEEPS ITS OWN HOURS (0370). Pure: the writers (schedule/actions addJobDay, setJobDayTimes,
 * writeScheduleRanges) and the controls that predict them (the schedule tile's This Day time, the Add
 * To Schedule sheet) ask these, so a screen never promises hours the save won't store.
 *
 * Erik, 2026-09-28, on the Schedule page at night: "i want to put heringbone on the page for the rest
 * of the day after Seiler". Herringbone runs 9/18, 9/22 and 9/24; a job had ONE time of day for every
 * day, so its new day could only land at the job's usual hours. A day of job_schedule_segments now
 * carries start_time / end_time (company wall clock): null is the job's usual hours (today's
 * behavior), set is that day's own.
 *
 *   dayHoursOf       minutes → the "HH:MM" pair a segment stores (the end never past 23:59).
 *   nextDayHours     one day's new hours from a new start (the length stays, the writer's keep rule)
 *                    or a new length (1h 2h 4h, an End time, Full Day).
 *   freezeDrawnDays  adding a day grows the job's span (its first day now runs to closing, a middle
 *                    day is full): every OTHER day whose drawn block that would change keeps the
 *                    block it had, as its own hours. Adding a day never moves another.
 */
import type { DayHours, DaySegment } from "../schedule-math";
import { hoursOnDay, segmentDays, setDayHours } from "../schedule-math";
import { minutesToHm } from "./fit-day";
import { jobDayBlock, keptEndMin, readHm, type JobLength, type WorkDayMin } from "./job-block";

const LAST_MINUTE = 23 * 60 + 59;

/** Minutes past midnight → the pair a day stores: the end after the start, never past 23:59. */
export function dayHoursOf(startMin: number, endMin: number): DayHours {
  const s = Math.max(0, Math.min(LAST_MINUTE - 1, Math.round(startMin)));
  const e = Math.max(s + 1, Math.min(LAST_MINUTE, Math.round(endMin)));
  return { start: minutesToHm(s), end: minutesToHm(e) };
}

/** A day's hours as stored ("12:00:00" from Postgres' time type) → "HH:MM", or null when the pair
 *  isn't a start before an end. */
export function readDayHours(start: unknown, end: unknown): DayHours | null {
  const s = readHm(typeof start === "string" ? start : null);
  const e = readHm(typeof end === "string" ? end : null);
  if (s == null || e == null || e <= s) return null;
  return { start: minutesToHm(s), end: minutesToHm(e) };
}

/**
 * ONE DAY'S NEW HOURS. `before` is the block the day draws now (jobDayBlock, its own hours or the
 * job's usual); `own` says whether those were already the day's own.
 *
 *   { start }   the length stays: the writer's keep rule (job-block keptEndMin), with the day's own
 *               length as its size when it has its own hours, else the job's size. The same inputs
 *               the Start box predicts with (components/block-time-controls commitStart).
 *   { length }  minutes from the start it has; "full" is the company's whole work day.
 */
export function nextDayHours(p: {
  before: { startMin: number; endMin: number; allDay: boolean };
  own: boolean;
  /** The job's size (planned_minutes), null when nobody sized it. */
  plannedMinutes: number | null;
  patch: { start: string } | { length: JobLength };
  wd: WorkDayMin;
}): DayHours | null {
  const { before, wd } = p;
  const minutes = Math.max(1, before.endMin - before.startMin);
  if ("start" in p.patch) {
    const s = readHm(p.patch.start);
    if (s == null) return null;
    const kept = keptEndMin({
      startMin: s,
      typedStart: true,
      before: { multiDay: false, allDay: before.allDay, endHm: minutesToHm(Math.min(LAST_MINUTE, before.endMin)), minutes },
      plannedMinutes: p.own ? minutes : Math.max(0, Number(p.plannedMinutes ?? 0) || 0),
      wd,
    }).endMin;
    return dayHoursOf(s, kept);
  }
  const length = p.patch.length;
  if (length === "full") return dayHoursOf(wd.startMin, wd.endMin);
  const n = Number(length);
  if (!Number.isFinite(n) || n < 1) return null;
  return dayHoursOf(before.startMin, before.startMin + Math.round(n));
}

type Mirror = { scheduledStart: string | null; scheduledEnd: string | null; plannedMinutes: number | null };

/**
 * ADDING A DAY NEVER MOVES ANOTHER. The job's span (jobs.scheduled_start/end) grows to cover a day
 * added to it, and the usual hours of a span are drawn by where a day sits in it (the first from the
 * start to closing, a middle day full, the last from the opening to the end: job-block jobDayBlock).
 * So Seiler's one day 10 to 12 would draw 10 to 5 the moment a second day joins it. Every day of
 * `segments` that keeps no hours of its own, and whose drawn block changes from `before` to `after`,
 * gets the block it had as its own hours. `skip` (the day being added) is left as it is.
 */
export function freezeDrawnDays(p: {
  segments: DaySegment[];
  before: Mirror;
  after: Mirror;
  tz: string;
  wd: WorkDayMin;
  skip?: string[];
}): { segments: DaySegment[]; frozen: string[] } {
  let segs = p.segments;
  const frozen: string[] = [];
  const skip = new Set(p.skip ?? []);
  for (const day of segmentDays(p.segments)) {
    if (skip.has(day) || hoursOnDay(p.segments, day)) continue;
    const was = jobDayBlock({ day, ...p.before, tz: p.tz, wd: p.wd });
    const will = jobDayBlock({ day, ...p.after, tz: p.tz, wd: p.wd });
    if (was.startMin === will.startMin && was.endMin === will.endMin) continue;
    segs = setDayHours(segs, day, dayHoursOf(was.startMin, was.endMin));
    frozen.push(day);
  }
  return { segments: segs, frozen };
}
