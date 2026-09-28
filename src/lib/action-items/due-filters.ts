import { jobWords } from "./words";

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

/** Midnight UTC of the day `days` from `todayStr`: the instant the feeders' day math measures from. */
const dayShift = (todayStr: string, days: number) => new Date(Date.parse(`${todayStr}T00:00:00Z`) + days * 86_400_000);

/*
 * A PILE'S COUNT MATCHES ITS ROW'S RULE, NOT THE WHOLE POPULATION (Wave 1, lane 5 fix). A feeder that
 * read every open invoice or every sent estimate and filtered in code took its pile's "N+" from the
 * read's exact count, so a company with 51 open invoices saw its one late invoice as "Late Invoices
 * · 1+", a pile of one, whose See All opened a list of everything. These filters put the row's own
 * rule in the database read, so the exact count is the count of rows that would be on Needs You.
 * Each is the very rule the feeder applies per row (the code keeps applying it too), written the way
 * PostgREST reads it; due-filters.test.ts evaluates each string over rows against that rule.
 */

/**
 * AN UNPAID INVOICE WORTH CHASING: past its due date, or (no due date) `staleDays` or more since it
 * was made. A due date today or later is the answer by itself: age never speaks over it. (This is not
 * the undated-set arm the badge law forbids: an undated invoice counts only once it is old.)
 */
export function lateInvoiceFilter(todayStr: string, staleDays: number): string {
  return `due_date.lt.${todayStr},and(due_date.is.null,created_at.lte.${dayShift(todayStr, -staleDays).toISOString()})`;
}

/**
 * A SENT ESTIMATE ON NEEDS YOU: its follow-up day has come; or, with no follow-up day, the customer
 * has had it `quietDays` or more, or its valid-until is `soonDays` away or past. `withFollowUp` false:
 * before 0366 (no follow_up_at column), the old rule alone. A follow-up day after today is the
 * Waiting fold's, which reads those on their own.
 */
export function quoteNoAnswerFilter(todayStr: string, quietDays: number, soonDays: number, withFollowUp: boolean): string {
  const oldRule = `created_at.lte.${dayShift(todayStr, -quietDays).toISOString()},valid_until.lte.${dayShift(todayStr, soonDays).toISOString().slice(0, 10)}`;
  return withFollowUp ? `follow_up_at.lte.${todayStr},and(follow_up_at.is.null,or(${oldRule}))` : oldRule;
}

/**
 * WHERE A DRAFT INVOICE SITS (Wave 1, lane 5; invoices.hold_until), and whether Set Aside Until… is a
 * door on it:
 *   "waiting"   set aside until a later day and its job still going: the Waiting fold, with that day;
 *   "finished"  set aside, but its job is finished or cancelled: the day it waited for has come, so it
 *               is back on top at once ("Herringbone · J-011 Finished · Send INV-078");
 *   "now"       not set aside, or its day has come: a plain draft row.
 * A DRAFT WHOSE JOB IS FINISHED OR CANCELLED HAS NOTHING LEFT TO WAIT FOR: Set Aside Until… on it
 * would write a day and put it straight back on top as "Finished · Send", so the door is never drawn
 * there (a door that can't quiet the row is a dead end, and its "comes back that day" untrue).
 */
export function draftInvoiceState(
  holdUntil: string | null | undefined,
  jobStatus: string | null | undefined,
  todayStr: string,
): { place: "waiting" | "finished" | "now"; canSetAside: boolean } {
  const until = holdUntil ? String(holdUntil).slice(0, 10) : null;
  const setAside = !!until && until > todayStr;
  const jobDone = isFinishedJobStatus(jobStatus);
  return { place: setAside ? (jobDone ? "finished" : "waiting") : "now", canSetAside: !jobDone };
}

/** A job that is over: finished or cancelled (a draft on it waits on nothing). */
export function isFinishedJobStatus(status: string | null | undefined): boolean {
  return status === "complete" || status === "cancelled";
}

/**
 * THE ONE REFUSAL FOR SETTING ASIDE A DRAFT WHOSE JOB IS OVER, said by every door (the invoice page's
 * ⋯ Set Aside Until…, Needs You's, Nort's invoice.setAside, all through parkInvoice). Null when the
 * job is still going, or there is no job: then a day can quiet the draft and "comes back" is true.
 */
export function finishedDraftRefusal(
  job: { job_number?: string | null; name?: string | null; status?: string | null } | null | undefined,
): string | null {
  if (!job || !isFinishedJobStatus(job.status)) return null;
  return `${jobWords(job)} is ${job.status === "cancelled" ? "cancelled" : "finished"}, so this draft has nothing left to wait for and stays on Needs You. Send it, or void it if it won't be billed.`;
}

/** The job a PostgREST `jobs:job_id(...)` embed hands back (an object, or a one-row array). */
export function embeddedJob<T>(rel: unknown): T | null {
  return ((Array.isArray(rel) ? rel[0] : rel) ?? null) as T | null;
}
