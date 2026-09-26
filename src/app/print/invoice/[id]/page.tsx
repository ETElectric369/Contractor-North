import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { InvoiceDocument } from "@/components/invoice-document";
import { docTitle } from "@/lib/doc-title";
import { readInvoiceDocumentProps } from "@/lib/invoice-document-props";
import type { Metadata } from "next";

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

  // THE ONE ASSEMBLY (readInvoiceDocumentProps): the /i link and the portal's bill draw the same
  // props from the same function, so the PDF and the customer's live page cannot drift apart.
  const read = await readInvoiceDocumentProps(supabase, id, { kind: "staff" });
  if (read.kind === "missing") notFound();
  // A failed read is an error page, never a bill with missing lines: the PDF route stores nothing
  // from a page that did not answer 200.
  if (read.kind === "error") throw new Error("This invoice couldn't be read just now.");

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <BackLink fallback={`/billing/${id}`} fallbackLabel="Back" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800" />
        <PrintButton />
      </div>

      <InvoiceDocument {...read.props} />
    </div>
  );
}
