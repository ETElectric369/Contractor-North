import { ACTIVE_JOB_STATUSES, isEndedJob } from "@/lib/job-status";
import { invoiceBalance } from "@/lib/invoice-math";
import { isStillOwed } from "@/lib/supplier-owed";

/**
 * EVERY BADGE COUNTS ONLY WHAT'S OPEN (Erik, 2026-09-27: "and all badges only show whats open").
 *
 * A badge is a call to act. A total (12 photos, 9 invoices, 40 items) teaches a person to stop
 * reading badges, the way a stockpiled Needs You taught Erik to stop opening My Day. So a number on
 * a chip, a tab or a tile counts only the rows that still need SOMEONE, and a zero draws nothing
 * (<Tabs> and the dock already hide a 0). A pure total is not a badge at all: it is dropped, or said
 * as plain text inside the page.
 *
 * These are the "still needs someone" rules for each kind of record, one per kind, so every chip
 * that counts invoices counts the same invoices. Each takes the row's own columns; none reads
 * anything new. The materials list's rule lives in lib/materials-checklist (isOpenToBuy).
 */

/** A job still in flight: to be scheduled, scheduled, in progress or on hold (not done, not
 *  cancelled). The job-status spine's own ACTIVE set. */
export function isOpenJob(status: string | null | undefined): boolean {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(String(status ?? ""));
}

/**
 * A TASK STILL TO DO (cn-v1174; Erik, 2026-11-21: "ones that close out with the job should already be
 * closed out right? and it says 3 above and there are a bunch down there so how is this number getting
 * calculated?").
 *
 * Open is its status open AND either no job (a Reminder) or a job that is not over: finished and
 * called off end a job's tasks, ON HOLD does not (the job is coming back, and so is its work). `job` is
 * the task's job as read with it (its status), or null for a task with no job. Steps count as they
 * always have: a step is a task. Every count and every list of open tasks reads this, or its query
 * twin in lib/job-tasks (whereJobTaskOpen / whereReminderOpen) when the database does the cut, so a
 * number over a list is the list's own length: the job page's Tasks badge and its "X of Y done", My
 * Day's Now card "Tasks: N left", Nort's list_tasks, its schedule read and its bulk sweeps.
 */
export function isOpenTask(task: { status?: string | null }, job: { status?: string | null } | null): boolean {
  if (String(task.status ?? "") !== "open") return false;
  return !job || !isEndedJob(job.status);
}

/** An estimate someone still owes a move on: a draft to finish and send, or one sent and waiting on
 *  the customer. Accepted, declined and expired are settled. */
export function isOpenQuote(status: string | null | undefined): boolean {
  return status === "draft" || status === "sent";
}

/** An invoice still owed: a draft not sent yet, or a sent bill with a balance (the billing board's
 *  own Draft and Awaiting Payment piles, billing-pipeline). Paid and void are settled, and so is a
 *  sent bill whose balance is paid even if its status lags. */
export function isOpenInvoice(inv: { status?: string | null; total?: number | string | null; amount_paid?: number | string | null }): boolean {
  const s = String(inv.status ?? "");
  if (s === "draft") return true;
  if (s === "paid" || s === "void") return false;
  return invoiceBalance(Number(inv.total) || 0, Number(inv.amount_paid) || 0) > 0.005;
}

/**
 * AN INVOICE THE CUSTOMER STILL OWES — the Accounts Receivable half of the same rule (M3).
 *
 * An OPEN invoice that has gone out: a draft is not owed yet (nobody has been asked for it, and it
 * is money not yet billed, which is a different pile), paid and void are settled, and so is a sent
 * bill whose balance is covered even if its status lags. The A/R aging's rows AND its count read
 * this one function, so "5 open invoices" is always the number of rows underneath it — the badge
 * law: a count shows only what's open, never a total.
 */
export function isOwedInvoice(inv: { status?: string | null; total?: number | string | null; amount_paid?: number | string | null }): boolean {
  return String(inv.status ?? "") !== "draft" && isOpenInvoice(inv);
}

/** A change order waiting on its answer. Approved and rejected are settled. */
export function isOpenChangeOrder(status: string | null | undefined): boolean {
  return status === "pending";
}

/** A work order still to do: anything short of complete or cancelled. */
export function isOpenWorkOrder(status: string | null | undefined): boolean {
  return status !== "complete" && status !== "cancelled";
}

/** A permit still in motion: not submitted, applied, issued, an inspection coming, or failed (a
 *  failed inspection needs someone most of all). Passed and closed are settled. */
export function isOpenPermit(status: string | null | undefined): boolean {
  return status !== "passed" && status !== "closed";
}

/** A visit still ahead of someone: booked, or proposed and waiting on the customer's pick. Completed
 *  and cancelled are settled. */
export function isOpenAppointment(status: string | null | undefined): boolean {
  return status === "scheduled" || status === "proposed";
}

/**
 * A SUPPLIER BILL STILL OWED - and the rule itself lives in ONE place now (8a982483).
 *
 * This carried its own copy of the expression, `isOnAccountBill` in supplier-balance.ts carried a
 * second, and the suppliers card had a third written inline. Each knew a different subset of the
 * same three facts, which is how one ticket could read settled on one line of a screen and owed on
 * the next. `isStillOwed` is the expression now; this is the name the open-counts list knows it by,
 * and the doc comment that used to promise a reach this function did not have is below in full.
 *
 * BY THE NUMBER (0383): a bill is open while amount − amount_paid is not zero. A reader that did
 * not select the number falls back to the status word, which the database derives from it.
 */
export function isOpenBill(b: { status?: string | null; amount?: unknown; amountPaid?: number | null; superseded?: boolean | null }): boolean {
  return isStillOwed(b);
}

/** A purchase order not in yet: a draft, sent, or partly received. Received and cancelled are settled. */
export function isOpenPurchaseOrder(status: string | null | undefined): boolean {
  return status === "draft" || status === "sent" || status === "partial";
}

/** How many rows pass `open`. */
export function countOpen<T>(rows: readonly T[] | null | undefined, open: (r: T) => boolean): number {
  return (rows ?? []).filter(open).length;
}
