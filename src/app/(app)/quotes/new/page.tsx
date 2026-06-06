import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { QuoteBuilder } from "./quote-builder";

export const dynamic = "force-dynamic";

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const { customer } = await searchParams;
  const supabase = await createClient();
  const { data: customers } = await supabase
    .from("customers")
    .select("id, name, company_name")
    .order("name");

  return (
    <div>
      <Link
        href="/quotes"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to quotes
      </Link>
      <PageHeader
        title="New quote"
        description="Build line items by hand or let the AI draft them from a scope of work."
      />
      <QuoteBuilder customers={customers ?? []} preselected={customer} />
    </div>
  );
}
