import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { COMPANY } from "@/lib/company";
import { PrintButton } from "@/components/print-button";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Quote, QuoteLineItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function QuotePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select("*, customers(name, company_name, email, phone, address, city, state, zip)")
    .eq("id", id)
    .maybeSingle();

  if (!quote) notFound();
  const q = quote as Quote & { customers: any };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("*")
    .eq("quote_id", id)
    .order("sort_order");

  const lineItems = (items ?? []) as QuoteLineItem[];
  const c = q.customers;

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <Link
          href={`/quotes/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <PrintButton />
      </div>

      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
        {/* Letterhead */}
        <div className="flex items-start justify-between border-b-2 border-brand pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand text-white">
              <Zap className="h-6 w-6" />
            </div>
            <div>
              <div className="text-xl font-bold text-slate-900">{COMPANY.name}</div>
              <div className="text-xs text-slate-500">{COMPANY.tagline}</div>
              <div className="mt-1 text-xs text-slate-500">
                {[COMPANY.addressLine1, COMPANY.addressLine2].filter(Boolean).join(", ")}
                {COMPANY.phone ? ` · ${COMPANY.phone}` : ""}
                {COMPANY.email ? ` · ${COMPANY.email}` : ""}
                {COMPANY.license ? ` · ${COMPANY.license}` : ""}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold uppercase tracking-wide text-slate-900">
              Quote
            </div>
            <div className="mt-1 text-sm font-medium text-slate-700">
              {q.quote_number}
            </div>
            <div className="text-xs text-slate-500">
              Date: {formatDate(q.created_at)}
            </div>
            {q.valid_until && (
              <div className="text-xs text-slate-500">
                Valid until: {formatDate(q.valid_until)}
              </div>
            )}
          </div>
        </div>

        {/* Bill-to */}
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
              {c.email && <div>{c.email}</div>}
              {c.phone && <div>{c.phone}</div>}
            </div>
          ) : (
            <div className="mt-1 text-sm text-slate-400">—</div>
          )}
        </div>

        {q.title && (
          <div className="mt-5 text-base font-semibold text-slate-900">{q.title}</div>
        )}

        {/* Line items */}
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Qty</th>
              <th className="py-2 text-right font-semibold">Unit</th>
              <th className="py-2 text-right font-semibold">Price</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((it) => (
              <tr key={it.id} className="border-b border-slate-100">
                <td className="py-2 pr-2 text-slate-800">{it.description}</td>
                <td className="py-2 text-right text-slate-600">{it.quantity}</td>
                <td className="py-2 text-right text-slate-500">{it.unit}</td>
                <td className="py-2 text-right text-slate-600">
                  {formatCurrency(it.unit_price)}
                </td>
                <td className="py-2 text-right font-medium text-slate-900">
                  {formatCurrency(it.line_total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="mt-4 flex justify-end">
          <div className="w-64 space-y-1 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span>{formatCurrency(q.subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Tax ({(q.tax_rate * 100).toFixed(2)}%)</span>
              <span>{formatCurrency(q.tax)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-bold text-slate-900">
              <span>Total</span>
              <span>{formatCurrency(q.total)}</span>
            </div>
          </div>
        </div>

        {q.notes && (
          <div className="mt-8 border-t border-slate-200 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Notes
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{q.notes}</p>
          </div>
        )}

        <div className="mt-10 text-center text-xs text-slate-400">
          Thank you for the opportunity to earn your business.
        </div>
      </div>
    </div>
  );
}
