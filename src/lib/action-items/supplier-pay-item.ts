import type { SupplierPayDue } from "@/app/(app)/bills/supplier-pay-due";
import { formatCurrency, formatDateShort } from "@/lib/utils";
import { AFFORDANCES, KIND_GROUP, type ActionItem } from "./types";

/** The door: /bills with the account's Record a Payment sheet already open (suppliers-card.tsx). */
export function supplierPayHref(accountId: string): string {
  return `/bills?pay=${encodeURIComponent(accountId)}`;
}

/**
 * "PAY CED $5,174.62 BY OCT 10 · Saves $35.50 on 7 invoices" (Erik, 2026-09-26).
 *
 * One line per supplier account whose own open documents carry a live prompt-pay discount due
 * within two weeks (supplierPayDue decides; this only words it). Dated by the deadline, so it
 * carries its own expiry and goes on its own once the discount does: the BADGE INVARIANT
 * (types.ts). The app suggests the date and the figure; he decides what to send, on the sheet.
 *
 * "Saves" is only the discount that rides on that date (supplierPayDue: claim.dueOnNext), the same
 * slice /bills names; a later deadline's discount gets its own line when its turn comes. The figure
 * is the /bills "You owe" to the cent; a chunk he has sent toward this deadline is named beside it
 * as a fact, never taken off it (supplierPayDue).
 */
export function supplierPayActionItems(dues: SupplierPayDue[] | null | undefined): ActionItem[] {
  return (dues ?? []).map((d) => ({
    id: `supplierpay-${d.accountId}`, // synthetic (kind-prefixed): open-only, never dispatched
    kind: "supplier_pay" as const,
    group: KIND_GROUP.supplier_pay,
    title: `Pay ${d.supplier} ${formatCurrency(d.owed)} by ${formatDateShort(d.payBy)}`,
    subtitle:
      `Saves ${formatCurrency(d.saves)} on ${d.invoices} ${d.invoices === 1 ? "invoice" : "invoices"}` +
      (d.sent > 0.005 ? ` · ${formatCurrency(d.sent)} already sent` : ""),
    // The box's words (cn-v1161): the supplier in bold, the deadline and the saving as a key and its
    // slots, a chunk already sent as a second phrase, and what is owed at the right edge.
    who: d.supplier,
    what: {
      key: d.invoices === 1 ? "ny_w_payBySavesOne" : "ny_w_payBySavesMany",
      vars: { day: d.payBy, money: d.saves, n: d.invoices, ...(d.sent > 0.005 ? { andKey: "ny_w_alreadySent", money2: d.sent } : {}) },
    },
    amount: d.owed,
    when: d.payBy,
    // Red "!" only in the last three days, when waiting a little longer loses it.
    urgency: d.daysLeft <= 3 ? 2 : 1,
    done: false,
    href: supplierPayHref(d.accountId),
    affordances: AFFORDANCES.supplier_pay,
  }));
}
