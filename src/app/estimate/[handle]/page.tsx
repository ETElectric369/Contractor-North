import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { accentHex } from "@/lib/org-settings";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { DECK_ESTIMATE_CODES, buildDeckRates } from "@/lib/estimate/deck";
import { Configurator } from "./configurator";
import { PortfolioGallery } from "./portfolio-gallery";

export const dynamic = "force-dynamic";

/**
 * Public, org-scoped deck estimate configurator at /estimate/<handle>. Resolves the org by its
 * settings.public_handle (the same jsonb spot lead_inbound_secret lives), reads its live deck
 * rates from the price list, and hands the browser only the brand color + the deck-code rates —
 * no auth, no full catalog, no secrets. Chris points his domain here; the lead lands in North.
 */
export default async function EstimatePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();

  const settings = org.settings;
  const brand = accentHex(settings.glass_tint);

  const supabase = createServiceClient();
  const { data: catalog } = await supabase
    .from("price_list_items")
    .select("code, buy_price, markup_pct, updated_at")
    .eq("org_id", org.id)
    .eq("archived", false)
    .in("code", DECK_ESTIMATE_CODES as unknown as string[])
    .order("updated_at", { ascending: false });
  const rates = buildDeckRates((catalog ?? []) as { code: string | null; buy_price: number | null; markup_pct: number | null }[]);

  const orgName = org.name;
  const photos = (settings.portfolio ?? []).map((p) => p.url).filter(Boolean);
  return (
    <>
      <Configurator
        handle={handle}
        orgName={orgName}
        brand={brand}
        rates={rates}
        threshold={settings.site_inspection_threshold}
        headline={settings.splash_headline || `${orgName} — Deck Estimate`}
        tagline={settings.splash_tagline || "Answer a few quick questions for an instant ballpark."}
      />
      <PortfolioGallery photos={photos} brand={brand} />
    </>
  );
}
