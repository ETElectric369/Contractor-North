import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeBlocks, type Block } from "@/lib/site-blocks";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { isReservedSlug } from "@/lib/site-reserved";

/**
 * Sanitize on READ, not just at write. The saveSitePage action sanitizes text blocks, but the real
 * write boundary is RLS — a granted collaborator (or staff) could PATCH site_pages.blocks directly
 * via PostgREST, skipping the action. Re-sanitizing the one raw-HTML sink (text blocks) here — server
 * only, so sanitize-html never reaches the editor's client bundle — makes block-renderer.tsx's
 * dangerouslySetInnerHTML safe no matter how the row was written. Runs AFTER normalizeBlocks.
 */
function sanitizeTextBlocks(blocks: Block[]): Block[] {
  return blocks.map((b) => (b.type === "text" ? { type: "text", props: { html: sanitizeHtml(b.props.html) }, style: b.style } : b));
}

/** Turn arbitrary stored jsonb into render-ready blocks: normalize/bound + sanitize the text sink.
 *  THE read boundary for every block surface (custom pages AND homepage home_blocks) — server only. */
export function renderReadyBlocks(raw: unknown): Block[] {
  return sanitizeTextBlocks(normalizeBlocks(raw));
}

/** Public reads for custom builder PAGES (site_pages) — service client, published-only, always
 *  scoped to ONE org id resolved upstream by handle/domain (never caller input). Served at
 *  /p/<slug> on the org's site. */
export type PublicPage = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  blocks: Block[];
  nav_label: string | null;
  seo_title?: string | null;
};

export const getPublicPageBySlug = cache(async (orgId: string, slug: string): Promise<PublicPage | null> => {
  const clean = String(slug || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) return null;
  // Reserved slugs can never serve as pages, even if a ROW exists (saveSitePage refuses new
  // ones, but a slug reserved AFTER a page was published — e.g. "home"/"index"/"homepage",
  // added in cn-v513 — would otherwise shadow the route middleware owns). Miss → the caller's
  // existing 307-home behavior, same as any unknown slug.
  if (isReservedSlug(clean)) return null;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_pages")
    .select("id, slug, title, description, blocks, nav_label, seo_title")
    .eq("org_id", orgId)
    .eq("published", true)
    .eq("slug", clean)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { ...(data as PublicPage), blocks: renderReadyBlocks((data as { blocks?: unknown }).blocks) };
});

/** Every published page's slug, for the sitemap. Secondary sort on title: Postgres gives
 *  no order guarantee for tied nav_orders, and every page consumer (here, getNavPages, the
 *  settings/content lists) must tiebreak the SAME way or the live nav can shuffle between
 *  page views. */
export const getPublicPageSlugs = cache(async (orgId: string): Promise<string[]> => {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_pages")
    .select("slug")
    .eq("org_id", orgId)
    .eq("published", true)
    .order("nav_order", { ascending: true })
    .order("title", { ascending: true })
    .limit(500);
  // A stranded row at a NOW-reserved slug is unservable (see getPublicPageBySlug) — never advertise it.
  return ((data ?? []) as { slug: string }[]).map((p) => p.slug).filter((s) => !isReservedSlug(s));
});

/** Published pages that opt into the site nav (nav_label set), for the header menu.
 *  nav_order then title — deterministic even when orders tie (see getPublicPageSlugs). */
export const getNavPages = cache(async (orgId: string): Promise<{ slug: string; nav_label: string }[]> => {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_pages")
    .select("slug, nav_label")
    .eq("org_id", orgId)
    .eq("published", true)
    .not("nav_label", "is", null)
    .order("nav_order", { ascending: true })
    .order("title", { ascending: true })
    .limit(20);
  return ((data ?? []) as { slug: string; nav_label: string | null }[])
    .filter((p) => p.nav_label && !isReservedSlug(p.slug)) // unservable slugs never reach the menu
    .map((p) => ({ slug: p.slug, nav_label: p.nav_label as string }));
});
