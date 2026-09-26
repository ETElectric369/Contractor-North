/**
 * WHERE A SUPPLIER PAPER LIVES, ONE ROUTING FOR EVERY DOOR THAT POINTS AT ONE (audit v1018, class 14).
 *
 * The /bills search box, the job's Named On A Paper list and anything else that says "open it"
 * land a paper in the one place its own buttons are:
 *
 *   on a Needs You card        #needs-you                           (the card's job buttons)
 *   waiting on a credit        #supplier-waiting-credit-<account>   (Stop Waiting)
 *   on a job                   /jobs/<job>                          (only when a caller passes it)
 *   on a supplier account      #supplier-invoices-<account>         (its own folded lists)
 *   none of those              null: the caller says where it is in words instead
 *
 * The folds are native <details>, and FoldOpener opens every fold around the target. Pure, so a
 * client component can call it.
 */
export function billsPaperDoor(p: {
  onNeedsYou?: boolean | null;
  waitingOnCredit?: boolean | null;
  accountId?: string | null;
  jobId?: string | null;
}): string | null {
  if (p.onNeedsYou) return "#needs-you";
  if (p.waitingOnCredit && p.accountId) return `#supplier-waiting-credit-${p.accountId}`;
  if (p.jobId) return `/jobs/${p.jobId}`;
  if (p.accountId) return `#supplier-invoices-${p.accountId}`;
  return null;
}
