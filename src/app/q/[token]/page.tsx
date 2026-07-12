import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { templateFor } from "@/components/doc-templates";
import { PublicQuoteAccept } from "./accept";
import { QuoteDocument } from "@/components/quote-document";
import { docTitle } from "@/lib/doc-title";
import type { Metadata } from "next";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_quote", { p_token: token });
  const q = (data as any)?.quote;
  const label = (q?.doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";
  return { title: docTitle(q ? `${label} ${q.quote_number}` : "Quote") };
}

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
  const docLabel = (q.doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-end px-4">
        <PrintButton label="Print / Save PDF" />
      </div>

      <QuoteDocument
        co={co}
        template={template}
        docLabel={docLabel}
        number={q.quote_number}
        createdAt={q.created_at}
        validUntil={q.valid_until}
        title={q.title}
        description={q.description}
        customer={c}
        items={items}
        subtotal={q.subtotal}
        taxRate={q.tax_rate}
        tax={q.tax}
        total={q.total}
        notes={q.notes}
        // The public RPC deliberately omits org.settings (no leak), so quote_terms /
        // document_footer aren't available on this surface — the document falls back
        // to its default footer, the same as before.
        showContact
        acceptSlot={
          <PublicQuoteAccept
            token={token}
            accepted={q.status === "accepted"}
            declined={q.status === "declined"}
            brand={co.brand}
            docLabel={docLabel}
          />
        }
      />
    </div>
  );
}
