/**
 * THE DAY A PERSON PICKED IS THE DAY IT COMES BACK (Wave 1 seam fixes on release/w1a).
 *
 * Order 1 gives three waits a day: a lead's Snooze (inquiry.snooze → next_follow_up_at), an
 * estimate's follow-up (quote.followUp → quotes.follow_up_at, 0366) and a job's hold
 * (setJobHold → jobs.hold_until, 0366). Nort and the pickers say "comes back Monday", so Needs You
 * has to agree in the same release: a wait whose day is after today stays off the list, and on its
 * day it is back. Lane 5 (order 2) builds the Waiting fold on top of these same rules.
 *
 * The filters are PostgREST `.or()` strings so the rule runs in the database read, not after a
 * `.limit()`; due-filters.test.ts evaluates them over rows.
 */

/**
 * A lead (new or contacted) is on Needs You when it has no follow-up day, or the day is today or
 * earlier. A NEW lead snoozed to Monday is off the list until Monday, exactly like a contacted one:
 * the Snooze on its row and Nort's inquiry.snooze are the same deed.
 */
export function inquiryDueFilter(todayStr: string): string {
  return `next_follow_up_at.is.null,next_follow_up_at.lte.${todayStr}`;
}

/**
 * A job on hold is on Needs You when its come-back day (0366's hold_until) is today or earlier. A
 * hold with no day (held before 0366) keeps the old rule: untouched for a week (`staleCutoffIso`).
 * Only used when the hold_until column exists; before 0366 the feeder reads the old rule alone.
 */
export function heldJobDueFilter(todayStr: string, staleCutoffIso: string): string {
  return `hold_until.lte.${todayStr},and(hold_until.is.null,updated_at.lt.${staleCutoffIso})`;
}

/**
 * An estimate waiting on the customer, given its follow-up day (0366's quotes.follow_up_at):
 *   "later"  the day is after today: off the list until then (the day he picked stands);
 *   "due"    the day is today or earlier: on the list, whatever the 7-quiet-days rule says;
 *   "none"   no day picked: the old rule (7 quiet days, or valid-until close or past) decides.
 */
export function quoteFollowUpState(followUpAt: string | null | undefined, todayStr: string): "later" | "due" | "none" {
  if (!followUpAt) return "none";
  return followUpAt.slice(0, 10) > todayStr ? "later" : "due";
}
