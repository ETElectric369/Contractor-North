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

import { applyRangeEdit } from "@/lib/schedule-math";

export type RangeRow = { start: string; end: string };
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
  if (v && !isYmd(v)) return { ...r, ...patch };
  return applyRangeEdit(r, patch);
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
    if (rowState(r) === "ready") save.push(r.end < r.start ? { start: r.start, end: r.start } : { start: r.start, end: r.end });
    else waiting.push(r);
  }
  return { save, waiting };
}

/** One Day on a row with a first day only: its last day is its first. */
export function oneDay(r: RangeRow): RangeRow {
  return rowState(r) === "needsLast" ? { start: r.start, end: r.start } : r;
}

/** The rows after a save's answer: the ranges as stored, then the rows still waiting now. Never empty:
 *  a job with no days shows one blank row. */
export function reseedRows(stored: RangeRow[], now: RangeRow[]): RangeRow[] {
  const rows = [...stored.map((r) => ({ start: r.start, end: r.end })), ...rangesToSave(now).waiting];
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
