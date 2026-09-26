/**
 * PAY CED BY THE TENTH, AND WHAT IT SAVES (Erik, 2026-09-26: "go for all 3").
 *
 * "Pay CED $5,174.62 By Oct 10 · Saves $35.50 on 7 invoices." CED prints a prompt-pay discount on
 * every invoice and /bills already works it out ("Discount Still On The Table"). This brings that
 * one decision to My Day while the discount is still alive: the same figures, read by the same
 * functions, so the line on My Day and the card on /bills can never name two different numbers.
 *
 *   owed    supplierBalance(account).owed: under model B the supplier's own open balances (the
 *           "You owe" the payment sheet opens on). Never a second rule.
 *   payBy   claimableDiscounts(documents).nextDeadline: the soonest live discount deadline.
 *   saves   claimableDiscounts(documents).dueOnNext: ONLY the discount that rides on payBy, with a
 *           discount on an invoice a credit memo reversed left out, exactly as /bills leaves it.
 *           Never the whole "Discount Still On The Table" against the soonest date: an October
 *           invoice's Nov 10 discount is not lost on Oct 10, and /bills refuses to say it is
 *           (discountDeadlineSentence). That later slice gets its own line when its turn comes.
 *
 * PAYING CLEARS IT, KEYED TO THE PAYMENT (review 2, 2026-09-26). Under model B the balance is
 * CED's own papers, and a payment he records does not touch them. When CED applies it is not
 * something the app can see: a download inserts only NEW invoice numbers, and a paid-in-full stamp
 * closes an old one without touching its created_at. So a fresh paper proves nothing about his
 * cheque, and the line never asks it to. What it reads is the cheque itself (sentThisCycle): every
 * live payment dated inside this deadline's cycle, after the account's previous discount deadline
 * and on or before payBy. Once that covers the /bills net-if-paid-by for the documents dated on or
 * before the day he paid (and any later purchase still riding on payBy), the line goes and stays
 * gone till the deadline passes, whatever else lands: an October invoice downloaded on Oct 5 is
 * not what the Oct 10 cheque was for. A smaller chunk leaves the line as it was, naming what he
 * has sent as a fact.
 *
 * THE FIGURE NEVER MOVES FOR A PAYMENT. The title is supplierBalance(account).owed to the cent, the
 * "You owe" the door opens on. Subtracting a payment from it is a second rule for model B on a
 * second screen, and wrong the moment CED has applied that payment: the $1,360.93 double-count.
 * The one case the clear-off can come early: a chunk CED has already applied, re-downloaded inside
 * the same cycle, then more chunks on top. The papers show that chunk and so does `sent`. The app
 * suggests; /bills still names the discount and the balance.
 *
 * SHOWN ONLY WHILE IT CAN SAVE HIM SOMETHING SOON: the soonest deadline is today or within the
 * next PAY_CARD_WINDOW_DAYS days. Once it passes, the discount is not live, the slice moves to the
 * next deadline (or is empty), and the line goes: no nag with nothing to save. Dated, one per
 * account, and gone on its own: the BADGE INVARIANT (action-items/types.ts).
 *
 * Only for an account ON ACCOUNT under model B (the supplier's own documents): the /bills
 * discount card only offers Record A Payment there, and a line whose door opens nothing is a dead
 * door. Pure; the My Day loader (supplier-papers.ts) hands it rows it already read.
 */

import {
  r2,
  supplierBalance,
  supplierNetIfPaidBy,
  daysBetweenYmd,
  type SupplierAccountRow,
} from "./supplier-balance";
import { claimableDiscounts, shortSupplierName, type SupplierInvoiceRow } from "./supplier-reconcile";

/** How far ahead of the deadline the line appears. Two weeks: one statement cycle's notice. */
export const PAY_CARD_WINDOW_DAYS = 14;

export interface SupplierPayDue {
  accountId: string;
  /** The account's full name, for the payment sheet. */
  accountName: string;
  /** What he calls them on a line: "CED". */
  supplier: string;
  /** What the supplier says is owed: the /bills payment sheet's "You owe", to the cent. */
  owed: number;
  /** The discount that rides on `payBy`: what is lost if that day passes unpaid. */
  saves: number;
  /** How many invoices carry that slice. */
  invoices: number;
  /** Live payments dated in this deadline's cycle (sentThisCycle). A fact on the line, never off `owed`. */
  sent: number;
  /** The soonest live discount deadline, "YYYY-MM-DD". */
  payBy: string;
  /** Days from the org's today until `payBy`. 0 = today. */
  daysLeft: number;
}

/** One supplier_payments row as the loader reads it. */
export interface SentPaymentRow {
  supplier_account_id?: string | null;
  amount?: number | string | null;
  paid_on?: string | null;
  voided_at?: string | null;
}

/**
 * WHAT HE HAS SENT TOWARD THIS DEADLINE. A live payment counts when it is DATED (paid_on, the day
 * he wrote it) after the account's previous discount deadline and on or before payBy: a cheque
 * written on or before Sep 10 went to the Sep 10 papers, one written Sep 11 to Oct 10 goes to Oct
 * 10's. The previous deadline comes off his own documents, open or closed. An account whose
 * documents name no earlier deadline starts the cycle at the first invoice riding on payBy.
 * `lastPaidOn` is the newest of those days: the documents dated after it are not what he paid.
 */
export function sentThisCycle(input: {
  documents: SupplierInvoiceRow[];
  payments: SentPaymentRow[];
  accountId: string;
  payBy: string;
}): { sent: number; lastPaidOn: string | null } {
  const ymd = (v: unknown): string => String(v ?? "").slice(0, 10);
  const isYmd = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  let previous = "";
  let firstOnPayBy = "";
  for (const d of input.documents ?? []) {
    const by = ymd(d?.discountBy);
    if (isYmd(by) && by < input.payBy && by > previous) previous = by;
    const on = ymd(d?.invoiceDate);
    if (!d?.closed && by === input.payBy && isYmd(on) && (!firstOnPayBy || on < firstOnPayBy)) firstOnPayBy = on;
  }
  let sent = 0;
  let lastPaidOn: string | null = null;
  for (const p of input.payments ?? []) {
    if (String(p?.supplier_account_id ?? "") !== input.accountId || p?.voided_at) continue;
    const on = ymd(p?.paid_on);
    if (!isYmd(on) || on > input.payBy) continue;
    if (previous ? on <= previous : !firstOnPayBy || on < firstOnPayBy) continue;
    const amount = r2(Number(p?.amount) || 0);
    if (!(amount > 0)) continue;
    sent = r2(sent + amount);
    if (!lastPaidOn || on > lastPaidOn) lastPaidOn = on;
  }
  return { sent, lastPaidOn };
}

/**
 * The accounts worth a line today. `rows` are supplierDocumentRows' rows (every account's documents
 * together); `accounts` the org's supplier accounts; `today` the ORG's today.
 */
export function supplierPayDue(input: {
  rows: SupplierInvoiceRow[];
  accounts: { id: string; name: string | null; on_account?: boolean | null }[];
  today: string;
  /** His live supplier_payments rows (every account's): what clears a line (sentThisCycle). */
  payments?: SentPaymentRow[] | null;
}): SupplierPayDue[] {
  const today = input.today;
  const byAccount = new Map<string, SupplierInvoiceRow[]>();
  for (const row of input.rows ?? []) {
    const id = String(row.supplierAccountId ?? "");
    if (id) byAccount.set(id, [...(byAccount.get(id) ?? []), row]);
  }
  const out: SupplierPayDue[] = [];
  for (const a of input.accounts ?? []) {
    const id = String(a.id ?? "");
    const documents = byAccount.get(id) ?? [];
    // Register accounts carry no running balance; /bills offers no payment from the discount card.
    if (!id || !documents.length || a.on_account === false) continue;
    // THE SAME TWO READINGS /bills MAKES: the balance card's owed, the discount card's slice.
    const account: SupplierAccountRow = {
      id,
      name: String(a.name ?? ""),
      accountNumber: null,
      branchCode: null,
      onAccount: true,
      note: null,
      aliases: [],
      bills: [],
      payments: [],
      supplierInvoices: documents,
    };
    const balance = supplierBalance(account, today);
    if (balance.model !== "supplier-invoices" || balance.owed === null || !(balance.owed > 0.005)) continue;
    const claim = claimableDiscounts(documents, today);
    if (!(claim.dueOnNext > 0.005) || !claim.nextDeadline) continue;
    const payBy = claim.nextDeadline;
    const daysLeft = daysBetweenYmd(today, payBy);
    if (daysLeft === null || daysLeft < 0 || daysLeft > PAY_CARD_WINDOW_DAYS) continue;
    // Already sent what the cheque the /bills card names would have been: he has done what the line
    // asked. Measured against the papers dated on or before the day he wrote it, plus any dated
    // later whose own discount still rides on payBy (a Sep 29 purchase is Oct 10's business, and
    // the line comes back for it). An October invoice with a Nov 10 discount is not: it lands
    // afterwards and changes nothing here.
    const { sent, lastPaidOn } = sentThisCycle({ documents, payments: input.payments ?? [], accountId: id, payBy });
    if (sent > 0.005 && lastPaidOn) {
      const paidAgainst = documents.filter((d) => {
        const on = String(d.invoiceDate ?? "").slice(0, 10);
        const by = String(d.discountBy ?? "").slice(0, 10);
        return !on || on <= lastPaidOn || (!!by && by <= payBy);
      });
      if (sent >= supplierNetIfPaidBy(paidAgainst, payBy, today).net - 0.005) continue;
    }
    // The /bills figure, to the cent: a payment never comes off it here (supplierBalance's rule).
    const owed = balance.owed;
    out.push({
      accountId: id,
      accountName: account.name,
      supplier: shortSupplierName(a.name),
      owed,
      saves: claim.dueOnNext,
      invoices: claim.rows.filter((r) => r.reading.by === payBy).length,
      sent,
      payBy,
      daysLeft,
    });
  }
  return out.sort((x, y) => x.payBy.localeCompare(y.payBy) || y.saves - x.saves);
}
