/**
 * HOW A SUPPLIER WAS PAID, IN WORDS. One label per method, shared by the pay sheet, the payments
 * list and the bill row (task 4 E). Since cn-v1152 the label is THE one every door renders
 * (lib/payment-method paymentMethodLabel: Check, Transfer, Venmo, Apple Cash) — this module kept a
 * five-word table of its own ("ACH / Transfer") until Erik, 2026-11-07: "there are some payment
 * entry windows that show venmo as an option then others that dont". The supplier's method is a
 * 0287 key from the company's one list, and it reads the same here as on an invoice.
 */
import { paymentMethodLabel } from "@/lib/payment-method";

export function supplierPayMethodLabel(method: string | null | undefined): string {
  return paymentMethodLabel(method);
}

/** The recorded payment that paid a bill: how, and the day. */
export type PaidBy = { method: string; paidOn: string };

/**
 * WHICH PAYMENT PAID EACH BILL (0383's allocations). The latest non-void payment on the bill wins
 * the row's words; a voided payment is a fact crossed out, never the answer. A bill nothing is
 * allocated to is absent — a bill marked paid by hand says nothing about how.
 */
export function paidByOfBills(
  allocations: readonly { supplier_payment_id?: unknown; bill_id?: unknown }[] | null | undefined,
  payments: readonly { id?: unknown; paid_on?: unknown; method?: unknown; voided_at?: unknown }[] | null | undefined,
): Map<string, PaidBy> {
  const live = new Map<string, PaidBy>();
  for (const p of payments ?? []) {
    if (!p?.id || p.voided_at) continue;
    live.set(String(p.id), { method: String(p.method ?? "other"), paidOn: String(p.paid_on ?? "").slice(0, 10) });
  }
  const out = new Map<string, PaidBy>();
  for (const a of allocations ?? []) {
    const bill = String(a?.bill_id ?? "");
    const pay = live.get(String(a?.supplier_payment_id ?? ""));
    if (!bill || !pay) continue;
    const have = out.get(bill);
    if (!have || pay.paidOn > have.paidOn) out.set(bill, pay);
  }
  return out;
}

/** "Paid by ACH / Transfer on Oct 3". */
export function paidByLine(paidBy: PaidBy | null | undefined, formatDay: (iso: string) => string): string | null {
  if (!paidBy) return null;
  const how = supplierPayMethodLabel(paidBy.method);
  return paidBy.paidOn ? `Paid by ${how} on ${formatDay(paidBy.paidOn)}` : `Paid by ${how}`;
}
