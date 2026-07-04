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

/** The status implied by a total vs amount paid — cents-tolerant (+0.005) so float
 *  dust (0.01 + 2.01 = 2.0199…) can't leave a fully-paid invoice stuck "partial".
 *  Shared by recalcTotals AND the Stripe webhook so online + manual payments agree.
 *  Never disturbs a voided invoice. */
export function paidStatus(total: number, amountPaid: number, currentStatus?: string): string {
  let status = currentStatus ?? "draft";
  if (status === "void") return status;
  const t = cents(fin(total));
  const paid = cents(fin(amountPaid));
  if (t <= 0.005) {
    // A $0 / credit-memo invoice is settled once it has left draft; a $0 draft stays draft.
    if (status !== "draft") status = "paid";
  } else if (paid + 0.005 >= t) status = "paid";
  else if (paid > 0) status = "partial";
  else if (status === "paid" || status === "partial") status = "sent";
  return status;
}

/** THE invoice balance owed: total − amount paid, never negative, rounded to cents. One
 *  definition so the ~18 inline `total - amount_paid` sites (the pay-route paid gate, the
 *  billing board/pipeline, the customer portal + email) can't disagree on rounding/flooring
 *  — e.g. the pay route used an UNROUNDED value, so 0.004 of float dust read as "still owed". */
export function invoiceBalance(total: number | null | undefined, amountPaid: number | null | undefined): number {
  return cents(Math.max(0, fin(total) - fin(amountPaid)));
}

/** Subtotal / tax / total from a set of line totals + a tax rate — the money rollup
 *  shared by invoices, quotes, and POs. Each figure is rounded to cents so float dust
 *  (0.01 + 2.01 = 2.0199…) can't accumulate, and — critically — a quote and the invoice
 *  it converts into round IDENTICALLY, because they run THIS one function. Negative line
 *  items (a "Less previous billings" credit) flow through naturally. */
export function subtotalTaxTotal(
  lineTotals: number[],
  taxRate: number,
): { subtotal: number; tax: number; total: number } {
  const subtotal = cents(lineTotals.reduce((s, n) => s + fin(n), 0));
  const tax = cents(subtotal * fin(taxRate));
  const total = cents(subtotal + tax);
  return { subtotal, tax, total };
}

/** Recompute an invoice's rollup from its line totals + payments. Adds amountPaid + the
 *  derived status on top of subtotalTaxTotal(). Status never disturbs a voided invoice. */
export function recalcTotals(
  lineTotals: number[],
  paymentAmounts: number[],
  taxRate: number,
  currentStatus: string,
): { subtotal: number; tax: number; total: number; amountPaid: number; status: string } {
  const { subtotal, tax, total } = subtotalTaxTotal(lineTotals, taxRate);
  const amountPaid = cents(paymentAmounts.reduce((s, n) => s + fin(n), 0));
  const status = paidStatus(total, amountPaid, currentStatus);
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

export type InvoiceLine = { description?: string | null; line_total?: number | null; import_source?: string | null };
export type LineBreakdown = {
  labor: { lines: InvoiceLine[]; subtotal: number };
  materials: { lines: InvoiceLine[]; subtotal: number };
  credits: { lines: InvoiceLine[]; subtotal: number };
  other: { lines: InvoiceLine[]; subtotal: number };
  /** True when there are labor OR material lines — i.e. worth showing the split. */
  hasBreakdown: boolean;
};

/** Group an invoice's line items into Labor / Materials / Credits / Other with a
 *  subtotal for each — so a progress report can show "Labor $X, Materials $Y" at a
 *  glance instead of a flat list. Keys off import_source ("labor"/"costs" from the
 *  importers, "draw_credit" for the prior-billings credit); a negative non-imported
 *  line is treated as a credit/adjustment, everything else as Other. Display-only —
 *  the real invoice total still comes from recalcTotals. */
export function groupInvoiceLines(items: InvoiceLine[]): LineBreakdown {
  const g: LineBreakdown = {
    labor: { lines: [], subtotal: 0 },
    materials: { lines: [], subtotal: 0 },
    credits: { lines: [], subtotal: 0 },
    other: { lines: [], subtotal: 0 },
    hasBreakdown: false,
  };
  for (const it of items ?? []) {
    const src = it.import_source;
    const desc = it.description ?? "";
    const amt = fin(it.line_total);
    // Prefer import_source; fall back to the importer's exact "Labor — " / "Materials — "
    // prefix (em dash + space) so the breakdown also works on surfaces (e.g. the public
    // RPC) that don't expose import_source — but tight enough that a hand-typed
    // "Labor - extra hour" isn't mistaken for imported labor. Only the genuine
    // prior-billings credit goes to `credits`; other negatives (manual discounts /
    // adjustments) stay in `other`, never mislabeled as "Less previous billings".
    const bucket: keyof LineBreakdown =
      src === "labor" || /^labor — /i.test(desc)
        ? "labor"
        : src === "costs" || /^materials — /i.test(desc)
          ? "materials"
          : src === "draw_credit" || /less previous billings/i.test(desc)
            ? "credits"
            : "other";
    (g[bucket] as { lines: InvoiceLine[]; subtotal: number }).lines.push(it);
    (g[bucket] as { lines: InvoiceLine[]; subtotal: number }).subtotal = cents(
      (g[bucket] as { lines: InvoiceLine[]; subtotal: number }).subtotal + amt,
    );
  }
  g.hasBreakdown = g.labor.lines.length > 0 || g.materials.lines.length > 0;
  return g;
}

/**
 * A clear, customer-facing statement of WHAT this invoice is: Time & Material vs
 * Fixed-Price, plus the draw stage if any. Returns null when the billing model is
 * unknown and there's no draw stage (a plain one-off invoice needs no label).
 */
export function invoiceTypeLabel(
  billingType?: string | null,
  invoiceKind?: string | null,
): string | null {
  const stage =
    invoiceKind === "deposit" ? "Deposit" :
    invoiceKind === "progress" ? "Progress Payment" :
    invoiceKind === "final" ? "Final Payment" : null;
  if (billingType === "tm") return stage ? `Time & Material · ${stage}` : "Time & Material";
  if (billingType === "fixed") return stage ? `Fixed-Price · ${stage}` : "Fixed-Price";
  return stage; // billing model unknown — show the stage if it's a draw, else nothing
}
