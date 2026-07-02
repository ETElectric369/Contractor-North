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
