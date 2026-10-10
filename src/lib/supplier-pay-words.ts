/**
 * HOW A SUPPLIER WAS PAID, IN WORDS. One label per method (0270's five), shared by the pay sheet,
 * the payments list and the bill row, so "transfer" reads "ACH / Transfer" everywhere (task 4 E).
 */
import type { SupplierPayMethod } from "@/app/(app)/bills/supplier-balance";

export const SUPPLIER_PAY_METHOD_LABELS: Record<SupplierPayMethod, string> = {
  cash: "Cash",
  check: "Check",
  transfer: "ACH / Transfer",
  card: "Card",
  other: "Other",
};

export function supplierPayMethodLabel(method: string | null | undefined): string {
  return SUPPLIER_PAY_METHOD_LABELS[String(method ?? "") as SupplierPayMethod] ?? String(method ?? "Other");
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
