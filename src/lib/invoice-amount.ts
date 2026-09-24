/**
 * ONE AMOUNT LANGUAGE FOR AN INVOICE ROW (2026-09-24).
 *
 * The billing board printed a draft's TOTAL, a revised bill's TOTAL, a sent bill's BALANCE and
 * the All Invoices row's BALANCE, all in the same bold figure with nothing saying which. So a
 * draft carrying a deposit read as more money owed than it was, and a sent bill with $8,000 paid
 * on it looked the same size as one with nothing paid.
 *
 * Every row now leads with what is DUE (the balance) and, when anything has been paid, says what
 * it is due against underneath: "of $T · $P paid". My Day's invoice items use the same words.
 */
import { invoiceBalance, invoiceOverpayment } from "@/lib/invoice-math";
import { formatCurrency } from "@/lib/utils";

export type InvoiceAmount = {
  /** What is still owed, formatted. Always present. */
  due: string;
  /** The context under it, or null when nothing has been paid (the due IS the total then). */
  detail: string | null;
};

export function invoiceAmount(total: number | null | undefined, amountPaid: number | null | undefined): InvoiceAmount {
  const t = Number(total);
  const p = Number(amountPaid);
  const tot = Number.isFinite(t) ? t : 0;
  const paid = Number.isFinite(p) ? p : 0;
  // A CREDIT MEMO (a negative total, which recalcTotals and paidStatus allow) is money going
  // back, not a $0.00 balance: invoiceBalance floors at 0, so it would print as nothing owed.
  if (tot <= -0.005) return { due: formatCurrency(tot), detail: "credit" };
  const balance = invoiceBalance(tot, paid);
  const due = formatCurrency(balance);
  if (paid < 0.005) return { due, detail: null };
  const over = invoiceOverpayment(tot, paid);
  if (over > 0) {
    return { due, detail: `of ${formatCurrency(tot)} · ${formatCurrency(paid)} paid · ${formatCurrency(over)} over` };
  }
  if (balance === 0) return { due, detail: `of ${formatCurrency(tot)} · paid in full` };
  return { due, detail: `of ${formatCurrency(tot)} · ${formatCurrency(paid)} paid` };
}
