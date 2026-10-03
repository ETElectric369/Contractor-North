/**
 * HOW SOON AFTER A PUNCH A SWITCH MOVES THE WHOLE SHIFT INSTEAD OF CUTTING IT.
 *
 * Erik, 2026-10-02, from editing his own timecards: "chances are if anyone clocks in and splits the
 * shift quickly the first job isnt actually getting any of that time." He was deleting the slivers by
 * hand — a few minutes on the job the app had put him on, left behind by a Switch Job — which is how
 * the other half of this lane (the split-shift delete) got found too.
 *
 * THE RULE ALREADY EXISTED; THE NUMBER WAS TOO SMALL. switch_job (0288) re-points a running entry
 * whole when it is under TWO MINUTES old, for exactly this reason ("a 28-second piece helps nobody"),
 * and cuts after that. Two minutes only covers a double-tap. The real case is a man who punches in
 * from the truck, drives, and taps Switch when he gets where he is actually working: five, ten,
 * twelve minutes. The cut left those minutes on the first job, and the first job did none of the work.
 *
 * WHO CHOSE THE JOB IS DELIBERATELY NOT PART OF THIS RULE. The obvious reading is "only move it when
 * the APP picked the job", and there is no honest way to know that at the switch: nothing stores it
 * (time_entries has no such column and `source` says app/manual/offline, not who picked), re-deriving
 * it from the schedule gets the headline case backwards (the office fixes the schedule first — that
 * is what Erik was doing — and the resolver then answers with the NEW job, so the punch reads as
 * person-picked exactly when it was not), and a flag passed in by the door covers one door out of
 * five and is a client's claim about the past. Erik's own words say "anyone", and a sliver nobody
 * worked is wrong whoever typed the job in. So the clock is the whole test, in one function.
 *
 * WHY IT HAS TO BE BOUNDED AT ALL: unbounded, a man who really did work four hours on the right job
 * and then switched would have those four hours moved onto the next customer — worse than the sliver.
 * Fifteen minutes is the house's existing "right after the punch" window (ADOPT_AFTER_CLOCK_IN_MS,
 * adopt-window.ts), it is long enough for the drive-and-tap, and it is short enough that no billable
 * stretch of work fits inside it.
 *
 * ONE COPY, and every door reads it: switchJob decides the write with it, and the Timeclock panel and
 * the job page's own switch door word their warning with it — so no screen can promise a cut the
 * server is not going to make.
 *
 * A plain module, never "use server": a client door imports it.
 */

/** The window after an entry's own clock-in inside which a Switch Job moves the WHOLE punch. */
export const SWITCH_MOVES_WHOLE_MS = 15 * 60_000;

/**
 * Does a switch right now move the whole punch (true) or cut it (false)?
 *
 * `clockInMs` is THIS ENTRY's own clock-in, never the shift's start: the second piece of a switched
 * day is a fresh punch of its own, and a man who switches a minute after landing on job C should no
 * more leave a sliver on C than he should on the first job of the morning. switch_job's own
 * two-minute test reads the entry's clock_in for the same reason.
 *
 * AN UNREADABLE CLOCK CUTS. A missing or malformed clock_in means we cannot say the punch is young,
 * and the cut is the behaviour that never moves hours nobody asked to move — so the unknown falls to
 * the old answer rather than quietly re-pointing a shift that might be eight hours long.
 *
 * A clock-in a few seconds AHEAD of the server is still young, not a refusal: clockIn accepts a start
 * up to a minute in the future (phone clock skew), and switch_job's own two-minute test treats that
 * the same way. A clock-in hours in the past is a BACKDATED punch and is not young — a shift typed in
 * as having started at seven this morning has really worked those hours.
 */
export function switchMovesWholePunch(clockInMs: number, nowMs: number): boolean {
  if (!Number.isFinite(clockInMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - clockInMs < SWITCH_MOVES_WHOLE_MS;
}
