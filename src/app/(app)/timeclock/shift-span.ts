/**
 * SPAN-AWARE shift times for the office entry editors.
 *
 * Both office modals (Add past entry, Edit time entry) collect ONE date plus a
 * start and an end time, then built both timestamps on that single date. Any
 * shift that crosses midnight — a night service call, a 6pm–2am generator swap —
 * therefore produced clock_out <= clock_in and hit "End must be after start", so
 * the office could not save or correct it at all. (createManualEntry/updateTimeEntry
 * both reject co <= ci server-side too, so there was no back door.)
 *
 * The rule here: when the END time is earlier in the day than the START time, the
 * shift ended on the FOLLOWING calendar day. Equal times stay an error (a 0-hour
 * or a 24-hour shift is a typo either way, and guessing which would be inventing
 * payroll hours). An explicit end date always wins over the derivation.
 *
 * Dates are built in the BROWSER's local zone (`new Date("YYYY-MM-DDTHH:MM:00")`),
 * exactly as the modals already did, and the day rollover uses setDate() so a
 * spring-forward/fall-back night still lands on the right wall-clock hour.
 */

export interface ShiftSpan {
  clockIn: Date;
  clockOut: Date;
  /** The end time landed on the next calendar day (derived or explicit). */
  overnight: boolean;
}

/** True when `endT` is earlier in the day than `startT` ⇒ the shift crosses midnight. */
export function crossesMidnight(startT: string, endT: string): boolean {
  if (!/^\d{2}:\d{2}/.test(startT) || !/^\d{2}:\d{2}/.test(endT)) return false;
  return endT.slice(0, 5) < startT.slice(0, 5);
}

/**
 * Build the clock-in/clock-out pair from the modal's fields.
 * Returns null when any piece is unparseable — the caller shows its own message.
 *
 * @param date    start date, YYYY-MM-DD
 * @param startT  start time, HH:MM
 * @param endT    end time, HH:MM
 * @param endDate optional explicit end date (YYYY-MM-DD). Empty/omitted ⇒ derived.
 */
export function buildShiftSpan(
  date: string,
  startT: string,
  endT: string,
  endDate?: string | null,
): ShiftSpan | null {
  if (!date || !startT || !endT) return null;
  const clockIn = new Date(`${date}T${startT}:00`);
  if (isNaN(clockIn.getTime())) return null;

  const explicit = (endDate ?? "").trim();
  if (explicit) {
    const clockOut = new Date(`${explicit}T${endT}:00`);
    if (isNaN(clockOut.getTime())) return null;
    return { clockIn, clockOut, overnight: explicit !== date };
  }

  const clockOut = new Date(`${date}T${endT}:00`);
  if (isNaN(clockOut.getTime())) return null;
  const overnight = crossesMidnight(startT, endT);
  // setDate() (not +86_400_000) so a DST night keeps the stated wall-clock end time.
  if (overnight) clockOut.setDate(clockOut.getDate() + 1);
  return { clockIn, clockOut, overnight };
}

/** Gross hours of a span (lunch NOT deducted) — 0 when the span is empty/invalid. */
export function spanGrossHours(span: ShiftSpan | null): number {
  if (!span) return 0;
  const ms = span.clockOut.getTime() - span.clockIn.getTime();
  if (!(ms > 0)) return 0;
  return ms / 3_600_000;
}
