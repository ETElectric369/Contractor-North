import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, User, FileText, Printer, CreditCard, Banknote } from "lucide-react";
import { billingEnabled } from "@/lib/stripe";
import { qboConfigured } from "@/lib/quickbooks";
import { QboInvoiceButton } from "./qbo-button";
import { createClient } from "@/lib/supabase/server";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { InvoiceDetail } from "./invoice-detail";
import { CreditButton } from "./credit-button";
import { EmailButton } from "@/components/email-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { invoiceSectionTree } from "@/lib/nav-tree";
import { deleteInvoice } from "../actions";
import { getOrgSettings } from "@/lib/org-settings";
import { jobProgressFinancials, receivedBeforeThisInvoice } from "@/lib/job-financials";
import { ProgressReportCard } from "@/components/progress-report-card";
import type { Invoice, InvoiceItem, Payment } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice, error: invoiceErr } = await supabase
    .from("invoices")
    .select("*, customers(id, name), quotes(id, quote_number)")
    .eq("id", id)
    .maybeSingle();

  if (invoiceErr) throw invoiceErr; // a real failure shouldn't masquerade as 404
  if (!invoice) notFound();
  const inv = invoice as Invoice & { customers: any; quotes: any };

  // The customer/job pickers only matter while the invoice is still an editable
  // draft, so only pay for those lookups then.
  const isDraft = inv.status === "draft";

  const [{ data: items }, { data: payments }, { data: priceItems }, { data: taxRates }, { data: org }, { data: customers }, { data: jobs }] =
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
      isDraft
        ? supabase.from("customers").select("id, name").order("name").limit(2000)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      isDraft
        ? supabase.from("jobs").select("id, name, job_number, customer_id").order("created_at", { ascending: false }).limit(2000)
        : Promise.resolve({ data: [] as { id: string; name: string | null; job_number: string | null; customer_id: string | null }[] }),
    ]);
  const orgSettings = getOrgSettings((org as any)?.settings);
  const paymentMethods = orgSettings.payment_methods;

  // A deposit/progress/final invoice on a job carries a progress-report summary
  // so the payment request doubles as a running-balance statement.
  const drawKind = (inv as any).invoice_kind as string | undefined;
  const isDraw = !!(inv as any).job_id && ["deposit", "progress", "final"].includes(drawKind ?? "");
  const fin = isDraw ? await jobProgressFinancials(supabase, (inv as any).job_id) : null;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/billing"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Billing
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
        {/* The impulse row holds the frequent verbs (Send / Record payment / Print);
            the ⋯ Actions menu (last) is the seek door for the rare deliberate ones —
            Credit/refund, QuickBooks, the Job link, and Delete (danger, last). */}
        <div className="flex flex-wrap items-center gap-2 self-start">
          {/* Collect-payment is only meaningful once the invoice is actually billed:
              you can't collect on an unsent draft. Hidden until it leaves draft. */}
          {billingEnabled && !isDraft && Number(inv.total) - Number(inv.amount_paid) > 0 && (
            <a
              href={`/api/pay/${(inv as any).public_token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              <CreditCard className="h-4 w-4" /> Collect Payment
            </a>
          )}
          <EmailButton
            id={inv.id}
            kind="invoice"
            customerName={inv.customers?.name ?? null}
            amount={Number(inv.total)}
          />
          {/* Record payment — THE gloves-on invoice verb — jumps to the existing
              form (right column, several screens down at 375px). Like the in-body
              form it only exists once the invoice has left draft. */}
          {!isDraft && (
            <a
              href="#record-payment"
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
            >
              <Banknote className="h-4 w-4" /> Record Payment
            </a>
          )}
          <Link
            href={`/print/invoice/${inv.id}`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            <Printer className="h-4 w-4" /> Preview / Print
          </Link>
          <SectionActionsMenu
            tree={invoiceSectionTree(
              inv.invoice_number,
              { jobId: (inv as any).job_id ?? null },
              {
                run: deleteInvoice.bind(null, inv.id),
                confirm: `Delete ${inv.invoice_number}? Only allowed while no payments are recorded.`,
              },
            )}
          >
            <CreditButton
              menuItem
              invoiceId={inv.id}
              defaultAmount={Math.max(0, Number(inv.amount_paid) - Number(inv.total))}
            />
            {qboConfigured() && <QboInvoiceButton menuItem id={inv.id} />}
          </SectionActionsMenu>
        </div>
      </div>

      {fin && (
        <div className="mb-6">
          <ProgressReportCard
            estimate={fin.estimate}
            workToDate={fin.workToDate}
            received={receivedBeforeThisInvoice(fin, inv.amount_paid)}
            thisAmount={Number(inv.total ?? 0)}
            billingType={fin.billingType}
          />
        </div>
      )}

      <InvoiceDetail
        invoice={inv}
        items={(items ?? []) as InvoiceItem[]}
        payments={(payments ?? []) as Payment[]}
        priceItems={(priceItems ?? []) as any}
        taxRates={(taxRates ?? []) as any}
        paymentMethods={paymentMethods}
        materialMarkup={orgSettings.material_markup_percent}
        customers={(customers ?? []) as any}
        jobs={(jobs ?? []) as any}
      />
    </div>
  );
}
