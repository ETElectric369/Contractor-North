import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { buildDeckRates, DECK_ESTIMATE_CODES } from "@/lib/estimate/deck";
import { NewInspectionButton } from "../../appointments/new-inspection-button";
import { QuoteBuilder } from "./quote-builder";

export const dynamic = "force-dynamic";

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; job?: string; inquiry?: string; capture?: string }>;
}) {
  const { customer, job, inquiry, capture } = await searchParams;
  const supabase = await createClient();

  // ?capture=<appointment id> — an inspection's field capture prefills the
  // estimator scope (like importing labor into an invoice). RLS scopes the read;
  // a bad/cross-org id just yields no prefill. Also recovers the lead backlink
  // from the appointment when the URL didn't carry ?inquiry=.
  let initialScope: string | undefined;
  let captureInquiryId: string | undefined;
  if (capture) {
    const { data: appt } = await supabase
      .from("appointments")
      .select("id, title, location, inquiry_id, capture")
      .eq("id", capture)
      .maybeSingle();
    const cap = (appt as any)?.capture as
      | { notes?: string; measurements?: string; materials?: string }
      | null
      | undefined;
    if (appt) {
      const parts = [
        `From site inspection — ${(appt as any).title}${(appt as any).location ? ` (${(appt as any).location})` : ""}`,
        cap?.notes?.trim() ? `Notes:\n${cap.notes.trim()}` : "",
        cap?.measurements?.trim() ? `Measurements:\n${cap.measurements.trim()}` : "",
        cap?.materials?.trim() ? `Materials needed:\n${cap.materials.trim()}` : "",
      ].filter(Boolean);
      if (parts.length > 1) initialScope = parts.join("\n\n");
      captureInquiryId = (appt as any).inquiry_id ?? undefined;
    }
  }
  const [{ data: customers }, { data: priceItems }, { data: taxRates }, { data: kits }, { data: org }] =
    await Promise.all([
      supabase.from("customers").select("id, name, company_name, pricing_levels(markup_pct, labor_rate)").order("name"),
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
  const settings = getOrgSettings((org as any)?.settings);
  const expiryDays = settings.quote_expiry_days;
  // Catalog-mode orgs (Tahoe Deck) estimate from TWO scope kits — "Decks" and "Remodels".
  // The granular material kits (Framing, Hardware, Decking…) are the POST-acceptance job
  // breakdown, so they're hidden from the estimate picker here. Research orgs (ET Electric)
  // still see every kit — nothing changes for them.
  const catalogMode = settings.estimating_mode === "catalog";
  const estimateKits = catalogMode
    ? (kits ?? []).filter((k: any) => k.name === "Decks" || k.name === "Remodels")
    : (kits ?? []);
  // Deck generator rates (catalog orgs) — the deck price codes → sell price, from the same
  // price list, so the on-page generator matches the public configurator to the penny.
  const deckRates = catalogMode
    ? buildDeckRates(
        (priceItems ?? [])
          .filter((p: any) => p.code && (DECK_ESTIMATE_CODES as readonly string[]).includes(p.code))
          .map((p: any) => ({ code: p.code, buy_price: p.buy_price, markup_pct: p.markup_pct })),
      )
    : undefined;

  return (
    <div>
      <Link
        href="/quotes"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4 shrink-0" /> Back to Estimates
      </Link>
      <PageHeader
        title="New Estimate"
        description="Build line items by hand, or let the estimator draft them from a scope of work or an uploaded plan."
      >
        {/* Onsite with no capture yet? Start the inspection from where you'll end up — one
            tap creates it (threaded to the lead when this builder came from one) and lands
            on the capture page; Start estimate there routes back here prefilled. */}
        {!capture && <NewInspectionButton inquiryId={inquiry} size="sm" variant="outline" />}
      </PageHeader>
      <QuoteBuilder
        customers={(customers ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          company_name: c.company_name,
          level_markup: c.pricing_levels?.markup_pct ?? null,
          level_rate: c.pricing_levels?.labor_rate ?? null,
        }))}
        preselected={customer}
        jobId={job}
        inquiryId={inquiry ?? captureInquiryId}
        initialScope={initialScope}
        priceItems={(priceItems ?? []) as any}
        taxRates={(taxRates ?? []) as any}
        kits={estimateKits as any}
        quoteExpiryDays={expiryDays}
        deckRates={deckRates}
        showDeckGenerator={catalogMode}
      />
    </div>
  );
}
