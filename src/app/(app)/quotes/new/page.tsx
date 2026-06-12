import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { QuoteBuilder } from "./quote-builder";

export const dynamic = "force-dynamic";

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; job?: string }>;
}) {
  const { customer, job } = await searchParams;
  const supabase = await createClient();
  const [{ data: customers }, { data: priceItems }, { data: taxRates }, { data: kits }, { data: org }] =
    await Promise.all([
      supabase.from("customers").select("id, name, company_name, pricing_levels(markup_pct)").order("name"),
      supabase
        .from("price_list_items")
        .select("id, code, description, category, unit, buy_price, markup_pct")
        .eq("archived", false)
        .order("description")
        .limit(2000),
      supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
      supabase
        .from("kits")
        .select("id, name, kit_items(description, quantity, unit, unit_price, sort_order)")
        .order("name"),
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ]);
  const expiryDays = getOrgSettings((org as any)?.settings).quote_expiry_days;

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
      <QuoteBuilder
        customers={(customers ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          company_name: c.company_name,
          level_markup: c.pricing_levels?.markup_pct ?? null,
        }))}
        preselected={customer}
        jobId={job}
        priceItems={(priceItems ?? []) as any}
        taxRates={(taxRates ?? []) as any}
        kits={(kits ?? []) as any}
        quoteExpiryDays={expiryDays}
      />
    </div>
  );
}
