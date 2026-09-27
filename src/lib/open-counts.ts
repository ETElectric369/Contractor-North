import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { invoiceBalance } from "@/lib/invoice-math";

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

/** A supplier bill still owed (bills.status is unpaid | paid). A bill set aside as another's
 *  duplicate is never counted anywhere (superseded). */
export function isOpenBill(b: { status?: string | null; superseded?: boolean | null }): boolean {
  return b.status !== "paid" && !b.superseded;
}

/** A purchase order not in yet: a draft, sent, or partly received. Received and cancelled are settled. */
export function isOpenPurchaseOrder(status: string | null | undefined): boolean {
  return status === "draft" || status === "sent" || status === "partial";
}

/** How many rows pass `open`. */
export function countOpen<T>(rows: readonly T[] | null | undefined, open: (r: T) => boolean): number {
  return (rows ?? []).filter(open).length;
}
