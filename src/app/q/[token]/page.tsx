import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { PublicQuoteAccept } from "./accept";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PublicQuotePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_quote", { p_token: token });
  if (!data) notFound();

  const q = data.quote;
  const items = data.items ?? [];
  const c = data.customer;
  const org = data.org as Organization | null;
  const co = companyFromOrg(org);
  const template = templateFor(org, "quote");

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-end px-4">
        <PrintButton label="Print / Save PDF" />
      </div>
      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
        <DocHeader
          co={co}
          template={template}
          meta={{
            docType: (q.doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote",
            number: q.quote_number,
            rows: [
              { label: "Date", value: formatDate(q.created_at) },
              ...(q.valid_until ? [{ label: "Valid until", value: formatDate(q.valid_until) }] : []),
            ],
          }}
        />

        <div className="mt-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Prepared for
          </div>
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

        {q.title && <div className="mt-5 text-base font-semibold text-slate-900">{q.title}</div>}

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
            <div className="flex justify-between text-slate-600"><span>Subtotal</span><span>{formatCurrency(q.subtotal)}</span></div>
            <div className="flex justify-between text-slate-600"><span>Tax ({(q.tax_rate * 100).toFixed(2)}%)</span><span>{formatCurrency(q.tax)}</span></div>
            <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-bold text-slate-900"><span>Total</span><span>{formatCurrency(q.total)}</span></div>
          </div>
        </div>

        <div className="mt-8">
          <PublicQuoteAccept
            token={token}
            accepted={q.status === "accepted"}
            brand={co.brand}
          />
        </div>

        {q.notes && (
          <div className="mt-8 border-t border-slate-200 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{q.notes}</p>
          </div>
        )}
        <div className="mt-10 text-center text-xs text-slate-400">
          Questions? Contact {co.name}{co.phone ? ` · ${co.phone}` : ""}.
        </div>
      </div>
    </div>
  );
}
