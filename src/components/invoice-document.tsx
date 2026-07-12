import { formatCurrency, formatDate } from "@/lib/utils";
import { DocHeader, DocParty, DocTotals, DocNote, DocDescription, type DocPartyCustomer } from "@/components/doc-templates";
import { LineItemText } from "@/components/line-item-text";
import { CostBreakdown } from "@/components/cost-breakdown";
import { ProgressReportCard } from "@/components/progress-report-card";
import { invoiceBalance, type InvoiceLine } from "@/lib/invoice-math";

/**
 * THE single invoice document body. Every read-only surface — the print/PDF page,
 * the public /i link, and the in-app preview — renders THIS, so they can never drift
 * (the old "print is inconsistent with the preview"). Page-specific chrome (back/
 * print/pay buttons, action bars) stays in each page around it. Sections that depend
 * on data a given surface doesn't have (payments, terms, progress) are conditional,
 * so each page passes what it has and the shared parts always match.
 */
export type InvoiceDocItem = InvoiceLine & {
  id?: string;
  quantity: number;
  unit?: string | null;
  unit_price: number;
  line_total: number;
};

export function InvoiceDocument({
  co,
  template,
  number,
  createdAt,
  dueDate,
  title,
  billingLabel,
  description,
  customer,
  items,
  subtotal,
  taxRate,
  tax,
  total,
  amountPaid,
  payments,
  notes,
  terms,
  documentFooter,
  progress,
}: {
  co: any;
  template: any;
  number: string;
  createdAt: string | Date;
  dueDate?: string | Date | null;
  title?: string | null;
  billingLabel?: string | null;
  description?: string | null;
  customer: DocPartyCustomer;
  items: InvoiceDocItem[];
  subtotal: number;
  taxRate?: number | null;
  tax: number;
  total: number;
  amountPaid: number;
  payments?: { id?: string; paid_at: string; method?: string | null; note?: string | null; amount: number }[];
  notes?: string | null;
  terms?: string | null;
  documentFooter?: string | null;
  progress?: { estimate: number; workToDate: number; received: number; thisAmount: number; billingType: any } | null;
}) {
  const c = customer;
  const balance = invoiceBalance(total, amountPaid); // floored at 0 — never a negative "Please remit"

  return (
    <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
      <DocHeader
        co={co}
        template={template}
        meta={{
          docType: "Invoice",
          number,
          rows: [
            { label: "Date", value: formatDate(createdAt) },
            ...(dueDate ? [{ label: "Due", value: formatDate(dueDate) }] : []),
          ],
        }}
      />

      {/* Bill-to (two columns to save vertical space: identity + contact | location)
          + Balance. Mirrors the letterhead grouping above — contact behind an accent rule. */}
      <div className="mt-6 flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <DocParty label="Bill to" customer={c} brand={co.brand} />
        </div>
        <div className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-5 py-3 text-right">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Balance due</div>
          <div className="text-2xl font-bold text-slate-900">{formatCurrency(balance)}</div>
        </div>
      </div>

      {/* A clear statement of what this invoice is — Time & Material vs Fixed-Price. */}
      {billingLabel && (
        <div className="mt-5">
          <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            {billingLabel}
          </span>
        </div>
      )}
      {title && <div className={`${billingLabel ? "mt-3" : "mt-5"} text-base font-semibold text-slate-900`}>{title}</div>}

      {/* Scope / description — above the line items. */}
      {description && <DocDescription text={description} />}

      {/* Line items */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[460px] text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Qty</th>
              <th className="py-2 text-right font-semibold">Price</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.id ?? i} className="border-b border-slate-100">
                <td className="py-2 pr-2 text-slate-800">
                  <LineItemText description={it.description ?? ""} />
                </td>
                <td className="py-2 text-right text-slate-600">{it.quantity} {it.unit}</td>
                <td className="py-2 text-right text-slate-600">{formatCurrency(it.unit_price)}</td>
                <td className="py-2 text-right font-medium text-slate-900">{formatCurrency(it.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Labor / Materials breakdown (progress reports & job invoices) */}
      <div className="mt-4 flex justify-end">
        <CostBreakdown items={items} className="w-64" />
      </div>

      {/* Totals — invoice passes balance, so Paid + Balance-due render and Balance is the bold line. */}
      <DocTotals subtotal={subtotal} taxRate={taxRate} tax={tax} total={total} amountPaid={amountPaid} balance={balance} />

      {progress && (
        <div className="mt-6">
          <ProgressReportCard
            estimate={progress.estimate}
            workToDate={progress.workToDate}
            received={progress.received}
            thisAmount={progress.thisAmount}
            billingType={progress.billingType}
          />
        </div>
      )}

      {payments && payments.length > 0 && (
        <div className="mt-8 border-t border-slate-200 pt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Payments received</div>
          <table className="mt-1 w-full text-sm">
            <tbody>
              {payments.map((p, i) => (
                <tr key={p.id ?? i} className="text-slate-600">
                  <td className="py-1">{formatDate(p.paid_at)}</td>
                  <td className="py-1 capitalize">{p.method}{p.note ? ` · ${p.note}` : ""}</td>
                  <td className="py-1 text-right">{formatCurrency(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {notes && <DocNote label="Notes" text={notes} />}
      {terms && <DocNote label="Terms" text={terms} />}

      <div className="mt-10 text-center text-xs text-slate-400">
        {balance > 0
          ? `Please remit ${formatCurrency(balance)}. Thank you for your business.`
          : "Paid in full — thank you for your business."}
      </div>
      {documentFooter && (
        <div className="mt-3 whitespace-pre-wrap text-center text-xs text-slate-400">{documentFooter}</div>
      )}
    </div>
  );
}
