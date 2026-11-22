import { everythingBillable, type EverythingBillable } from "@/lib/everything-billable";

/**
 * WHAT THE JOB PAGE SHOWS OF EVERYTHING BILLABLE, AND WHAT IT HANDS THE NEW INVOICE SHEET (cn-v1181
 * fixer, skeptic #84 S3 and M2). One decision over the page's reads, so the tile and both New Invoice
 * buttons cannot disagree:
 *
 *   · THE TILE is unread when ANY read it rests on failed: the bills' money read made for it, or the
 *     page's own estimates, change orders or invoices read. A failed invoices read is never "nothing
 *     billed", and a failed estimates read is never "no price on the estimate yet".
 *   · THE SHEET'S PART BASE is the rule's own figure (partLeftGross) on EVERY job with an estimate,
 *     the figure the Part door bills (recurring/actions createProgressInvoice), not only where the
 *     tile is drawn; when a read failed it is unread, and the sheet says Couldn't total instead of
 *     falling back to its own subtraction.
 *
 * `billMoney`: each bill's subtotal, tax, discount and prepaid-credit lines from the page's money read.
 */
export function jobBillableView(o: {
  tileWanted: boolean;
  partWanted: boolean;
  /** Each read the figure rests on, failed or not: the money read and the page's three. */
  failed: { money: boolean; quotes: boolean; changeOrders: boolean; invoices: boolean };
  quotes: unknown[];
  changeOrders: unknown[];
  invoices: unknown[];
  billMoney: Map<string, { subtotal: number | null; tax: number | null; discount: number; prepaidCredit: number }>;
}): {
  tile: EverythingBillable | null;
  tileUnread: boolean;
  partLeft: number | null;
  requestsToComeOff: number | null;
  partUnread: boolean;
} {
  const anyFailed = o.failed.money || o.failed.quotes || o.failed.changeOrders || o.failed.invoices;
  let view: EverythingBillable | null = null;
  let unread = anyFailed;
  if ((o.tileWanted || o.partWanted) && !anyFailed) {
    try {
      view = everythingBillable({
        quotes: o.quotes as any[],
        changeOrders: o.changeOrders as any[],
        invoices: (o.invoices as any[]).map((i) => ({ ...i, ...(o.billMoney.get(String(i.id)) ?? {}) })),
      });
    } catch {
      // The rule refuses estimates it cannot order (no created_at): said, never a silent figure.
      unread = true;
    }
  }
  return {
    tile: o.tileWanted ? view : null,
    tileUnread: o.tileWanted && unread,
    partLeft: o.partWanted && view ? view.partLeftGross : null,
    requestsToComeOff: o.partWanted && view ? view.requestsToComeOff : null,
    partUnread: o.partWanted && unread,
  };
}
