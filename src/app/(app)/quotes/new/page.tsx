import { createClient } from "@/lib/supabase/server";
import { BackLink } from "@/components/back-link";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { parseInspectionSchema, answersForEstimator, measurementsFromAnswers, tolerateMissingColumns } from "@/lib/inspection/schema";
import { DECK_ESTIMATE_CODES } from "@/lib/estimate/deck";
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
  // from the appointment when the URL didn't carry ?inquiry=. Photos are
  // DELIBERATELY not carried into the prefill — only notes/measurements/materials;
  // they stay on the appointment's capture page (signed URLs, private bucket).
  let initialScope: string | undefined;
  // Square/linear feet from the walk-through, handed to the kit picker so its sizing boxes open
  // with the numbers the inspector already took.
  let measured: { sqft: number | null; linearFt: number | null } | undefined;
  let captureInquiryId: string | undefined;
  let captureApptId: string | undefined; // verified appointment id — saveQuote stamps the write-up backlink on it
  // The inspection already knows WHOSE house this is. Without carrying these through, a repeat
  // customer's walk-through wrote up into a blank estimate and you re-picked them from the full
  // contact list standing in their yard.
  let captureCustomerId: string | undefined;
  let captureJobId: string | undefined;
  if (capture) {
    const { data: appt } = await supabase
      .from("appointments")
      .select("id, title, location, inquiry_id, capture, customer_id, job_id")
      .eq("id", capture)
      .maybeSingle();
    const cap = (appt as any)?.capture as
      | { notes?: string; measurements?: string; materials?: string }
      | null
      | undefined;
    if (appt) {
      // THE TYPED ANSWERS GO FIRST, and are labelled as MEASURED (0165). The inspector already
      // stood in front of these numbers; making the estimator re-extract "85 ft" from a sentence
      // is a re-derivation that can silently come back with a different number. Facts above prose.
      // Read tolerantly — a deploy precedes its migration, and naming an absent column fails the
      // whole query. Pre-migration this yields no measured block and the prose prefill is unchanged.
      const insp = await tolerateMissingColumns<{ inspection_answers: unknown; forms: unknown }>(() =>
        supabase
          .from("appointments")
          .select("inspection_answers, forms:inspection_template_id(schema)")
          .eq("id", capture)
          .maybeSingle(),
      );
      const rel = (insp as any)?.forms;
      const schema = parseInspectionSchema((Array.isArray(rel) ? rel[0] : rel)?.schema);
      const answers = ((insp as any)?.inspection_answers ?? {}) as never;
      const measuredText = answersForEstimator(schema, answers);
      measured = measurementsFromAnswers(schema, answers);
      const parts = [
        `From site inspection — ${(appt as any).title}${(appt as any).location ? ` (${(appt as any).location})` : ""}`,
        measuredText ? `MEASURED ON SITE (these are given — use them, don't re-derive them):\n${measuredText}` : "",
        cap?.notes?.trim() ? `Notes:\n${cap.notes.trim()}` : "",
        cap?.measurements?.trim() ? `Measurements:\n${cap.measurements.trim()}` : "",
        cap?.materials?.trim() ? `Materials needed:\n${cap.materials.trim()}` : "",
      ].filter(Boolean);
      if (parts.length > 1) initialScope = parts.join("\n\n");
      captureInquiryId = (appt as any).inquiry_id ?? undefined;
      captureApptId = (appt as any).id;
      captureCustomerId = (appt as any).customer_id ?? undefined;
      captureJobId = (appt as any).job_id ?? undefined;
    }
  }
  const [{ data: customers }, { data: priceItems }, { data: taxRates }, { data: kits }, { data: org }] =
    await Promise.all([
      supabase.from("customers").select("id, name, company_name, pricing_levels(markup_pct, labor_rate)").order("name"),
      supabase
        .from("price_list_items")
        .select("id, code, description, category, unit, buy_price, markup_pct, updated_at")
        .eq("archived", false)
        .order("description")
        .limit(2000),
      supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
      // kit_items ids ride along so the Kit Picker can write edits back to the kit. The 0166
      // coefficient columns are requested FIRST and the query retried without them if they aren't
      // there yet — a deploy precedes its migration, and naming an absent column fails the whole
      // query rather than degrading, which would empty the kit picker until the migration landed.
      (async () => {
        const cols = "id, description, quantity, unit, unit_price, sort_order";
        const withCoeffs = await supabase
          .from("kits")
          .select(`id, name, kit_items(${cols}, qty_per_sqft, qty_per_lf, qty_min, qty_round)`)
          .order("name");
        if (!withCoeffs.error) return withCoeffs;
        return supabase.from("kits").select(`id, name, kit_items(${cols})`).order("name");
      })(),
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
  // Deck generator rows (catalog orgs) — the deck price codes as RAW {code, buy, markup_pct}
  // rows. The office builder prices them client-side through THE markup rule (effectiveMarkupPct
  // with the selected customer's level + org default), so generator lines re-price when the
  // customer changes and always agree with the hand-picker on the same page. (The PUBLIC
  // configurator keeps buildDeckRates' item-markup-only freeze.) The dedupe contract is
  // first-row-per-code-wins from NEWEST-FIRST rows; the query above orders by description
  // for the picker, so re-sort the deck subset here.
  const deckRateRows = catalogMode
    ? (priceItems ?? [])
        .filter((p: any) => p.code && (DECK_ESTIMATE_CODES as readonly string[]).includes(p.code))
        .sort((a: any, b: any) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
        .map((p: any) => ({ code: p.code, buy_price: p.buy_price, markup_pct: p.markup_pct }))
    : undefined;

  return (
    <div>
      <BackLink fallback="/quotes" fallbackLabel="Back to Estimates" />
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
        measured={measured}
        customers={(customers ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          company_name: c.company_name,
          level_markup: c.pricing_levels?.markup_pct ?? null,
          level_rate: c.pricing_levels?.labor_rate ?? null,
        }))}
        preselected={customer ?? captureCustomerId}
        jobId={job ?? captureJobId}
        inquiryId={inquiry ?? captureInquiryId}
        captureId={captureApptId}
        initialScope={initialScope}
        priceItems={(priceItems ?? []) as any}
        taxRates={(taxRates ?? []) as any}
        kits={estimateKits as any}
        quoteExpiryDays={expiryDays}
        defaultMarkupPct={settings.default_markup_pct}
        deckRateRows={deckRateRows}
      />
    </div>
  );
}
