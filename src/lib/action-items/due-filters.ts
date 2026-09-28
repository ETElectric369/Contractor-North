/**
 * THE DAY A PERSON PICKED IS THE DAY IT COMES BACK (Wave 1 seam fixes on release/w1a).
 *
 * Order 1 gives three waits a day: a lead's Snooze (inquiry.snooze → next_follow_up_at), an
 * estimate's follow-up (quote.followUp → quotes.follow_up_at, 0366) and a job's hold
 * (setJobHold → jobs.hold_until, 0366). Nort and the pickers say "comes back Monday", so Needs You
 * has to agree: a wait whose day is after today is off Now (it waits in the Waiting fold with that
 * day), and on its day it is back.
 *
 * The lead filter is a PostgREST `.or()` string so the rule runs in the database read, not after a
 * `.limit()`; due-filters.test.ts evaluates it over rows. The estimate and hold rules run per row.
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
 * WHERE A JOB ON HOLD SITS (Wave 1, lane 5; 0366's hold_until), decided on each held row:
 *   "later"   its day is after today: it waits in the Waiting fold, "Back Oct 3";
 *   "back"    its day is today or earlier: a Reminder on Needs You ("Back Today", "Back since Sep 30");
 *   "no_day"  it has no day (held before 0366): a Reminder too, "No Day Set", whose Snooze picks one.
 * No updated_at proxy any more: a hold was "a week untouched" only because it had no day of its own.
 */
export function heldJobState(holdUntil: string | null | undefined, todayStr: string): "later" | "back" | "no_day" {
  const day = String(holdUntil ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "no_day";
  return day > todayStr ? "later" : "back";
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
