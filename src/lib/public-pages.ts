import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeBlocks, type Block } from "@/lib/site-blocks";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Sanitize on READ, not just at write. The saveSitePage action sanitizes text blocks, but the real
 * write boundary is RLS — a granted collaborator (or staff) could PATCH site_pages.blocks directly
 * via PostgREST, skipping the action. Re-sanitizing the one raw-HTML sink (text blocks) here — server
 * only, so sanitize-html never reaches the editor's client bundle — makes block-renderer.tsx's
 * dangerouslySetInnerHTML safe no matter how the row was written. Runs AFTER normalizeBlocks.
 */
function sanitizeTextBlocks(blocks: Block[]): Block[] {
  return blocks.map((b) => (b.type === "text" ? { type: "text", props: { html: sanitizeHtml(b.props.html) } } : b));
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
};

export const getPublicPageBySlug = cache(async (orgId: string, slug: string): Promise<PublicPage | null> => {
  const clean = String(slug || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) return null;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_pages")
    .select("id, slug, title, description, blocks, nav_label")
    .eq("org_id", orgId)
    .eq("published", true)
    .eq("slug", clean)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { ...(data as PublicPage), blocks: sanitizeTextBlocks(normalizeBlocks((data as { blocks?: unknown }).blocks)) };
});

/** Every published page's slug, for the sitemap. */
export const getPublicPageSlugs = cache(async (orgId: string): Promise<string[]> => {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_pages")
    .select("slug")
    .eq("org_id", orgId)
    .eq("published", true)
    .order("nav_order", { ascending: true })
    .limit(500);
  return ((data ?? []) as { slug: string }[]).map((p) => p.slug);
});

/** Published pages that opt into the site nav (nav_label set), for the header menu. */
export const getNavPages = cache(async (orgId: string): Promise<{ slug: string; nav_label: string }[]> => {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_pages")
    .select("slug, nav_label")
    .eq("org_id", orgId)
    .eq("published", true)
    .not("nav_label", "is", null)
    .order("nav_order", { ascending: true })
    .limit(20);
  return ((data ?? []) as { slug: string; nav_label: string | null }[])
    .filter((p) => p.nav_label)
    .map((p) => ({ slug: p.slug, nav_label: p.nav_label as string }));
});
