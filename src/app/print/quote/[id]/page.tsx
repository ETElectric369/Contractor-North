import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { templateFor } from "@/components/doc-templates";
import { getOrgSettings } from "@/lib/org-settings";
import { QuoteDocument } from "@/components/quote-document";
import { docTitle } from "@/lib/doc-title";
import type { Metadata } from "next";
import type { Organization, Quote, QuoteLineItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("quotes").select("quote_number, doc_type, customers(name)").eq("id", id).maybeSingle();
  const label = ((data as any)?.doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";
  return { title: docTitle(data ? `${label} ${(data as any).quote_number}` : "Quote", (data as any)?.customers?.name) };
}

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
  // Quote = fixed price · Estimate = time & materials. Same record, the
  // customer-facing wording follows doc_type.
  const isEstimate = ((q as any).doc_type ?? "quote") === "estimate";
  const docLabel = isEstimate ? "Estimate" : "Quote";

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

      <QuoteDocument
        co={co}
        template={template}
        docLabel={docLabel}
        number={q.quote_number}
        createdAt={q.created_at}
        validUntil={q.valid_until}
        title={q.title}
        customer={q.customers}
        items={lineItems as any}
        subtotal={q.subtotal}
        taxRate={q.tax_rate}
        tax={q.tax}
        total={q.total}
        notes={q.notes}
        terms={settings.quote_terms}
        documentFooter={settings.document_footer}
      />
    </div>
  );
}
