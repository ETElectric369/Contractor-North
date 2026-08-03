/**
 * MY DAY'S AGENDA, SPLIT BY THE CLOCK — earlier / next / later.
 *
 * This is here because the same bug has been reported three times from the field:
 *
 *   "The later inspections already happened."                            — Jul 31
 *   "The lead was already inspected and the inspection already happened." — Aug 01
 *   "all the inspections i've completed are on my day saying later when
 *    they already happened and need to be actioned for estimates"        — Aug 02
 *
 * The cause was one line. Everything that wasn't in the next two items fell into a
 * single bucket rendered under the heading "Later" — so a 9am walk-through sat under
 * the word "Later" at 5pm. And an EARLIER fix had made it worse in a subtle way: past
 * items used to be dropped from the day entirely, so somebody added them back into
 * that bucket without touching the label. Both readings were wrong, in opposite
 * directions — which is exactly why the rule belongs in a tested function rather than
 * in a filter expression inside a 900-line server component.
 *
 * THE RULE: an item's bucket is decided by its time against the clock, and nothing
 * else. Nothing is dropped — a visit you already made is still part of your day, it
 * is just not in your future.
 */

/** The only field the split cares about. `time` is an ISO instant, or null for untimed. */
export interface AgendaTimed {
  time: string | null;
}

export interface AgendaSplit<T> {
  /** Already happened. Shown, but never under a heading that says "Later". */
  earlier: T[];
  /** The soonest few still ahead of you — the hero of the list. */
  next: T[];
  /** Still ahead, beyond `next`, plus everything untimed (no clock = no position). */
  later: T[];
}

/**
 * Split a day's agenda around `now`.
 *
 * @param items    timed and untimed entries, any order
 * @param now      the clock to judge against (injected so this is testable)
 * @param nextSize how many upcoming items get the "Next" treatment
 */
export function splitAgenda<T extends AgendaTimed>(
  items: readonly T[],
  now: Date,
  nextSize = 2,
): AgendaSplit<T> {
  const nowMs = now.getTime();
  const ms = (i: T) => new Date(i.time as string).getTime();

  // An unparseable timestamp must not silently become 1970 and land in "earlier" —
  // treat it as untimed, which is the honest answer: we don't know when it is.
  const timed = items
    .filter((i) => !!i.time && Number.isFinite(ms(i)))
    .slice()
    .sort((a, b) => ms(a) - ms(b));
  const untimed = items.filter((i) => !i.time || !Number.isFinite(ms(i)));

  const upcoming = timed.filter((i) => ms(i) > nowMs);
  const next = upcoming.slice(0, nextSize);
  const nextSet = new Set<T>(next);

  return {
    earlier: timed.filter((i) => ms(i) <= nowMs),
    next,
    later: [...upcoming.filter((i) => !nextSet.has(i)), ...untimed],
  };
}
