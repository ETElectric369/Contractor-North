import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { billingEnabled } from "@/lib/stripe";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PublicInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ paid?: string }>;
}) {
  const { token } = await params;
  const { paid } = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_invoice", { p_token: token });
  if (!data) notFound();

  const inv = data.invoice;
  const items = data.items ?? [];
  const c = data.customer;
  const org = data.org as Organization | null;
  const co = companyFromOrg(org);
  const template = templateFor(org, "invoice");
  const balance = Number(inv.total) - Number(inv.amount_paid);

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-end px-4">
        <PrintButton label="Print / Save PDF" />
      </div>

      {paid && (
        <div className="no-print mx-auto mb-4 max-w-3xl px-4">
          <div className="rounded-xl bg-green-50 px-4 py-3 text-center text-sm font-medium text-green-700">
            Payment received — thank you!
          </div>
        </div>
      )}
      {!paid && balance > 0 && billingEnabled && (
        <div className="no-print mx-auto mb-4 max-w-3xl px-4 text-center">
          <a
            href={`/api/pay/${token}`}
            className="inline-flex items-center gap-2 rounded-xl px-6 py-3 text-base font-semibold text-white shadow-sm"
            style={{ backgroundColor: co.brand }}
          >
            Pay {formatCurrency(balance)} now
          </a>
          <p className="mt-1.5 text-xs text-slate-400">Secure payment by card, Apple Pay, or Google Pay.</p>
        </div>
      )}
      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
        <DocHeader
          co={co}
          template={template}
          meta={{
            docType: "Invoice",
            number: inv.invoice_number,
            rows: [
              { label: "Date", value: formatDate(inv.created_at) },
              ...(inv.due_date ? [{ label: "Due", value: formatDate(inv.due_date) }] : []),
            ],
          }}
        />

        <div className="mt-6 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Bill to</div>
            {c ? (
              <div className="mt-1 text-sm text-slate-700">
                <div className="font-medium text-slate-900">{c.name}</div>
                {c.company_name && <div>{c.company_name}</div>}
                {c.address && <div>{c.address}</div>}
                {(c.city || c.state || c.zip) && (
                  <div>{[c.city, c.state, c.zip].filter(Boolean).join(", ")}</div>
                )}
              </div>
            ) : null}
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-3 text-right">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Balance due</div>
            <div className="text-2xl font-bold text-slate-900">{formatCurrency(balance)}</div>
          </div>
        </div>

        {inv.title && <div className="mt-5 text-base font-semibold text-slate-900">{inv.title}</div>}

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Qty</th>
              <th className="py-2 text-right font-semibold">Price</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it: any, i: number) => (
              <tr key={i} className="border-b border-slate-100">
                <td className="py-2 pr-2 text-slate-800">{it.description}</td>
                <td className="py-2 text-right text-slate-600">{it.quantity} {it.unit}</td>
                <td className="py-2 text-right text-slate-600">{formatCurrency(it.unit_price)}</td>
                <td className="py-2 text-right font-medium text-slate-900">{formatCurrency(it.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex justify-end">
          <div className="w-64 space-y-1 text-sm">
            <div className="flex justify-between text-slate-600"><span>Subtotal</span><span>{formatCurrency(inv.subtotal)}</span></div>
            <div className="flex justify-between text-slate-600"><span>Tax</span><span>{formatCurrency(inv.tax)}</span></div>
            <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold text-slate-900"><span>Total</span><span>{formatCurrency(inv.total)}</span></div>
            <div className="flex justify-between text-slate-600"><span>Paid</span><span>−{formatCurrency(inv.amount_paid)}</span></div>
            <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-bold text-slate-900"><span>Balance due</span><span>{formatCurrency(balance)}</span></div>
          </div>
        </div>

        {inv.notes && (
          <div className="mt-6 border-t border-slate-200 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{inv.notes}</p>
          </div>
        )}
        <div className="mt-10 text-center text-xs text-slate-400">
          {balance > 0 ? `Please remit ${formatCurrency(balance)}.` : "Paid in full — thank you!"}
          {co.phone ? ` Questions? ${co.name} · ${co.phone}` : ""}
        </div>
      </div>
    </div>
  );
}
