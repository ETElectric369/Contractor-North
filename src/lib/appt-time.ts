// THE one place a calendar move recomputes an appointment's instant. A move
// changes the DAY, never the time-of-day: the appointment stays booked for the
// wall-clock hour:minute it was set to, and its duration is preserved. Both the
// month/day calendar move and the My Day ApptMoveButton call this, so the two
// paths can't drift — especially across a DST boundary, where the naive
// "add N milliseconds" math would slide the start by an hour.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Move an appointment to `targetYmd`, keeping its local wall-clock start time
 * and its duration. Wall-clock preservation is why we set the calendar fields
 * on a Date rather than adding a millisecond offset: on a spring-forward /
 * fall-back day the offset would land an hour off, but re-stamping Y/M/D and
 * keeping H:M anchors the appointment to the same clock time on the new day.
 *
 * `startsAtIso` / `endsAtIso` are absolute instants (as stored). The returned
 * ISO strings are absolute instants for the target day at the same local time.
 * A null / absent end stays null (the caller's appointment has no end).
 */
export function shiftApptToDay(
  startsAtIso: string,
  endsAtIso: string | null | undefined,
  targetYmd: string,
): { start: string; end: string | null } {
  if (!YMD.test(targetYmd)) throw new Error(`shiftApptToDay: expected yyyy-mm-dd, got "${targetYmd}"`);
  const [y, m, d] = targetYmd.split("-").map(Number);

  const start = new Date(startsAtIso);
  const nextStart = new Date(start);
  // Re-stamp the date, keep the local hours/minutes → same wall-clock time on
  // the new day. setFullYear takes month/day too, so it's one atomic move.
  nextStart.setFullYear(y, m - 1, d);

  // Duration is preserved from the ORIGINAL pair (endsAt − startsAt), not from
  // the re-stamped start, so a DST gap/overlap can't stretch or squeeze it.
  const nextEnd =
    endsAtIso != null
      ? new Date(nextStart.getTime() + (new Date(endsAtIso).getTime() - start.getTime()))
      : null;

  return { start: nextStart.toISOString(), end: nextEnd ? nextEnd.toISOString() : null };
}
