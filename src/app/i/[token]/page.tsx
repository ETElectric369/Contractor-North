import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { templateFor } from "@/components/doc-templates";
import { billingEnabled } from "@/lib/stripe";
import { formatCurrency } from "@/lib/utils";
import { docTitle } from "@/lib/doc-title";
import { invoiceTypeLabel } from "@/lib/invoice-math";
import { InvoiceDocument } from "@/components/invoice-document";
import type { Metadata } from "next";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_invoice", { p_token: token });
  const inv = (data as any)?.invoice;
  return { title: docTitle(inv ? `Invoice ${inv.invoice_number}` : "Invoice") };
}

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

      <InvoiceDocument
        co={co}
        template={template}
        number={inv.invoice_number}
        createdAt={inv.created_at}
        dueDate={inv.due_date}
        title={inv.title}
        billingLabel={invoiceTypeLabel(inv.billing_type, inv.invoice_kind)}
        customer={c}
        items={items}
        subtotal={inv.subtotal}
        taxRate={inv.tax_rate}
        tax={inv.tax}
        total={inv.total}
        amountPaid={inv.amount_paid}
        notes={inv.notes}
      />
    </div>
  );
}
