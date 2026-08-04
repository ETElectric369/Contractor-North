/**
 * WAITING ON SOMEBODY ELSE — the state the app never had, and the reason five jobs get their
 * dates bumped by hand every week.
 *
 * Erik: "i have a couple on hold that keep popping up because i keep bumping the dates back but
 * we are waiting on permits to do the work because panel swaps with meters attached need to be
 * permitted first and arent going on the calendar until we get notice."
 *
 * TWO STATES THAT LOOK IDENTICAL ON A LIST AND ARE OPPOSITES:
 *
 *   TO BE INSPECTED       the work is done and an inspection needs booking. It is an ACTION, it
 *                         is his, and it is schedulable today. It SHOULD nag.
 *   WAITING TO PROCEED    the work cannot start until somebody else acts. It is a BLOCK, it is
 *                         not his, and asking him for a date is asking him to invent one. It
 *                         should NOT nag — it should AGE.
 *
 * The difference matters because the correct response is opposite. You clear the first by doing
 * something. You clear the second by somebody else doing something, and the only useful thing the
 * app can tell you about it is HOW LONG IT HAS BEEN — because that is what you call the county
 * about.
 *
 * NO "UNTIL" DATE, ANYWHERE IN HERE. That is the fix, not an omission. A permit office does not
 * tell you when it will call. A made-up date can only ever be wrong or moved; an age is true the
 * moment it is written and stays true with no maintenance at all.
 */

export interface Blockable {
  /** Why it can't proceed, in the contractor's words. Null/empty = not waiting on anybody. */
  blocked_on?: string | null;
  /** When the wait started (yyyy-mm-dd). */
  blocked_since?: string | null;
}

/** Is this waiting on somebody else? */
export const isWaiting = (r: Blockable): boolean => !!r.blocked_on?.trim();

/**
 * How long the wait has run, in days. Null when it isn't waiting or never recorded a start.
 *
 * Date-only arithmetic on purpose — a wait is counted in days on a calendar, not in elapsed hours,
 * so a permit filed at 4pm yesterday reads as 1 day this morning rather than 0.
 */
export function waitingDays(r: Blockable, today: string): number | null {
  if (!isWaiting(r) || !r.blocked_since) return null;
  const a = Date.parse(`${r.blocked_since}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * How loud this should be. Not a due date — a temperature.
 *
 * A wait is nobody's fault on day one and somebody's problem on day thirty. The thresholds are
 * deliberately coarse: this is a nudge to pick up the phone, and pretending to know that day 13
 * differs from day 14 would be the same false precision as the invented dates it replaces.
 */
export type WaitTone = "fresh" | "aging" | "stale";

export function waitTone(days: number | null): WaitTone {
  if (days === null || days < 7) return "fresh";
  return days < 21 ? "aging" : "stale";
}

/** The one line a person reads. "Waiting 19 days — county permit for the meter swap." */
export function waitingLabel(r: Blockable, today: string): string | null {
  if (!isWaiting(r)) return null;
  const d = waitingDays(r, today);
  const why = r.blocked_on!.trim();
  if (d === null) return `Waiting — ${why}`;
  if (d === 0) return `Waiting since today — ${why}`;
  return `Waiting ${d} ${d === 1 ? "day" : "days"} — ${why}`;
}

/**
 * The waiting list: longest wait first.
 *
 * Oldest-first is the whole ordering argument. A three-week-old permit request is the one that has
 * gone wrong; today's is simply in progress. Anything with no recorded start sorts last rather
 * than first — an unknown age is not an emergency, and guessing that it is would put the least
 * information at the top of the list.
 */
export function waitingList<T extends Blockable>(rows: readonly T[], today: string): T[] {
  return rows
    .filter(isWaiting)
    .slice()
    .sort((a, b) => (waitingDays(b, today) ?? -1) - (waitingDays(a, today) ?? -1));
}

/**
 * Should this row be asked for a date?
 *
 * The single question the whole thing exists to answer. A blocked job must not appear in
 * "needs scheduling", must not render as late, and must not carry a scheduled_start that somebody
 * has to keep moving. When the notice comes, the block clears and it becomes schedulable — that is
 * the moment it goes on the calendar, and not before.
 */
export const isSchedulable = (r: Blockable): boolean => !isWaiting(r);
