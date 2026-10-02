/** Pure date-range math for a job's schedule segments (yyyy-mm-dd, inclusive).
 *  Extracted so the calendar's move/place gestures are unit-tested without a
 *  database — setJobScheduleRanges REPLACES all segments wholesale, so every
 *  caller must compute the FULL new set (read-modify-write) and these functions
 *  are that computation. All arithmetic runs at UTC midnight (a bare yyyy-mm-dd
 *  parses as UTC), so DST can never grow or shrink a day.
 *
 *  EACH DAY KEEPS ITS OWN HOURS (0370). A range may carry `hours`: the wall-clock start and end its
 *  days run on the company's clock (job_schedule_segments.start_time / end_time). Three states, like
 *  the writers' start time always had:
 *    hours: { start, end }  the days' OWN hours (Honeysuckle added today, noon to 5, beside its
 *                           other days);
 *    hours: null            the job's USUAL hours (its scheduled_start/end block), today's behavior;
 *    hours absent           not said: a writer carries over whatever those days already had
 *                           (carryHours), so a rewrite never drops a day's hours.
 *  Every function here keeps a range's hours with it: a moved range lands with its own hours, a kept
 *  worked day keeps the hours it ran, and two neighbouring ranges only merge when their hours match. */

import { todayStrInTz } from "./tz";

/** A day's own hours on the company's clock ("HH:MM" each, end after start). */
export type DayHours = { start: string; end: string };

export type DaySegment = { start: string; end: string; hours?: DayHours | null }; // yyyy-mm-dd each, inclusive

const DAY_MS = 86_400_000;

const isYmd = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const toYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ymd: string, days: number) => toYmd(toMs(ymd) + days * DAY_MS);

/** Which hours a range carries, as a key: two ranges merge only when their keys match. */
const hoursKey = (h: DayHours | null | undefined) => (h === undefined ? "~" : h === null ? "-" : `${h.start}-${h.end}`);

/** The same range's hours on other dates (absent stays absent, never an `hours: undefined` key). */
function withHours(s: DaySegment, start: string, end: string): DaySegment {
  return s.hours === undefined ? { start, end } : { start, end, hours: s.hours };
}

/** Well-formed ranges only, an inverted one righted to its first day. INPUT ORDER is kept: a later
 *  range's hours win the days it shares with an earlier one. */
function clean(segments: DaySegment[]): DaySegment[] {
  return (segments ?? [])
    .filter((s) => isYmd(s?.start) && isYmd(s?.end))
    .map((s) => (s.end < s.start ? withHours(s, s.start, s.start) : withHours(s, s.start, s.end)));
}

/** Drop malformed rows, right inverted ones (end before start → one day), sort by start. */
function normalize(segments: DaySegment[]): DaySegment[] {
  return clean(segments).sort((a, b) => a.start.localeCompare(b.start));
}

/** Lay `top` over `base`: the days `top` covers leave whatever range held them (split around it). */
function overlay(base: DaySegment[], top: DaySegment): DaySegment[] {
  const out: DaySegment[] = [];
  for (const b of base) {
    if (b.end < top.start || b.start > top.end) {
      out.push(b);
      continue;
    }
    if (b.start < top.start) out.push(withHours(b, b.start, addDays(top.start, -1)));
    if (b.end > top.end) out.push(withHours(b, addDays(top.end, 1), b.end));
  }
  out.push(top);
  return out;
}

/** Sort, then join ranges that touch or overlap AND carry the same hours. */
function coalesce(segments: DaySegment[]): DaySegment[] {
  const out: DaySegment[] = [];
  for (const seg of [...segments].sort((a, b) => a.start.localeCompare(b.start))) {
    const last = out[out.length - 1];
    if (last && hoursKey(last.hours) === hoursKey(seg.hours) && toMs(seg.start) <= toMs(last.end) + DAY_MS) {
      if (seg.end > last.end) last.end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/** Coalesce overlapping or adjacent (end + 1 day = next start) segments into one. The union of every
 *  day stays; where two ranges share a day with DIFFERENT hours, the later one in the list wins that
 *  day (the other is split around it), and ranges only join when their hours match. */
export function mergeSegments(segments: DaySegment[]): DaySegment[] {
  let laid: DaySegment[] = [];
  for (const seg of clean(segments)) laid = overlay(laid, seg);
  return coalesce(laid);
}

/** The hours on `day`: its own ({ start, end }), the job's usual (null), or undefined when no range
 *  covers the day (or the range never said). The last range covering it wins, as in mergeSegments. */
export function hoursOnDay(segments: DaySegment[], day: string): DayHours | null | undefined {
  let found: DayHours | null | undefined = undefined;
  for (const s of clean(segments)) if (s.start <= day && day <= s.end) found = s.hours;
  return found;
}

/** Is `day` one of these days? */
export function coversDay(segments: DaySegment[], day: string): boolean {
  return clean(segments).some((s) => s.start <= day && day <= s.end);
}

/** ONE DAY's hours set (its own, or null for the job's usual), the rest of the days untouched. The day
 *  joins the days when it wasn't one of them. */
export function setDayHours(segments: DaySegment[], day: string, hours: DayHours | null): DaySegment[] {
  if (!isYmd(day)) return mergeSegments(segments);
  return mergeSegments([...(segments ?? []), { start: day, end: day, hours }]);
}

/** Every day the ranges cover, sorted, at most `cap` of them (a runaway range can't hang a writer). */
export function segmentDays(segments: DaySegment[], cap = 400): string[] {
  const days = new Set<string>();
  for (const s of normalize(segments)) {
    for (let d = s.start; d <= s.end && days.size < cap; d = addDays(d, 1)) days.add(d);
    if (days.size >= cap) break;
  }
  return [...days].sort();
}

/** The days alone, merged as dates (hours set aside): the job page's range editor shows a job's days
 *  as the ranges a person made, not split wherever one day has its own hours. */
export function datesOnly(segments: DaySegment[]): DaySegment[] {
  return mergeSegments(clean(segments).map((s) => ({ start: s.start, end: s.end })));
}

/**
 * CARRY THE HOURS THROUGH A REWRITE. A writer that was handed ranges with no hours said (the job
 * page's range editor, Nort's window) gets, for each of their days, the hours that day already had in
 * `prior` (the segments as they stand), and the job's usual hours (null) for a day that had none.
 * Ranges that said their hours keep them. Every range that comes back says its hours.
 */
export function carryHours(ranges: DaySegment[], prior: DaySegment[]): DaySegment[] {
  const own = clean(prior).filter((p) => !!p.hours);
  const out: DaySegment[] = [];
  for (const r of clean(ranges)) {
    if (r.hours !== undefined) {
      out.push(r);
      continue;
    }
    let parts: DaySegment[] = [{ start: r.start, end: r.end, hours: null }];
    for (const p of own) {
      if (p.end < r.start || p.start > r.end) continue;
      parts = overlay(parts, { start: p.start > r.start ? p.start : r.start, end: p.end < r.end ? p.end : r.end, hours: p.hours });
    }
    out.push(...parts);
  }
  return mergeSegments(out);
}

/** MOVE: shift the segment covering fromDate (or the earliest/only one when
 *  fromDate is null or covers nothing) so it STARTS on toDate, preserving its
 *  length in days. Every other segment is untouched; a shift that lands on or
 *  next to another range merges with it. Empty input just lands on toDate as a
 *  one-day window — a dateless job's "move" is a place. */
export function shiftSegmentCovering(
  segments: DaySegment[],
  fromDate: string | null,
  toDate: string,
): DaySegment[] {
  // No worked days: the whole range moves at full length (the move verbs pass the worked days).
  return moveKeepingWorkedDays(segments, fromDate, toDate, [], "").segments;
}

/** PLACE: union a single day into the existing segments — never drops anything
 *  (a needs-return job keeps its worked-history ranges on the calendar). `hours` is the day's:
 *  its own, null for the job's usual hours, or left out (not said). */
export function addDaySegment(segments: DaySegment[], dateISO: string, hours?: DayHours | null): DaySegment[] {
  const day: DaySegment = hours === undefined ? { start: dateISO, end: dateISO } : { start: dateISO, end: dateISO, hours };
  return mergeSegments([...(segments ?? []), day]);
}

/** TAKE ONE DAY OFF: the range holding it is split around it (a day in the middle of a range leaves
 *  the days before and the days after), every other range and every day's hours untouched. The undo of
 *  a worked day booked after the fact (unbookWorkedDay): it removes that day and only that day, never
 *  replacing the whole set from a client's snapshot. A day no range covers changes nothing. */
export function removeDaySegment(segments: DaySegment[], dateISO: string): DaySegment[] {
  if (!isYmd(dateISO)) return mergeSegments(segments);
  const out: DaySegment[] = [];
  for (const s of clean(segments)) {
    if (s.end < dateISO || s.start > dateISO) {
      out.push(s);
      continue;
    }
    if (s.start < dateISO) out.push(withHours(s, s.start, addDays(dateISO, -1)));
    if (s.end > dateISO) out.push(withHours(s, addDays(dateISO, 1), s.end));
  }
  return mergeSegments(out);
}

/** EDIT one bound of a range without ever inverting it: the edited bound wins
 *  and the other bound follows when crossed (start moved past end drags end up;
 *  end moved before start drags start back). Same-day (start === end) is a
 *  valid one-day job, so "follow" means match, not +1. Blank or partial bounds
 *  pass through untouched — a half-filled row isn't saved anyway.
 *
 *  Why: the range editor saves on every change, so pushing a job later by
 *  editing the start FIRST used to trip an "ends before it starts" error and
 *  block the save (bug report: "Date range can't finish before start"). */
export function applyRangeEdit(current: DaySegment, patch: Partial<DaySegment>): DaySegment {
  const next = { ...current, ...patch };
  if (!isYmd(next.start) || !isYmd(next.end) || next.start <= next.end) return next;
  if (patch.end !== undefined && patch.start === undefined) {
    return { start: next.end, end: next.end }; // end pulled back → start follows
  }
  return { start: next.start, end: next.start }; // start pushed forward (or both set inverted) → end follows
}

/** KEEP THE DAYS THAT HAPPENED. A reschedule writes the job's whole segment set, so a move
 *  computed only from the new window erases every past day the job sat on. Honeysuckle,
 *  2026-09-24: Nort moved it to the 24th and the 22nd vanished from the calendar though time had
 *  been logged there that day. The calendar is also the job's history, so a day that was
 *  scheduled AND worked (time logged, a visit closed out as done) stays; only the rest moves.
 *
 *  `worked` is the days work happened; only those on or before `today` count (a later visit is a
 *  plan, not history). A worked day is kept only when it was ON the old schedule and the new one
 *  no longer covers it. A day that was never scheduled is not added (the move shouldn't invent a
 *  range), and a past day that was scheduled but NOT worked moves like any other: nobody went.
 *
 *  `mirror` is the span of the PLAN alone (`after`), for the jobs.scheduled_start/end mirror. A
 *  kept day is history, not where the job is headed: with it in the mirror, the job's listed
 *  start (the Jobs list, Nort's "what's on the 24th", the Google event) would read as the old
 *  day. Null when the plan is empty. */
export function keepWorkedDays(
  before: DaySegment[],
  after: DaySegment[],
  worked: string[],
  today: string,
): { segments: DaySegment[]; kept: string[]; mirror: DaySegment | null } {
  const prior = normalize(before);
  const next = clean(after);
  const covers = (segs: DaySegment[], d: string) => segs.some((s) => s.start <= d && d <= s.end);
  const kept = [...new Set((worked ?? []).filter(isYmd))]
    .filter((d) => d <= today && covers(prior, d) && !covers(next, d))
    .sort();
  const mirror = next.length
    ? {
        start: next.reduce((m, s) => (s.start < m ? s.start : m), next[0].start),
        end: next.reduce((m, s) => (s.end > m ? s.end : m), next[0].end),
      }
    : null;
  // A kept day keeps the hours it ran (its range's, as it stood).
  const keptDays = kept.map((d) => {
    const h = hoursOnDay(prior, d);
    return h === undefined ? { start: d, end: d } : { start: d, end: d, hours: h };
  });
  return { segments: mergeSegments([...next, ...keptDays]), kept, mirror };
}

/** MOVE, KEEPING THE PAST. The move verbs' version of shiftSegmentCovering: the range covering
 *  fromDate moves to start on toDate, but its WORKED days (on or before `today`) stay where they
 *  happened, and only the unworked remainder travels. A 3-day range with 2 days worked moves as 1
 *  day, so the job never ends up with more days than it had. A range that was worked in full
 *  still moves as one day: moving it says the work goes on, and that day is new.
 *
 *  With no fromDate (or one covering nothing) the range picked is the earliest one that still
 *  has an unworked day, not simply the earliest: after a kept day, the earliest range is history,
 *  and "push the job to Friday" means the plan. */
export function moveKeepingWorkedDays(
  segments: DaySegment[],
  fromDate: string | null,
  toDate: string,
  worked: string[],
  today: string,
): {
  segments: DaySegment[];
  kept: string[];
  mirror: DaySegment | null;
  moved: DaySegment;
  /** How many days the moved range had before, and how many of them were worked. */
  rangeDays: number;
  workedInRange: number;
} {
  const sorted = normalize(segments);
  if (!sorted.length) {
    const moved = { start: toDate, end: toDate };
    return { segments: [moved], kept: [], mirror: moved, moved, rangeDays: 0, workedInRange: 0 };
  }
  const workedSet = new Set((worked ?? []).filter(isYmd).filter((d) => d <= today));
  const daysOf = (s: DaySegment) => (toMs(s.end) - toMs(s.start)) / DAY_MS + 1;
  const workedIn = (s: DaySegment) => [...workedSet].filter((d) => s.start <= d && d <= s.end).length;
  let idx = isYmd(fromDate) ? sorted.findIndex((s) => s.start <= fromDate && fromDate <= s.end) : -1;
  if (idx < 0) idx = sorted.findIndex((s) => workedIn(s) < daysOf(s));
  if (idx < 0) idx = 0;
  const seg = sorted[idx];
  const rangeDays = daysOf(seg);
  const workedInRange = workedIn(seg);
  const remaining = Math.max(1, rangeDays - workedInRange);
  // A MOVE KEEPS THE BLOCK: the range lands with the hours it had (its own, or the usual).
  const moved = withHours(seg, toDate, addDays(toDate, remaining - 1));
  const after = mergeSegments([...sorted.filter((_, i) => i !== idx), moved]);
  return { ...keepWorkedDays(sorted, after, [...workedSet], today), moved, rangeDays, workedInRange };
}

/** WHAT COUNTS AS WORKED, as org-timezone dates: a time entry clocked in that day, or a visit
 *  closed out as done ("completed"). A past visit still marked "scheduled" is NOT proof: nobody
 *  closed it out, which is as likely to mean nobody went (the My Day inbox feeds on exactly
 *  those), and the visit keeps its own place on the calendar either way. Calling it worked would
 *  also word it as "work was done that day" and pin the day so no move could ever take it off. */
export function workedDaysFrom(
  entries: { clock_in: string | null }[],
  visits: { starts_at: string | null; status: string | null }[],
  tz: string,
): string[] {
  const days = new Set<string>();
  for (const e of entries ?? []) if (e?.clock_in) days.add(todayStrInTz(tz, new Date(e.clock_in)));
  for (const v of visits ?? []) {
    if (v?.starts_at && v.status === "completed") days.add(todayStrInTz(tz, new Date(v.starts_at)));
  }
  return [...days].sort();
}
