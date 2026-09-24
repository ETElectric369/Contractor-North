/**
 * ONE AMOUNT LANGUAGE FOR AN INVOICE ROW (2026-09-24).
 *
 * The billing board printed a draft's TOTAL, a revised bill's TOTAL, a sent bill's BALANCE and
 * the All Invoices row's BALANCE, all in the same bold figure with nothing saying which. So a
 * draft carrying a deposit read as more money owed than it was, and a sent bill with $8,000 paid
 * on it looked the same size as one with nothing paid.
 *
 * Every row leads with what is DUE (the balance), and says what it is due against ON THE SAME
 * LINE: "$1,558.62 due of $8,318.62". Erik 2026-09-23 (report d103cb9f): "All invoices should
 * show the total amount inline with the amount due" — a paid-in-full row read "$0.00 · Paid" with
 * the bill's size nowhere on screen, and a row with nothing paid never said what the bill was
 * for either. What has been PAID rides beneath as `note`. My Day's invoice items keep the older
 * `detail` phrasing (the same words, arranged for a title + subtitle).
 */
import { invoiceBalance, invoiceOverpayment } from "@/lib/invoice-math";
import { formatCurrency } from "@/lib/utils";

export type InvoiceAmount = {
  /** What is still owed, formatted. Always present. */
  due: string;
  /** The words after the figure on the same line: "due of $T", or "credit" for a credit memo. */
  against: string;
  /** The whole line as plain text — `${due} ${against}` — for places that can't style it. */
  line: string;
  /** What has been paid, for under the line: "$P paid", "paid in full", "$P paid · $O over".
   *  Null when nothing is paid (and for a credit memo, where "credit" already said it). */
  note: string | null;
  /** The combined context for a title + subtitle (My Day): "of $T · $P paid", or null when
   *  nothing has been paid. */
  detail: string | null;
};

export function invoiceAmount(total: number | null | undefined, amountPaid: number | null | undefined): InvoiceAmount {
  const t = Number(total);
  const p = Number(amountPaid);
  const tot = Number.isFinite(t) ? t : 0;
  const paid = Number.isFinite(p) ? p : 0;
  // A CREDIT MEMO (a negative total, which recalcTotals and paidStatus allow) is money going
  // back, not a $0.00 balance: invoiceBalance floors at 0, so it would print as nothing owed.
  if (tot <= -0.005) {
    const due = formatCurrency(tot);
    return { due, against: "credit", line: `${due} credit`, note: null, detail: "credit" };
  }
  const balance = invoiceBalance(tot, paid);
  const due = formatCurrency(balance);
  const against = `due of ${formatCurrency(tot)}`;
  const line = `${due} ${against}`;
  if (paid < 0.005) return { due, against, line, note: null, detail: null };
  const over = invoiceOverpayment(tot, paid);
  const note =
    over > 0
      ? `${formatCurrency(paid)} paid · ${formatCurrency(over)} over`
      : balance === 0
        ? "paid in full"
        : `${formatCurrency(paid)} paid`;
  return { due, against, line, note, detail: `of ${formatCurrency(tot)} · ${note}` };
}
