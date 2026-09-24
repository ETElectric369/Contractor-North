/**
 * A CLOCK THAT HAS BEEN RUNNING TOO LONG WAS PROBABLY FORGOTTEN. ONE RULE, EVERY DOOR.
 *
 * Erik, 2026-09-24: "Brian did it the other day too and I had no way to stop it to set the time for
 * the invoice". A crew member forgot to clock out, the office could see the clock still running, and
 * nothing on the page could STOP it at a stated time: the editor refused an open row, and every
 * other door closed it at "now", which writes a 30-hour shift nobody worked.
 *
 * Everything that has to decide "is this shift a forgotten punch?" asks this file: the office's
 * clock-out sheet (Clock Out Brian, or Stop Brian's Clock on a forgotten one), the crew's own
 * Timeclock card, the geofence prompt, the server's clock-out backstop, the hourly job (the office's
 * bell line at OFFICE_BELL_HOURS, the question and the buzz at LONG_SHIFT_HOURS), the My Day inbox
 * and Nort. A threshold written in each of them drifts (the timecards page said 12 hours while the
 * leak detector said 16), and a crew member told one thing on his phone and another on the office
 * screen stops believing either.
 *
 * Pure: no database, no React, nothing from app/. It never writes a time. A clock only stops at a
 * time a person states, because nothing observed the moment the work ended and payroll does not
 * invent hours.
 */
import { DEFAULT_TIMEZONE } from "./utils";
import { tzMinutesOfDay, todayStrInTz } from "./tz";

const H = 3_600_000;

/**
 * A shift running this long has probably been forgotten. Not a ceiling: a real 13-hour day saves.
 *
 * TWELVE, not ten (Erik, 2026-09-24: "I think 12 hours is a good question point mark"). Ten asked
 * about ordinary long days. Every sentence that names the line reads it from here
 * (LONG_SHIFT_PHRASE), so the crew member's phone and the office's screen never quote two numbers.
 */
export const LONG_SHIFT_HOURS = 12;
/**
 * The office's early word: a clock running this long puts a line on the office's bell, and only
 * that (Erik, 2026-09-24: "Put a line on the Bell at 10 hours and buzz at 12"). Nothing is asked
 * and nothing buzzes until LONG_SHIFT_HOURS; a bell line is silent, so it is not held for the night.
 */
export const OFFICE_BELL_HOURS = 10;
/** No single shift is longer than this. The database refuses one (0214/0281) unless the system
 *  closed it itself and said why. */
export const MAX_SHIFT_HOURS = 18;

/**
 * True when the clock has been running at least LONG_SHIFT_HOURS.
 *
 * There is deliberately no "started on an earlier day" clause: a 7 PM callback that runs past
 * midnight is an ordinary night, not a forgotten punch, and asking that man when he stopped at
 * 12:30 AM would be a lie about what the app knows.
 */
export function isLongOpenShift(clockInMs: number, nowMs: number): boolean {
  if (!Number.isFinite(clockInMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - clockInMs >= LONG_SHIFT_HOURS * H;
}

/** "more than 12 hours": the line as every refusal and prompt says it, read from the constant. */
export const LONG_SHIFT_PHRASE = `more than ${LONG_SHIFT_HOURS} hours`;

/**
 * WHAT THE OFFICE'S DOOR ON SOMEBODY ELSE'S RUNNING CLOCK SAYS (Erik, 2026-09-24: "an option to
 * [end] an employees time clock and clock out for them").
 *
 *   clockOut: the trigger everywhere the office sees that clock, and the sheet's title and button on
 *             an ordinary shift: "Clock Out Brian" ("Clock Them Out" with no name on the row).
 *   stop:     the sheet's title and button on a forgotten one (LONG_SHIFT_HOURS, or begun on an
 *             earlier day): "Stop Brian's Clock", because that sheet asks when it really ended.
 *
 * `self`: the viewer's own running clock, which he clocks out of himself ("Clock Out",
 * "Stop Your Clock"); a door never names its own reader in the third person.
 */
export function clockDoorWords(fullName: string | null | undefined, opts: { self?: boolean } = {}): {
  clockOut: string;
  stop: string;
} {
  if (opts.self) return { clockOut: "Clock Out", stop: "Stop Your Clock" };
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  // A placeholder a list printed for a missing name ("—") is not a name.
  if (!/\p{L}/u.test(first)) return { clockOut: "Clock Them Out", stop: "Stop Their Clock" };
  return { clockOut: `Clock Out ${first}`, stop: `Stop ${first}'s Clock` };
}

/** The office's sheet treats this shift as forgotten: it has run LONG_SHIFT_HOURS, or it began on
 *  an earlier org-local day. Then the sheet reads "Stop Brian's Clock" and its stop time starts
 *  empty; otherwise it reads "Clock Out Brian" with the stop time at now. */
export function isForgottenShift(clockInMs: number, nowMs: number, tz: string): boolean {
  return isLongOpenShift(clockInMs, nowMs) || startedEarlierDay(clockInMs, nowMs, tz);
}

/** The instants a stated stop may take: a minute after the clock-in, up to a minute from now, and
 *  never more than MAX_SHIFT_HOURS after the clock-in. */
export function stopWindow(clockInMs: number, nowMs: number): { minMs: number; maxMs: number } {
  return { minMs: clockInMs + 60_000, maxMs: Math.min(nowMs + 60_000, clockInMs + MAX_SHIFT_HOURS * H) };
}

function clock(ms: number, tz?: string): string {
  // ICU puts a narrow no-break space before AM/PM; plain text reads and compares better.
  return new Date(ms)
    .toLocaleTimeString("en-US", { timeZone: tz || DEFAULT_TIMEZONE, hour: "numeric", minute: "2-digit" })
    .replace(/ /g, " ");
}

/**
 * What is wrong with this stop time, as the sentence to show, or null when it is a real stop.
 *
 * `who` only changes the ceiling sentence: the crew member reads "you", the office reads "the
 * shift". `tz` names the clock the start is shown in (the org's; the browser's when omitted on a
 * device that is already in it).
 */
export function stopProblem(input: {
  startMs: number;
  stopMs: number;
  nowMs: number;
  lunchMin: number;
  who: "you" | "he";
  tz?: string;
}): string | null {
  const { startMs, stopMs, nowMs } = input;
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return "Pick a stop time.";
  if (stopMs < startMs + 60_000) return `Pick a stop time after ${clock(startMs, input.tz)}.`;
  if (stopMs > nowMs + 60_000) return "That time hasn't happened yet.";
  if (stopMs - startMs > MAX_SHIFT_HOURS * H) {
    return input.who === "you"
      ? "That's more than 18 hours after you clocked in. Pick when you really stopped."
      : "That's more than 18 hours after the clock-in. Pick when the shift really stopped.";
  }
  const lunch = Math.max(0, Number(input.lunchMin) || 0);
  if (lunch * 60_000 >= stopMs - startMs) return "The lunch is longer than the shift.";
  return null;
}

/** Between 9 PM and 6 AM org-local nobody gets a push about a clock. The next run after 6 AM does it.
 *  A bell line is not a push, and is not held (pickLongShiftSteps). */
export function quietHold(nowMs: number, tz: string): boolean {
  const min = tzMinutesOfDay(new Date(nowMs), tz || DEFAULT_TIMEZONE);
  return min >= 21 * 60 || min < 6 * 60;
}

/** The clock-in's org-local day is before today's: the office sheet names the date and never
 *  offers "now" as a stop. */
export function startedEarlierDay(clockInMs: number, nowMs: number, tz: string): boolean {
  const z = tz || DEFAULT_TIMEZONE;
  return todayStrInTz(z, new Date(clockInMs)) < todayStrInTz(z, new Date(nowMs));
}

export type LongShiftCandidate = {
  clock_in: string;
  long_shift_warned_at?: string | null;
  long_shift_nudged_at?: string | null;
};

/**
 * What the hourly job owes each open shift right now, in its two steps (0291 claims each once):
 *
 *   bell:  running OFFICE_BELL_HOURS and the office has not had its bell line. A bell line is
 *          silent, so the night does not hold it.
 *   nudge: running LONG_SHIFT_HOURS and nobody has been asked. It pushes (the crew member, and the
 *          office's phones), so nothing goes out between 9 PM and 6 AM; the 6 AM run does it.
 *
 * A row can be in both lists on one run (the job was down at 10 hours, or both marks fell in one
 * hour): the office gets its line and its buzz, never one in place of the other.
 */
export function pickLongShiftSteps<T extends LongShiftCandidate>(
  openRows: T[],
  nowMs: number,
  tz: string,
): { bell: T[]; nudge: T[] } {
  const held = quietHold(nowMs, tz);
  const ran = (r: T, hours: number) => {
    const ci = Date.parse(r.clock_in);
    return Number.isFinite(ci) && Number.isFinite(nowMs) && nowMs - ci >= hours * H;
  };
  return {
    bell: openRows.filter((r) => !r.long_shift_warned_at && ran(r, OFFICE_BELL_HOURS)),
    nudge: held ? [] : openRows.filter((r) => !r.long_shift_nudged_at && ran(r, LONG_SHIFT_HOURS)),
  };
}
