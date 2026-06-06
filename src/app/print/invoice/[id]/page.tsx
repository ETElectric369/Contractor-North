import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { Letterhead, companyFromOrg } from "@/components/doc-letterhead";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Invoice, InvoiceItem, Organization, Payment } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InvoicePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, customers(name, company_name, email, phone, address, city, state, zip)")
    .eq("id", id)
    .maybeSingle();

  if (!invoice) notFound();
  const inv = invoice as Invoice & { customers: any };

  const [{ data: items }, { data: payments }] = await Promise.all([
    supabase
      .from("invoice_items")
      .select("*")
      .eq("invoice_id", id)
      .order("sort_order"),
    supabase
      .from("payments")
      .select("*")
      .eq("invoice_id", id)
      .order("paid_at", { ascending: false }),
  ]);

  const { data: org } = await supabase
    .from("organizations")
    .select("*")
    .maybeSingle();
  const co = companyFromOrg(org as Organization | null);

  const lineItems = (items ?? []) as InvoiceItem[];
  const pays = (payments ?? []) as Payment[];
  const balance = Number(inv.total) - Number(inv.amount_paid);
  const c = inv.customers;

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <Link
          href={`/billing/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <PrintButton />
      </div>

      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
        {/* Letterhead */}
        <div
          className="flex items-start justify-between border-b-2 pb-5"
          style={{ borderColor: co.brand }}
        >
          <Letterhead co={co} />
          <div className="text-right">
            <div className="text-2xl font-bold uppercase tracking-wide text-slate-900">
              Invoice
            </div>
            <div className="mt-1 text-sm font-medium text-slate-700">
              {inv.invoice_number}
            </div>
            <div className="text-xs text-slate-500">
              Date: {formatDate(inv.created_at)}
            </div>
            {inv.due_date && (
              <div className="text-xs text-slate-500">
                Due: {formatDate(inv.due_date)}
              </div>
            )}
          </div>
        </div>

        {/* Bill-to + Balance box */}
        <div className="mt-6 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Bill to
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
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-3 text-right">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Balance due
            </div>
            <div className="text-2xl font-bold text-slate-900">
              {formatCurrency(balance)}
            </div>
          </div>
        </div>

        {inv.title && (
          <div className="mt-5 text-base font-semibold text-slate-900">{inv.title}</div>
        )}

        {/* Line items */}
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
            {lineItems.map((it) => (
              <tr key={it.id} className="border-b border-slate-100">
                <td className="py-2 pr-2 text-slate-800">{it.description}</td>
                <td className="py-2 text-right text-slate-600">
                  {it.quantity} {it.unit}
                </td>
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
              <span>{formatCurrency(inv.subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Tax ({(inv.tax_rate * 100).toFixed(2)}%)</span>
              <span>{formatCurrency(inv.tax)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold text-slate-900">
              <span>Total</span>
              <span>{formatCurrency(inv.total)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Paid</span>
              <span>−{formatCurrency(inv.amount_paid)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-bold text-slate-900">
              <span>Balance due</span>
              <span>{formatCurrency(balance)}</span>
            </div>
          </div>
        </div>

        {pays.length > 0 && (
          <div className="mt-8 border-t border-slate-200 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Payments received
            </div>
            <table className="mt-1 w-full text-sm">
              <tbody>
                {pays.map((p) => (
                  <tr key={p.id} className="text-slate-600">
                    <td className="py-1">{formatDate(p.paid_at)}</td>
                    <td className="py-1 capitalize">{p.method}{p.note ? ` · ${p.note}` : ""}</td>
                    <td className="py-1 text-right">{formatCurrency(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {inv.notes && (
          <div className="mt-6 border-t border-slate-200 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Notes
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{inv.notes}</p>
          </div>
        )}

        <div className="mt-10 text-center text-xs text-slate-400">
          {balance > 0
            ? `Please remit ${formatCurrency(balance)}. Thank you for your business.`
            : "Paid in full — thank you for your business."}
        </div>
      </div>
    </div>
  );
}
