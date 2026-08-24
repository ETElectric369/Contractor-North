/**
 * WHICH CHANGE ORDERS BECOME INVOICE LINES, and what those lines say.
 *
 * Split out of importChangeOrdersIntoInvoice so the two decisions that actually matter — which
 * ones count as money, and what the customer reads on the invoice — can be pinned by tests
 * instead of living inside a server action nothing can call.
 *
 * Background: `change_orders` shipped with a co_number, a description, an amount and an
 * approve/reject control, and the amount was read by NOTHING in the app. You could raise a change
 * order, get it approved, and the money never appeared on any invoice, any contract total, or any
 * profitability figure.
 */

export type ChangeOrderRow = {
  id: string;
  co_number: string | null;
  description: string | null;
  amount: number | null;
  status?: string | null;
};

export type ChangeOrderLine = {
  import_key: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

/**
 * APPROVED ONLY. A pending change order is a proposal and a rejected one is a decision — billing
 * either would be inventing an agreement the customer never made.
 *
 * Callers normally filter in the query too; this repeats it because a filter that exists in only
 * one place is a convention, not a rule, and the one place is a `.eq()` that a future refactor
 * can drop without anything failing loudly.
 */
export function billableChangeOrders(rows: ChangeOrderRow[]): ChangeOrderRow[] {
  return rows.filter(
    (c) =>
      (c.status === undefined || c.status === null || c.status === "approved") &&
      Number(c.amount ?? 0) !== 0,
  );
}

/**
 * NAME THE DOCUMENT THE CUSTOMER SIGNED OFF ON.
 *
 * A line reading "Extra work — $1,800" starts an argument; "Change order CO-003 — Add two
 * exterior receptacles" ends it, because they are holding that piece of paper. Same reasoning as
 * the labour importer naming whose bill rate it used: a line that explains itself never becomes a
 * phone call.
 */
export function changeOrderDescription(c: ChangeOrderRow): string {
  const head = c.co_number ? `Change order ${c.co_number}` : "Change order";
  const detail = (c.description ?? "").trim();
  return detail ? `${head} — ${detail}` : head;
}

/**
 * One line per change order, keyed `co:<id>` so a re-import updates the line rather than
 * appending a second one, and a change order approved later appends without disturbing the rest.
 *
 * A CREDIT IS A REAL CHANGE ORDER. Negative amounts pass through untouched — deleting scope is as
 * ordinary as adding it, and a change order that takes $900 back off the job has to be able to
 * reach the invoice or the customer is overbilled by exactly the amount they negotiated away.
 * Only ZERO is dropped, because a zero-dollar line is noise on a document.
 */
export function changeOrderLines(rows: ChangeOrderRow[]): ChangeOrderLine[] {
  return billableChangeOrders(rows).map((c) => ({
    import_key: `co:${c.id}`,
    description: changeOrderDescription(c),
    quantity: 1,
    unit: "ea",
    unit_price: Number(c.amount ?? 0),
  }));
}

/**
 * Why there is nothing to import, in the words the office needs. "No approved change orders" and
 * "your approved change orders are all $0" are different problems with different fixes, and
 * collapsing them into one message sends somebody looking in the wrong place.
 */
export function noChangeOrdersReason(rows: ChangeOrderRow[]): string {
  const approved = rows.filter((c) => !c.status || c.status === "approved");
  if (!rows.length) return "No approved change orders on this job yet.";
  if (!approved.length) return "No change orders on this job have been approved yet.";
  return "The approved change orders on this job are all $0 — put an amount on them first.";
}
