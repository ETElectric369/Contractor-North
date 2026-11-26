/**
 * THE JOB PAGE'S DATE RANGE ROWS: WHAT IS SENT, AND WHAT WAITS (cn-v1189). The owner, from a job's
 * page: "Add date range should wait and require a range before auto saving right now it won't even let
 * me add the second day". A row picked one day at a time was saved the instant its first day was
 * picked, as a one-day range, before the last day was ever touched.
 *
 *   A row is READY when both its days are set: only ready rows are ever sent.
 *   A row with one day WAITS: "needsLast" (a first day only; One Day sets the last day to it) or
 *   "needsFirst" (a last day only). A row with neither is "blank".
 *   The server's answer is what is stored: the saved rows become those ranges, and every row that was
 *   still waiting stays on screen as it was (never thrown away, never sent).
 * Pure: no React, no database.
 */

import { applyRangeEdit, coversDay, mergeSegments, type DayHours } from "@/lib/schedule-math";
import { nextDayHours, ownOrUsual, readDayHours } from "@/lib/schedule/day-hours";
import { ownDayMinutes, readHm, type JobLength, type WorkDayMin } from "@/lib/schedule/job-block";

/** A row: its two days and, when said, its hours (cn-v1190): `{ start, end }` "HH:MM" of its own, or
 *  null for the job's usual hours. Absent: not said (a writer keeps each day's hours as they are). */
export type RangeRow = {
  start: string;
  end: string;
  hours?: DayHours | null;
  /** TOUCHED (skeptic #91 S1): the person changed this row's days or hours, or the row is new, since the
   *  page loaded or the last answer the rows were re-seeded from. Only a touched row sends its hours. */
  touched?: boolean;
};

/** The row's hours (absent stays absent) and its touched flag carried onto a new pair of days. */
const keepHours = (from: RangeRow, to: { start: string; end: string }): RangeRow => ({
  start: to.start,
  end: to.end,
  ...(from.hours !== undefined ? { hours: from.hours } : {}),
  ...(from.touched ? { touched: true } : {}),
});
export type RowState = "ready" | "needsLast" | "needsFirst" | "blank";

/** A day is set only when it is a whole date from the year 2000 on: a browser that fires a change for
 *  each digit typed into the year (0002, 0020, 0202, 2026) never has a range from year 2 saved. */
const isYmd = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "") && (s as string).slice(0, 4) >= "2000";

/** One box edited. A ready row whose box is emptied keeps its days (a saved range is taken off only by
 *  the remove control, never by an emptied box the next save would drop). A day not yet set (a year
 *  before 2000, mid-typing) lands in its box as typed and drags nothing; the row waits. Otherwise the
 *  edited day wins and the other follows when crossed (schedule-math applyRangeEdit). */
export function editRow(r: RangeRow, patch: Partial<RangeRow>): RangeRow {
  const v = patch.start ?? patch.end;
  if (v === "" && rowState(r) === "ready") return r;
  if (v && !isYmd(v)) return { ...r, ...patch, touched: true };
  // The row's hours ride with it, whichever day was moved (cn-v1190); days that changed touch it.
  const moved = applyRangeEdit({ start: r.start, end: r.end }, patch);
  const out = keepHours(r, moved);
  return moved.start !== r.start || moved.end !== r.end ? { ...out, touched: true } : out;
}

export function rowState(r: RangeRow): RowState {
  const a = isYmd(r.start);
  const b = isYmd(r.end);
  if (a && b) return "ready";
  if (a) return "needsLast";
  if (b) return "needsFirst";
  return "blank";
}

/** Rows in; the ranges to save (the ready rows, an inverted legacy row righted to its first day) and
 *  the rows still waiting (every row that is not ready, in order) out. */
export function rangesToSave(rows: RangeRow[]): { save: RangeRow[]; waiting: RangeRow[] } {
  const save: RangeRow[] = [];
  const waiting: RangeRow[] = [];
  for (const r of rows) {
    if (rowState(r) === "ready") save.push(keepHours(r, r.end < r.start ? { start: r.start, end: r.start } : { start: r.start, end: r.end }));
    else waiting.push(r);
  }
  return { save, waiting };
}

/** One Day on a row with a first day only: its last day is its first. */
export function oneDay(r: RangeRow): RangeRow {
  return rowState(r) === "needsLast" ? { ...keepHours(r, { start: r.start, end: r.start }), touched: true } : r;
}

/**
 * WHAT THE SAVE SENDS (skeptic #91 S1): the ready rows, and the hours ONLY on a touched row (the hours
 * the person saw on it: its own, or null for the usual). An untouched row goes without the field, so the
 * writer keeps each of its days' stored hours exactly (schedule-math carryHours): a page loaded before
 * someone set a day's hours elsewhere never wipes them. The flag itself never goes.
 */
export function rowsToSend(rows: RangeRow[]): { start: string; end: string; hours?: DayHours | null }[] {
  return rangesToSave(rows).save.map((r) => (r.touched ? { start: r.start, end: r.end, hours: r.hours ?? null } : { start: r.start, end: r.end }));
}

/** The rows after a save's answer: the ranges as stored (nothing touched: they ARE what is stored), then
 *  the rows still waiting now. Never empty: a job with no days shows one blank row. */
export function reseedRows(stored: RangeRow[], now: RangeRow[]): RangeRow[] {
  const rows = [...stored.map((r) => keepHours({ ...r, touched: false }, r)), ...rangesToSave(now).waiting];
  return rows.length ? rows : [{ start: "", end: "" }];
}

/** When the stored ranges are fewer than the ranges sent because days touching were joined: the stored
 *  range that holds two or more of the sent ones (the first such). Null when nothing was joined. */
export function joinedRange(sent: RangeRow[], stored: RangeRow[]): RangeRow | null {
  // The same range sent twice is not two ranges joined (Snowbell, Dec 1 and Dec 1 stored as one).
  const seen = new Set<string>();
  sent = sent.filter((r) => {
    const k = `${r.start}|${r.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (stored.length >= sent.length) return null;
  for (const s of stored) {
    const inside = sent.filter((r) => r.start >= s.start && r.end <= s.end).length;
    if (inside >= 2) return s;
  }
  return null;
}

/** A range in the words the control already writes one with: "{first} to {last}", or the one day. */
export function rangeWords(r: RangeRow, day: (ymd: string) => string, to: string): string {
  return r.start === r.end ? day(r.start) : `${day(r.start)} ${to} ${day(r.end)}`;
}

/* ── EACH DATE RANGE HAS HOURS OF ITS OWN, AND EXTEND JOB (cn-v1190) ─────────────────────────────────
 * The owner: "im thinkin on add a date range to have its own time entry too that defaults to the hours
 * inputed for the first date range so i can change them if i want to", and "lets call it Extend Job
 * with date and time selector defaulted to today with the same hours", "yes today forward". */

/** The job's days as rows, from its segments as stored: each row says its hours (its own, or null for
 *  the job's usual). Neighbours with the same hours are one row, as the writer stores them; neighbours
 *  with different hours are two. */
export function rowsOfSegments(
  segs: readonly { start_date: string; end_date: string; start_time?: string | null; end_time?: string | null }[] | null | undefined,
): RangeRow[] {
  return mergeSegments(
    (segs ?? []).map((s) => ({ start: s.start_date, end: s.end_date, hours: readDayHours(s.start_time, s.end_time) })),
  ).map((r) => ({ start: r.start, end: r.end, hours: r.hours ?? null }));
}

/** The hours a row's time entry opens on: its own, else the job's usual. */
export function hoursShown(row: RangeRow, usual: DayHours): DayHours {
  return row.hours ?? usual;
}

/**
 * A ROW'S HOURS AFTER ONE CHANGE in its time entry (a new start, or a length: 1h 2h 4h, Full Day, an End).
 * The same rule the day's own hours follow on the Schedule (day-hours nextDayHours): a new start keeps
 * the length. Hours equal to the job's usual hours are no hours of its own (null): set back to the
 * usual, the range follows the job's time again. A change that reads as no time: `undefined`.
 */
export function rowHoursAfter(p: {
  row: RangeRow;
  usual: { startHm: string; endHm: string; allDay: boolean };
  plannedMinutes: number | null | undefined;
  patch: { start: string } | { length: JobLength };
  wd: WorkDayMin;
}): DayHours | null | undefined {
  const own = ownDayMinutes(p.row.hours ?? null);
  const before = own
    ? { ...own, allDay: own.startMin === p.wd.startMin && own.endMin === p.wd.endMin }
    : { startMin: readHm(p.usual.startHm) ?? p.wd.startMin, endMin: readHm(p.usual.endHm) ?? p.wd.endMin, allDay: p.usual.allDay };
  const next = nextDayHours({ before, own: !!own, plannedMinutes: p.plannedMinutes ?? null, patch: p.patch, wd: p.wd });
  if (!next) return undefined;
  return ownOrUsual(next, { start: p.usual.startHm, end: p.usual.endHm });
}

const DAY_MS = 86_400_000;
const nextYmd = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** Extend Job opens on: the day, the LATER of today and the day after the job's last day (skeptic #91
 *  S2: a job booked ahead is extended after its last day, never before its first; one finished in the
 *  past gets today; a gap is never offered); the hours, those of the job's LAST range (its own, else
 *  null: the usual). */
export function extendDefaults(rows: RangeRow[], today: string): { day: string; hours: DayHours | null } {
  const saved = rangesToSave(rows).save;
  const last = saved.reduce<RangeRow | null>((m, r) => (!m || r.end > m.end ? r : m), null);
  const after = last ? nextYmd(last.end) : today;
  return { day: after > today ? after : today, hours: last?.hours ?? null };
}

/** Why Extend Job's day can't be added, or null when it can: "pick" (no day, or a day before today),
 *  "has" (a day the job already has). */
export function extendRefusal(rows: RangeRow[], day: string, today: string): "pick" | "has" | null {
  if (!isYmd(day) || day < today) return "pick";
  if (coversDay(rangesToSave(rows).save, day)) return "has";
  return null;
}
