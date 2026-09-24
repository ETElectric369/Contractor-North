/** Pure date-range math for a job's schedule segments (yyyy-mm-dd, inclusive).
 *  Extracted so the calendar's move/place gestures are unit-tested without a
 *  database — setJobScheduleRanges REPLACES all segments wholesale, so every
 *  caller must compute the FULL new set (read-modify-write) and these functions
 *  are that computation. All arithmetic runs at UTC midnight (a bare yyyy-mm-dd
 *  parses as UTC), so DST can never grow or shrink a day. */

export type DaySegment = { start: string; end: string }; // yyyy-mm-dd each, inclusive

const DAY_MS = 86_400_000;

const isYmd = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const toYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ymd: string, days: number) => toYmd(toMs(ymd) + days * DAY_MS);

/** Drop malformed rows, right inverted ones (end before start → one day), sort by start. */
function normalize(segments: DaySegment[]): DaySegment[] {
  return (segments ?? [])
    .filter((s) => isYmd(s?.start) && isYmd(s?.end))
    .map((s) => (s.end < s.start ? { start: s.start, end: s.start } : { start: s.start, end: s.end }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Coalesce overlapping or adjacent (end + 1 day = next start) segments into one. */
export function mergeSegments(segments: DaySegment[]): DaySegment[] {
  const out: DaySegment[] = [];
  for (const seg of normalize(segments)) {
    const last = out[out.length - 1];
    if (last && toMs(seg.start) <= toMs(last.end) + DAY_MS) {
      if (seg.end > last.end) last.end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
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
  const sorted = normalize(segments);
  if (!sorted.length) return [{ start: toDate, end: toDate }];
  let idx = isYmd(fromDate) ? sorted.findIndex((s) => s.start <= fromDate && fromDate <= s.end) : 0;
  if (idx < 0) idx = 0; // fromDate covered by nothing (stale mirror day) — move the earliest
  const seg = sorted[idx];
  const durationDays = (toMs(seg.end) - toMs(seg.start)) / DAY_MS;
  const moved = { start: toDate, end: addDays(toDate, durationDays) };
  return mergeSegments([...sorted.filter((_, i) => i !== idx), moved]);
}

/** PLACE: union a single day into the existing segments — never drops anything
 *  (a needs-return job keeps its worked-history ranges on the calendar). */
export function addDaySegment(segments: DaySegment[], dateISO: string): DaySegment[] {
  return mergeSegments([...(segments ?? []), { start: dateISO, end: dateISO }]);
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
 *  computed only from the new window erases every past day the job sat on. Herringbone,
 *  2026-09-24: Nort moved it to the 24th and the 22nd vanished from the calendar though time had
 *  been logged there that day. The calendar is also the job's history, so a day that was
 *  scheduled AND worked (time logged, a visit held) stays; only the rest moves.
 *
 *  `worked` is the days work happened; only those on or before `today` count (a later visit is a
 *  plan, not history). A worked day is kept only when it was ON the old schedule and the new one
 *  no longer covers it. A day that was never scheduled is not added (the move shouldn't invent a
 *  range), and a past day that was scheduled but NOT worked moves like any other: nobody went. */
export function keepWorkedDays(
  before: DaySegment[],
  after: DaySegment[],
  worked: string[],
  today: string,
): { segments: DaySegment[]; kept: string[] } {
  const prior = normalize(before);
  const next = normalize(after);
  const covers = (segs: DaySegment[], d: string) => segs.some((s) => s.start <= d && d <= s.end);
  const kept = [...new Set((worked ?? []).filter(isYmd))]
    .filter((d) => d <= today && covers(prior, d) && !covers(next, d))
    .sort();
  return { segments: mergeSegments([...next, ...kept.map((d) => ({ start: d, end: d }))]), kept };
}
