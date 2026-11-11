// One order for every list of invoices: newest first by created_at, then the higher invoice number
// first (numbers compared naturally, so INV-100 comes before INV-99 in a newest-first list).
type InvoiceOrderRow = { created_at?: string | null; invoice_number?: string | null };

export function newestInvoiceFirst(a: InvoiceOrderRow, b: InvoiceOrderRow): number {
  const ta = a.created_at ? Date.parse(a.created_at) : NaN;
  const tb = b.created_at ? Date.parse(b.created_at) : NaN;
  const va = Number.isNaN(ta) ? -Infinity : ta;
  const vb = Number.isNaN(tb) ? -Infinity : tb;
  if (va !== vb) return va > vb ? -1 : 1;
  return (b.invoice_number ?? "").localeCompare(a.invoice_number ?? "", "en", { numeric: true });
}
