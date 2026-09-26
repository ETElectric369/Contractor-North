import type { SupplierPayDue } from "@/app/(app)/bills/supplier-pay-due";
import { formatCurrency, formatDateShort } from "@/lib/utils";
import { AFFORDANCES, KIND_STREAM, type ActionItem } from "./types";

/** The door: /bills with the account's Record A Payment sheet already open (suppliers-card.tsx). */
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
    stream: KIND_STREAM.supplier_pay,
    title: `Pay ${d.supplier} ${formatCurrency(d.owed)} By ${formatDateShort(d.payBy)}`,
    subtitle:
      `Saves ${formatCurrency(d.saves)} on ${d.invoices} ${d.invoices === 1 ? "invoice" : "invoices"}` +
      (d.sent > 0.005 ? ` · ${formatCurrency(d.sent)} already sent` : ""),
    who: null,
    when: d.payBy,
    // Red "!" only in the last three days, when waiting a little longer loses it.
    urgency: d.daysLeft <= 3 ? 2 : 1,
    done: false,
    href: supplierPayHref(d.accountId),
    affordances: AFFORDANCES.supplier_pay,
  }));
}
