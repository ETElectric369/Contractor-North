/** Pure money math for invoices/draws, extracted from the server actions so it can
 *  be unit-tested without a database. The actions do the DB I/O around these.
 *  Inputs come from the DB / JSONB / free-edit UI, so every numeric input is run
 *  through `fin` — a single NaN/Infinity/null must never poison a money total. */

/** Coerce to a finite number, else 0. */
const fin = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number) => Math.round(n * 100) / 100;

/** Recompute an invoice's rollup from its line totals + payments. Negative line
 *  items (a "Less previous billings" credit) flow through naturally. Amounts are
 *  rounded to cents so float dust (0.01 + 2.01 summing to 2.0199…) can't leave a
 *  fully-paid invoice stuck "partial". Status never disturbs a voided invoice. */
export function recalcTotals(
  lineTotals: number[],
  paymentAmounts: number[],
  taxRate: number,
  currentStatus: string,
): { subtotal: number; tax: number; total: number; amountPaid: number; status: string } {
  const subtotal = cents(lineTotals.reduce((s, n) => s + fin(n), 0));
  const tax = cents(subtotal * fin(taxRate));
  const total = cents(subtotal + tax);
  const amountPaid = cents(paymentAmounts.reduce((s, n) => s + fin(n), 0));

  let status = currentStatus ?? "draft";
  if (status !== "void") {
    if (total <= 0.005) {
      // A $0 / credit-memo invoice is settled once it has left draft; a $0 draft stays draft.
      if (status !== "draft") status = "paid";
    } else if (amountPaid + 0.005 >= total) status = "paid";
    else if (amountPaid > 0) status = "partial";
    else if (status === "paid" || status === "partial") status = "sent";
  }
  return { subtotal, tax, total, amountPaid, status };
}

/** Decide the prior-billings credit on an Actual-T&M draw so the draw can never go
 *  negative. importedTotal = labor+materials just itemized; priorBilled = sum of
 *  prior SENT billings on the job (floored at 0 — a negative/NaN prior is treated
 *  as no prior so it can never ADD money to the invoice).
 *  - importedTotal ~0 (or non-finite) → nothing to bill ("no-work").
 *  - prior already covers the work → nothing new to bill ("covered").
 *  - otherwise → credit at most the imported work so the balance floors at $0. */
export function resolveDrawCredit(
  importedTotal: number,
  priorBilled: number,
): { ok: true; credit: number } | { ok: false; reason: "no-work" | "covered" } {
  const work = fin(importedTotal);
  const prior = Math.max(0, fin(priorBilled));
  if (work <= 0.005) return { ok: false, reason: "no-work" };
  if (prior > 0.005 && work - prior <= 0.005) return { ok: false, reason: "covered" };
  return { ok: true, credit: cents(Math.max(0, Math.min(prior, work))) };
}

/** The dollar amount a deposit/progress draw bills: a % of the remaining estimate,
 *  or a fixed $. Floored at $0 and finite — a draw never bills a negative/NaN. */
export function drawAmount(mode: "percent" | "fixed", value: number, remaining: number): number {
  const rem = Math.max(0, fin(remaining));
  if (mode === "percent") {
    const pct = Math.max(0, Math.min(100, fin(value)));
    return Math.max(0, cents((rem * pct) / 100));
  }
  return Math.max(0, cents(fin(value)));
}

/** H4: a STANDARD invoice on a job already billed via progress draws would
 *  double-bill the work the draws cover — block importing labor/materials onto it.
 *  (A draw invoice IS the billing path, so it's never blocked.) */
export function shouldBlockStandardImport(invoiceKind: string | null | undefined, hasOtherDraws: boolean): boolean {
  return (invoiceKind ?? "standard") === "standard" && hasOtherDraws;
}

/** H4, the REVERSE direction: a job already being billed on a STANDARD invoice that
 *  CARRIES CONTENT (line items / a non-zero total) must NOT also get a progress draw —
 *  the draw re-bills the same labor / materials / scope, double-charging the customer.
 *  The mirror of shouldBlockStandardImport: that one blocks standard content when a
 *  draw exists; this one blocks a draw when standard content exists. A blank standard
 *  invoice (no lines, $0) carries nothing yet, so it never blocks. */
export function isStandardBillingBlocker(
  invoiceKind: string | null | undefined,
  total: number,
  lineItemCount: number,
): boolean {
  const isStandard = (invoiceKind ?? "standard") === "standard";
  return isStandard && (fin(total) > 0.005 || fin(lineItemCount) > 0);
}

/** Progress-report summary for a draw: % of the estimate completed (0 when there's
 *  no estimate — never divides by zero) and the balance left after this request
 *  (0 without an estimate, so it can't show a misleading negative). All finite. */
export function progressSummary(
  estimate: number,
  workToDate: number,
  received: number,
  thisAmount: number,
): { pctComplete: number; balance: number } {
  const est = fin(estimate);
  const pctComplete = est > 0 ? Math.round((fin(workToDate) / est) * 100) : 0;
  const balance = est > 0 ? cents(est - fin(received) - fin(thisAmount)) : 0;
  return { pctComplete, balance };
}
