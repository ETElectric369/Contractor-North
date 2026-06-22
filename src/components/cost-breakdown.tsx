import { groupInvoiceLines, type InvoiceLine } from "@/lib/invoice-math";
import { formatCurrency } from "@/lib/utils";

/**
 * A compact "Labor / Materials" subtotal breakdown for a progress report / draw
 * invoice — so the customer sees what they're paying for at a glance. Renders
 * nothing for a plain invoice (no imported labor/materials). Pure presentational;
 * the breakdown is display-only and never changes the invoice total.
 */
export function CostBreakdown({ items, className = "" }: { items: InvoiceLine[]; className?: string }) {
  const g = groupInvoiceLines(items);
  if (!g.hasBreakdown) return null;

  const rows: { label: string; amount: number }[] = [];
  if (g.labor.lines.length) rows.push({ label: "Labor", amount: g.labor.subtotal });
  if (g.materials.lines.length) rows.push({ label: "Materials", amount: g.materials.subtotal });
  if (g.credits.lines.length) rows.push({ label: "Less previous billings", amount: g.credits.subtotal });
  if (g.other.lines.length) rows.push({ label: "Other", amount: g.other.subtotal });

  return (
    <div className={`rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm ${className}`}>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Cost breakdown</div>
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between py-0.5">
          <span className="text-slate-600">{r.label}</span>
          <span className="font-medium text-slate-900">{formatCurrency(r.amount)}</span>
        </div>
      ))}
    </div>
  );
}
