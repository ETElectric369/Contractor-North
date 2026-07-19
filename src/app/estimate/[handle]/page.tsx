import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { accentHex, orgPublicBaseUrl } from "@/lib/org-settings";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { DECK_ESTIMATE_CODES, buildDeckRates } from "@/lib/estimate/deck";
import { Configurator } from "./configurator";
import { PortfolioGallery } from "./portfolio-gallery";
import { AskNort } from "../../site/ask-nort";

export const dynamic = "force-dynamic";

/** Real metadata for the org's lead front door — without this the page inherits the root
 *  layout's "Contractor North" SaaS title/description, and with the same content served on
 *  four hosts (custom domain, subdomain, app host, vercel.app) and no rel=canonical, Google
 *  could index the wrong host under the wrong name. Title/description reuse the page's own
 *  headline/tagline fallbacks (below) so meta and visible content agree; the canonical
 *  byte-matches the sitemap entry (sitemap.xml builds `${orgPublicBaseUrl}/estimate/${handle}`),
 *  consolidating all four hosts onto the org's one public base. getPublicOrgByHandle is
 *  React-cache()d, so this shares the page's query. */
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) return {}; // the page itself 404s
  const s = org.settings;
  return {
    title: s.splash_headline || `${org.name} — Deck Estimate`,
    description: s.splash_tagline || "Answer a few quick questions for an instant ballpark.",
    alternates: { canonical: `${orgPublicBaseUrl(s)}/estimate/${handle}` },
  };
}

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
  const photos = (settings.portfolio ?? []).filter((p) => p.url);
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
        calendlyUrl={/^https:\/\//i.test(settings.calendly_url) ? settings.calendly_url : ""}
      />
      <PortfolioGallery photos={photos} brand={brand} />
      {/* Same read-only lead-capturing assistant as the marketing site — so a visitor mid-configurator
          can ask "does this include a permit?" without bailing to the contact form. */}
      <AskNort handle={handle} orgName={orgName} brand={brand} />
    </>
  );
}
