/** Pure money math for invoices/draws, extracted from the server actions so it can
 *  be unit-tested without a database. The actions do the DB I/O around these. */

/** Recompute an invoice's rollup from its line totals + payments. Negative line
 *  items (e.g. a "Less previous billings" credit) flow through naturally. Status
 *  auto-advances paid/partial/sent but never disturbs a voided invoice. */
export function recalcTotals(
  lineTotals: number[],
  paymentAmounts: number[],
  taxRate: number,
  currentStatus: string,
): { subtotal: number; tax: number; total: number; amountPaid: number; status: string } {
  const subtotal = lineTotals.reduce((s, n) => s + Number(n ?? 0), 0);
  const rate = Number(taxRate ?? 0);
  const tax = Math.round(subtotal * rate * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  const amountPaid = paymentAmounts.reduce((s, n) => s + Number(n ?? 0), 0);

  let status = currentStatus ?? "draft";
  if (status !== "void") {
    if (amountPaid >= total && total > 0) status = "paid";
    else if (amountPaid > 0) status = "partial";
    else if (status === "paid" || status === "partial") status = "sent";
  }
  return { subtotal, tax, total, amountPaid, status };
}

/** Decide the prior-billings credit on an Actual-T&M draw so the draw can never go
 *  negative. importedTotal = labor+materials just itemized; priorBilled = sum of
 *  prior SENT (non-void, non-draft) billings on the job.
 *  - importedTotal ~0 → nothing logged to bill ("no-work").
 *  - prior already covers the work → nothing new to bill ("covered").
 *  - otherwise → credit at most the imported work so the balance floors at $0. */
export function resolveDrawCredit(
  importedTotal: number,
  priorBilled: number,
): { ok: true; credit: number } | { ok: false; reason: "no-work" | "covered" } {
  if (importedTotal <= 0.005) return { ok: false, reason: "no-work" };
  if (priorBilled > 0.005 && importedTotal - priorBilled <= 0.005) return { ok: false, reason: "covered" };
  return { ok: true, credit: Math.round(Math.min(priorBilled, importedTotal) * 100) / 100 };
}

/** The dollar amount a deposit/progress draw bills: a % of the remaining estimate,
 *  or a fixed $. Percent is clamped 0-100. */
export function drawAmount(mode: "percent" | "fixed", value: number, remaining: number): number {
  if (mode === "percent") {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    return Math.round((remaining * pct) / 100 * 100) / 100;
  }
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Progress-report summary for a draw: % of the estimate completed (0 when there's
 *  no estimate — never divides by zero) and the balance left after this request. */
export function progressSummary(
  estimate: number,
  workToDate: number,
  received: number,
  thisAmount: number,
): { pctComplete: number; balance: number } {
  const pctComplete = estimate > 0 ? Math.round((workToDate / estimate) * 100) : 0;
  const balance = Math.round((estimate - received - thisAmount) * 100) / 100;
  return { pctComplete, balance };
}
