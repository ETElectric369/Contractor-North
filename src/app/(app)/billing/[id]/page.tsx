import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, User, FileText, Printer, CreditCard } from "lucide-react";
import { billingEnabled } from "@/lib/stripe";
import { qboConfigured } from "@/lib/quickbooks";
import { QboInvoiceButton } from "./qbo-button";
import { createClient } from "@/lib/supabase/server";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { InvoiceDetail } from "./invoice-detail";
import { EmailButton } from "@/components/email-button";
import { SectionMapButton } from "@/components/section-map-button";
import { invoiceSectionTree } from "@/lib/nav-tree";
import { DeleteButton } from "@/components/delete-button";
import { deleteInvoice } from "../actions";
import { getOrgSettings } from "@/lib/org-settings";
import type { Invoice, InvoiceItem, Payment } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, customers(id, name), quotes(id, quote_number)")
    .eq("id", id)
    .maybeSingle();

  if (!invoice) notFound();
  const inv = invoice as Invoice & { customers: any; quotes: any };

  const [{ data: items }, { data: payments }, { data: priceItems }, { data: taxRates }, { data: org }] =
    await Promise.all([
      supabase
        .from("invoice_items")
        .select("*")
        .eq("invoice_id", id)
        .order("sort_order"),
      supabase.from("payments").select("*").eq("invoice_id", id).order("paid_at", { ascending: false }),
      supabase
        .from("price_list_items")
        .select("id, code, description, unit, buy_price, markup_pct")
        .eq("archived", false)
        .order("description")
        .limit(2000),
      supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ]);
  const paymentMethods = getOrgSettings((org as any)?.settings).payment_methods;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/billing"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to billing
      </Link>

      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">
            {inv.invoice_number}
          </h1>
          <Badge tone={statusTone(inv.status)}>{inv.status}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
          {inv.title && <span className="text-slate-600">{inv.title}</span>}
          <span>Created {formatDate(inv.created_at)}</span>
          {inv.due_date && <span>Due {formatDate(inv.due_date)}</span>}
          {inv.customers && (
            <Link
              href={`/crm/${inv.customers.id}`}
              className="flex items-center gap-1 hover:text-brand"
            >
              <User className="h-3.5 w-3.5" /> {inv.customers.name}
            </Link>
          )}
          {inv.quotes && (
            <Link
              href={`/quotes/${inv.quotes.id}`}
              className="flex items-center gap-1 hover:text-brand"
            >
              <FileText className="h-3.5 w-3.5" /> {inv.quotes.quote_number}
            </Link>
          )}
        </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start">
          {billingEnabled && Number(inv.total) - Number(inv.amount_paid) > 0 && (
            <a
              href={`/api/pay/${(inv as any).public_token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              <CreditCard className="h-4 w-4" /> Collect payment
            </a>
          )}
          <EmailButton id={inv.id} kind="invoice" />
          <SectionMapButton
            tree={invoiceSectionTree(inv.id, inv.invoice_number, {
              customerId: inv.customers?.id ?? null,
              quoteId: inv.quotes?.id ?? null,
              jobId: (inv as any).job_id ?? null,
            })}
          />
          <Link
            href={`/print/invoice/${inv.id}`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            <Printer className="h-4 w-4" /> Preview / Print
          </Link>
          {qboConfigured() && <QboInvoiceButton id={inv.id} />}
          <DeleteButton
            run={deleteInvoice.bind(null, inv.id)}
            confirmText={`Delete ${inv.invoice_number}? Only allowed while no payments are recorded.`}
            redirectTo="/billing"
          />
        </div>
      </div>

      <InvoiceDetail
        invoice={inv}
        items={(items ?? []) as InvoiceItem[]}
        payments={(payments ?? []) as Payment[]}
        priceItems={(priceItems ?? []) as any}
        taxRates={(taxRates ?? []) as any}
        paymentMethods={paymentMethods}
      />
    </div>
  );
}
