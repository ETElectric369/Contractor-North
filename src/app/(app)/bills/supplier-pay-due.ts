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
 * PAYING CLEARS IT (review, 2026-09-26). Under model B the balance is CED's own papers, and a
 * payment he records does not touch them: only the next CED download closes anything. So a
 * payment recorded AFTER the newest paper landed, and dated on or after that day, is money CED's
 * papers cannot show yet (sentSinceTheirPapers). Once it covers the cheque the line asks for (the
 * /bills net if paid by payBy) the line goes: he has done what it asked. A smaller chunk comes off
 * the figure the line names, and the line says so. The balance itself is untouched: that is
 * supplierBalance's rule, and subtracting the payments there is the $1,360.93 double-count.
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
import { todayStrInTz } from "@/lib/tz";
import { claimableDiscounts, shortSupplierName, type SupplierInvoiceRow } from "./supplier-reconcile";

/** How far ahead of the deadline the line appears. Two weeks: one statement cycle's notice. */
export const PAY_CARD_WINDOW_DAYS = 14;

export interface SupplierPayDue {
  accountId: string;
  /** The account's full name, for the payment sheet. */
  accountName: string;
  /** What he calls them on a line: "CED". */
  supplier: string;
  /** What the supplier says is owed (the /bills payment sheet's "You owe"), less `sent`. */
  owed: number;
  /** The discount that rides on `payBy`: what is lost if that day passes unpaid. */
  saves: number;
  /** How many invoices carry that slice. */
  invoices: number;
  /** Money he recorded sending since CED's newest papers landed, which they cannot show yet. */
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
  created_at?: string | null;
  voided_at?: string | null;
}

/**
 * MONEY CED'S PAPERS CANNOT SHOW YET, per account. A live payment counts when it was RECORDED
 * after the account's newest document landed (supplier_invoices.created_at) and PAID on or after
 * that day in the org's timezone. A cheque written before the download is already in what CED
 * closed, even when he records it later; counting it again is the double-count model B exists to
 * stop. An account with no documents has no papers to be ahead of, so it has nothing here.
 */
export function sentSinceTheirPapers(input: {
  documents: { supplier_account_id?: string | null; created_at?: string | null }[];
  payments: SentPaymentRow[];
  tz?: string | null;
}): Map<string, number> {
  const landed = new Map<string, string>();
  for (const d of input.documents ?? []) {
    const id = String(d?.supplier_account_id ?? "");
    const at = String(d?.created_at ?? "");
    if (!id || !at) continue;
    if (!landed.has(id) || at > (landed.get(id) as string)) landed.set(id, at);
  }
  const dayOf = (iso: string): string => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso.slice(0, 10);
    try {
      return input.tz ? todayStrInTz(input.tz, at) : at.toISOString().slice(0, 10);
    } catch {
      return at.toISOString().slice(0, 10);
    }
  };
  const out = new Map<string, number>();
  for (const p of input.payments ?? []) {
    const id = String(p?.supplier_account_id ?? "");
    const at = landed.get(id);
    if (!id || !at || p?.voided_at) continue;
    const recorded = new Date(String(p?.created_at ?? "")).getTime();
    if (!(recorded > new Date(at).getTime())) continue;
    if (String(p?.paid_on ?? "").slice(0, 10) < dayOf(at)) continue;
    const amount = Number(p?.amount) || 0;
    if (amount > 0) out.set(id, r2((out.get(id) ?? 0) + amount));
  }
  return out;
}

/**
 * The accounts worth a line today. `rows` are supplierDocumentRows' rows (every account's documents
 * together); `accounts` the org's supplier accounts; `today` the ORG's today.
 */
export function supplierPayDue(input: {
  rows: SupplierInvoiceRow[];
  accounts: { id: string; name: string | null; on_account?: boolean | null }[];
  today: string;
  /** sentSinceTheirPapers: money recorded since CED's newest papers, by account. */
  sent?: Map<string, number> | null;
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
    // Already sent what the cheque dated payBy would be (the /bills figure): he has done it.
    const sent = r2(input.sent?.get(id) ?? 0);
    if (sent > 0.005 && sent >= supplierNetIfPaidBy(documents, payBy, today).net - 0.005) continue;
    const owed = r2(balance.owed - sent);
    if (!(owed > 0.005)) continue;
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
