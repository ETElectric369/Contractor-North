import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { getOrgSettings } from "@/lib/org-settings";
import { formatCurrency, formatDate } from "@/lib/utils";
import { lineItemParts } from "@/components/line-item-text";
import type { Organization, Quote, QuoteLineItem } from "@/lib/types";

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

  const { data: org } = await supabase
    .from("organizations")
    .select("*")
    .maybeSingle();
  const co = companyFromOrg(org as Organization | null);
  const template = templateFor(org as Organization | null, "quote");
  const settings = getOrgSettings((org as any)?.settings);

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

      <div className="print-page mx-auto max-w-3xl bg-white p-8 shadow-sm print:p-6">
        <DocHeader
          co={co}
          template={template}
          meta={{
            docType: "Quote",
            number: q.quote_number,
            rows: [
              { label: "Date", value: formatDate(q.created_at) },
              ...(q.valid_until
                ? [{ label: "Valid until", value: formatDate(q.valid_until) }]
                : []),
            ],
          }}
        />

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
          <div className="mt-4 text-base font-semibold text-slate-900">{q.title}</div>
        )}

        {/* Line items — compact. A multi-line description renders extra lines as
            indented sub-items (e.g. the materials that make up a service line). */}
        <table className="mt-3 w-full border-collapse text-[13px] leading-snug">
          <thead>
            <tr className="border-b border-slate-300 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="py-1.5 font-semibold">Description</th>
              <th className="w-12 py-1.5 text-right font-semibold">Qty</th>
              <th className="w-12 py-1.5 text-right font-semibold">Unit</th>
              <th className="w-20 py-1.5 text-right font-semibold">Price</th>
              <th className="w-24 py-1.5 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((it) => {
              const raw = String(it.description ?? "");
              const parts = lineItemParts(raw).map((s) => s.replace(/^\s*[-•*]\s*/, "").trim());
              // Newline lists keep their first line as a header; a bare comma-list
              // has no header — every part is a bullet.
              const headerStyle = /\n/.test(raw) || parts.length <= 1;
              const head = headerStyle ? parts[0] ?? "" : "";
              const subs = head ? parts.slice(1) : parts.length > 1 ? parts : [];
              return (
                <tr key={it.id} className="border-b border-slate-100 align-top [break-inside:avoid]">
                  <td className="py-1 pr-2 text-slate-800">
                    {head && <div>{head}</div>}
                    {subs.length > 0 && (
                      <ul className="ml-3 mt-0.5 list-disc text-[11px] text-slate-500 marker:text-slate-300">
                        {subs.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="py-1 text-right text-slate-600">{it.quantity}</td>
                  <td className="py-1 text-right text-slate-500">{it.unit}</td>
                  <td className="py-1 text-right text-slate-600">{formatCurrency(it.unit_price)}</td>
                  <td className="py-1 text-right font-medium text-slate-900">{formatCurrency(it.line_total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Totals */}
        <div className="mt-3 flex justify-end">
          <div className="w-60 space-y-0.5 text-[13px]">
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
          <div className="mt-5 border-t border-slate-200 pt-3 [break-inside:avoid]">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Notes
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[13px] text-slate-600">{q.notes}</p>
          </div>
        )}

        {settings.quote_terms && (
          <div className="mt-4 border-t border-slate-200 pt-3 [break-inside:avoid]">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Terms</div>
            <p className="mt-1 whitespace-pre-wrap text-[13px] text-slate-600">{settings.quote_terms}</p>
          </div>
        )}

        <div className="mt-6 whitespace-pre-wrap text-center text-xs text-slate-400">
          {settings.document_footer || "Thank you for the opportunity to earn your business."}
        </div>
      </div>
    </div>
  );
}
