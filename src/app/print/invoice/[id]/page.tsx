import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { templateFor } from "@/components/doc-templates";
import { getOrgSettings } from "@/lib/org-settings";
import { jobProgressFinancials } from "@/lib/job-financials";
import { invoiceTypeLabel } from "@/lib/invoice-math";
import { InvoiceDocument } from "@/components/invoice-document";
import { docTitle } from "@/lib/doc-title";
import type { Metadata } from "next";
import type { Invoice, InvoiceItem, Organization, Payment } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("invoices").select("invoice_number, customers(name)").eq("id", id).maybeSingle();
  return { title: docTitle(data ? `Invoice ${(data as any).invoice_number}` : "Invoice", (data as any)?.customers?.name) };
}

export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
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
    supabase.from("invoice_items").select("*").eq("invoice_id", id).order("sort_order"),
    supabase.from("payments").select("*").eq("invoice_id", id).order("paid_at", { ascending: false }),
  ]);

  const { data: org } = await supabase.from("organizations").select("*").maybeSingle();
  const co = companyFromOrg(org as Organization | null);
  const template = templateFor(org as Organization | null, "invoice");
  const settings = getOrgSettings((org as any)?.settings);

  const lineItems = (items ?? []) as InvoiceItem[];
  const pays = (payments ?? []) as Payment[];

  // A deposit/progress/final invoice on a job shows a progress-report summary.
  const drawKind = (inv as any).invoice_kind as string | undefined;
  const isDraw = !!(inv as any).job_id && ["deposit", "progress", "final"].includes(drawKind ?? "");
  const fin = isDraw ? await jobProgressFinancials(supabase, (inv as any).job_id) : null;

  // A clear "Time & Material vs Fixed-Price" statement from the job's billing model.
  const jobId = (inv as any).job_id;
  const { data: jobRow } = jobId
    ? await supabase.from("jobs").select("billing_type").eq("id", jobId).maybeSingle()
    : { data: null };
  const billingLabel = invoiceTypeLabel((jobRow as any)?.billing_type, drawKind);

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <Link href={`/billing/${id}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <PrintButton />
      </div>

      <InvoiceDocument
        co={co}
        template={template}
        number={inv.invoice_number}
        createdAt={inv.created_at}
        dueDate={inv.due_date}
        title={inv.title}
        billingLabel={billingLabel}
        customer={inv.customers}
        items={lineItems as any}
        subtotal={inv.subtotal}
        taxRate={inv.tax_rate}
        tax={inv.tax}
        total={inv.total}
        amountPaid={inv.amount_paid}
        payments={pays}
        notes={inv.notes}
        terms={settings.invoice_terms}
        documentFooter={settings.document_footer}
        progress={
          fin
            ? {
                estimate: fin.estimate,
                workToDate: fin.workToDate,
                received: Math.max(0, Math.round((fin.collected - Number(inv.amount_paid ?? 0)) * 100) / 100),
                thisAmount: Number(inv.total ?? 0),
                billingType: fin.billingType,
              }
            : null
        }
      />
    </div>
  );
}
