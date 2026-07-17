/**
 * Appointment time-window guards — pure so they're unit-testable.
 *
 * endAfterStart is the guard rescheduleAppointment has always had ("The end time has
 * to be after the start."), ported to createAppointment/updateAppointment 2026-07-16
 * after Edit Details wrote a prod row (d2788015) whose ends_at preceded its starts_at.
 */

/** Returns a user-facing error when the end time is unreadable or not after the start;
 *  null when the pair is fine (a missing end is fine — open-ended appointment). */
export function endAfterStart(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (isNaN(end)) return "I couldn't read the end time.";
  if (!isNaN(start) && end <= start) return "The end time has to be after the start.";
  return null;
}
