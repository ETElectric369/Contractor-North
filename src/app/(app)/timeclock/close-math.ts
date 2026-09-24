/**
 * Pure arithmetic for closing a shift, and for the /timeclock "finish your timecard" prompt.
 *
 * A split shift used to keep its clock times on the entry and write its hours per job into a second
 * table, so closing one had to protect those rows (a floor at the last recorded segment, a tail row
 * for the part after the last switch). Since 0288 a Switch Job CLOSES the running entry and opens the
 * next one, so every part of a day is its own entry with its own clock times, and a close only ever
 * touches the one entry that is still running. What is left here is the part that never depended
 * on the split: a close may not land before the shift started or in the future.
 *
 * Neither function touches payroll arithmetic: hours paid come from clock_in/clock_out/lunch as
 * they always have (see payroll-math).
 */

/**
 * The clock-out instant to persist for an explicitly supplied `at` (the geofence "time they left",
 * a picked time). Clamped to [clock_in + 1 min, now + 1 min]: never negative hours, never a close
 * in the future.
 *
 * @param atMs       the caller's requested clock-out (epoch ms)
 * @param clockInMs  the entry's clock-in (epoch ms); 0/NaN when unknown
 * @param nowMs      current time (epoch ms)
 */
export function clampCloseAtMs(atMs: number, clockInMs: number, nowMs: number): number {
  const ci = Number.isFinite(clockInMs) ? clockInMs : 0;
  return Math.min(Math.max(atMs, ci + 60_000), nowMs + 60_000);
}

/** Written onto an auto-closed shift's notes once its owner has answered the after-the-fact
 *  questions, so the prompt stops asking. Human-readable on purpose: the office reads it too. */
export const AUTO_CONFIRMED_CRUMB = "[hours confirmed after the auto clock-out]";

/** The notes with the confirmation crumb added once (never twice). */
export function withAutoConfirmedCrumb(notes: string | null | undefined): string {
  const base = (notes ?? "").trim();
  if (base.includes(AUTO_CONFIRMED_CRUMB)) return base;
  return base ? `${base}\n${AUTO_CONFIRMED_CRUMB}` : AUTO_CONFIRMED_CRUMB;
}

/**
 * Whether the /timeclock "finish your timecard" prompt should surface for an auto-closed entry.
 *
 * A geofence close (or "clock out now, I'll answer later") asked nobody anything, so the prompt asks
 * the one thing a tech can still answer after the fact: did you take a lunch. (The office's own
 * prompt also offers "I switched at [time]", which is a split.) It stays until somebody answers,
 * and answering writes AUTO_CONFIRMED_CRUMB. Until 2026-09-24 the gate was "hours not yet broken
 * down by job"; every hour of an entry now belongs to its own job, so there is nothing left to break
 * down and the only question left is whether it was answered.
 *
 * Payroll-neutral: this only decides whether to ASK.
 */
export function autoClockoutPromptState(input: { notes: string | null | undefined }): { show: boolean } {
  return { show: !String(input.notes ?? "").includes(AUTO_CONFIRMED_CRUMB) };
}
