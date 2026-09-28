/**
 * READING A DAY'S OWN HOURS BEFORE 0370 IS APPLIED. The code deploys before Erik runs the migration,
 * and Postgres fails the WHOLE read when a select names a column it doesn't have, which takes a page
 * down rather than degrading. Every read of job_schedule_segments that wants the hours asks with
 * them, and only when the database says the columns are missing, again without them: then there is
 * no per-day editing and every day draws the job's usual hours (today's behavior), never an error
 * page. `perDayHours` says which it was.
 */
import { isMissingColumn } from "@/lib/job-tasks";
import type { DayHours } from "@/lib/schedule-math";
import { readDayHours } from "./day-hours";

/** The two columns 0370 adds, as a select-list tail. */
export const SEGMENT_HOURS_COLS = ", start_time, end_time";

/** A segment select list, with the hours or without (a plain string, so the typed client doesn't try to
 *  parse the two spellings as one). */
export function segmentCols(base: string, withHours: boolean): string {
  return withHours ? `${base}${SEGMENT_HOURS_COLS}` : base;
}

/** Run `query(true)` (the select with the hours); if the columns are missing, `query(false)`. */
export async function withDayHours<T extends { data: unknown; error: unknown }>(
  query: (withHours: boolean) => PromiseLike<T>,
): Promise<T & { perDayHours: boolean }> {
  const first = await query(true);
  if (first.error && isMissingColumn(first.error)) {
    const second = await query(false);
    return { ...second, perDayHours: false };
  }
  return { ...first, perDayHours: true };
}

/** A segment row as read, with or without the hours. */
export type SegmentRow = { job_id?: string | null; start_date: string; end_date: string; start_time?: string | null; end_time?: string | null };

/** The rows' own hours, by job and by day (only the days that keep their own). */
export function ownHoursByJobDay(rows: readonly SegmentRow[] | null | undefined, cap = 400): Map<string, Map<string, DayHours>> {
  const out = new Map<string, Map<string, DayHours>>();
  for (const r of rows ?? []) {
    const h = readDayHours(r.start_time, r.end_time);
    if (!h || !r.job_id || !/^\d{4}-\d{2}-\d{2}$/.test(r.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(r.end_date)) continue;
    const days = out.get(r.job_id) ?? new Map<string, DayHours>();
    const d = new Date(`${r.start_date}T00:00:00Z`);
    for (let i = 0; i < cap; i++) {
      const ymd = d.toISOString().slice(0, 10);
      if (ymd > r.end_date) break;
      days.set(ymd, h);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    out.set(r.job_id, days);
  }
  return out;
}
