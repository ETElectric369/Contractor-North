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
 *   saves   claimableDiscounts(documents).total: the "Discount Still On The Table" figure, with a
 *           discount on an invoice a credit memo reversed left out, exactly as /bills leaves it.
 *   payBy   that slice's soonest deadline. Paying by it claims every live discount, since every
 *           other live one runs later.
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
  /** What the supplier says is owed. The /bills payment sheet's "You owe" figure. */
  owed: number;
  /** Discount still on the table if he pays by `payBy`. */
  saves: number;
  /** How many invoices carry it. */
  invoices: number;
  /** The soonest live discount deadline, "YYYY-MM-DD". */
  payBy: string;
  /** Days from the org's today until `payBy`. 0 = today. */
  daysLeft: number;
}

/**
 * The accounts worth a line today. `rows` are supplierDocumentRows' rows (every account's documents
 * together); `accounts` the org's supplier accounts; `today` the ORG's today.
 */
export function supplierPayDue(input: {
  rows: SupplierInvoiceRow[];
  accounts: { id: string; name: string | null; on_account?: boolean | null }[];
  today: string;
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
    if (!(claim.total > 0.005) || !claim.nextDeadline) continue;
    const daysLeft = daysBetweenYmd(today, claim.nextDeadline);
    if (daysLeft === null || daysLeft < 0 || daysLeft > PAY_CARD_WINDOW_DAYS) continue;
    out.push({
      accountId: id,
      accountName: account.name,
      supplier: shortSupplierName(a.name),
      owed: r2(balance.owed),
      saves: claim.total,
      invoices: claim.rows.length,
      payBy: claim.nextDeadline,
      daysLeft,
    });
  }
  return out.sort((x, y) => x.payBy.localeCompare(y.payBy) || y.saves - x.saves);
}
