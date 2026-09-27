/**
 * SALES TAX BY RATE, BILLED BASIS (lifted out of the Tax Report page so the accountant's download
 * reads the same arithmetic, never a second copy).
 *
 * Only issued invoices count (drafts and voids never do), and each is counted on the day it was
 * made: tax is owed when it is billed, not when it is paid. That is a different basis from every
 * other figure the accountant download carries (money counted the day it was paid), so every place
 * that shows these rows says "billed basis" beside them.
 */

/** The invoice columns this reads (invoices.created_at is the day the tax is counted). */
export const SALES_TAX_INVOICE_COLS = "tax_rate, tax, subtotal, total, status, created_at";

export type SalesTaxRow = { name: string; pct: number; taxable: number; tax: number; count: number };
export type SalesTaxSummary = { rows: SalesTaxRow[]; totalTaxable: number; totalTax: number };

export function summarizeSalesTax(
  invoices: { tax_rate?: unknown; tax?: unknown; subtotal?: unknown; status?: string | null }[] | null | undefined,
  taxRates: { name?: string | null; rate?: unknown }[] | null | undefined,
): SalesTaxSummary {
  // Only count real (issued) invoices — exclude drafts & voids.
  const real = (invoices ?? []).filter((i) => !["void", "draft"].includes(String(i?.status ?? "")));

  // Map a decimal tax_rate to a named jurisdiction when possible.
  const nameFor = (rateDec: number) => {
    const pct = rateDec * 100;
    // 0.001 was tighter than the rounding the old numeric(6,4) column forced (7.38 vs 7.375), so
    // a filing report showed "7.380%" with no jurisdiction. 0243 widened the column; keep a
    // tolerance that survives float round-tripping either way (audit v921).
    const match = (taxRates ?? []).find((t) => Math.abs(Number(t.rate) - pct) < 0.0005);
    return match?.name ?? (pct === 0 ? "No tax" : `${pct.toFixed(3)}%`);
  };

  // Group by rate.
  const groups = new Map<string, SalesTaxRow>();
  let totalTaxable = 0;
  let totalTax = 0;
  for (const i of real) {
    const rateDec = Number(i.tax_rate ?? 0);
    const key = (rateDec * 100).toFixed(3);
    const g = groups.get(key) ?? { name: nameFor(rateDec), pct: rateDec * 100, taxable: 0, tax: 0, count: 0 };
    g.taxable += Number(i.subtotal ?? 0);
    g.tax += Number(i.tax ?? 0);
    g.count += 1;
    groups.set(key, g);
    // "Taxable sales" = sales that actually carry tax. A 0% / exempt invoice is part of
    // total sales but NOT taxable — counting it here would overstate the taxable base
    // and mismatch what's owed. (It still shows in the per-rate breakdown under "No tax".)
    if (rateDec > 0) totalTaxable += Number(i.subtotal ?? 0);
    totalTax += Number(i.tax ?? 0);
  }
  const rows = [...groups.values()].sort((a, b) => b.tax - a.tax);
  return { rows, totalTaxable, totalTax };
}
