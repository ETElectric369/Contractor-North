import { closingFileHref, type ClosingRow } from "@/lib/estimate/closing";
import type { ClosingCardRow } from "./closing-list";

/**
 * WHAT A CLOSING CARD NEEDS OF A ROW (cn-v1172): plain data, nothing the client has to look up. The
 * name's door is the person's file (closingFileHref: the customer's page, else the lead's file).
 */
export function cardRow(r: ClosingRow): ClosingCardRow {
  return {
    id: r.id,
    quoteNumber: r.quote_number,
    title: r.title,
    total: r.total,
    customerName: r.customerName,
    customerCompany: r.customerCompany,
    fileHref: closingFileHref(r),
    validUntil: r.valid_until,
    state: { sinceAt: r.state.sinceAt, sentLogged: r.state.sentLogged, daysWaiting: r.state.daysWaiting, offer: r.state.offer, why: r.state.why },
  };
}
