import { cache } from "react";
import type { Metadata } from "next";
import { resolveSiteContext } from "@/lib/site-editor-guard";
import { createServiceClient } from "@/lib/supabase/server";
import { renderReadyBlocks, type PublicPage } from "@/lib/public-pages";
import type { PublicPost } from "@/lib/public-posts";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Draft preview for the org-site routes: an UNPUBLISHED site_page/site_post normally doesn't exist
 * to the public (the routes redirect home), but its editor needs to see it at its real URL before
 * flipping it live. `?preview=1` opts a request in; the caller must then pass resolveSiteContext —
 * the SAME auth the /content workspace uses (org staff OR a granted external collaborator, nothing
 * new invented here). Everyone else keeps the exact public behavior, preview param or not.
 *
 * The draft fetchers below gate INTERNALLY (they run on the service client, which bypasses RLS),
 * so a route that forgets the auth check still can't leak a draft.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Did this request explicitly ask for a draft preview? (Never true for normal public traffic.) */
export async function previewRequested(searchParams?: SearchParams): Promise<boolean> {
  const sp = searchParams ? await searchParams : undefined;
  return sp?.preview === "1";
}

/** May the CALLER preview this org's drafts? cache()d so the page + its generateMetadata share one
 *  resolution per request. Anonymous visitors (no session cookie on the org's domain) get false. */
const canPreviewDrafts = cache(async (orgId: string): Promise<boolean> => {
  const ctx = await resolveSiteContext(orgId);
  return !("error" in ctx);
});

/** A draft (or published — state may flip mid-session) builder page, ONLY for an authorized
 *  previewer. Mirrors getPublicPageBySlug minus the published filter, gate included. */
export const getDraftPageForPreview = cache(async (orgId: string, slug: string): Promise<PublicPage | null> => {
  if (!(await canPreviewDrafts(orgId))) return null;
  const clean = String(slug || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) return null;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_pages")
    .select("id, slug, title, description, blocks, nav_label")
    .eq("org_id", orgId)
    .eq("slug", clean)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { ...(data as PublicPage), blocks: renderReadyBlocks((data as { blocks?: unknown }).blocks) };
});

/** A draft article, ONLY for an authorized previewer. Mirrors getPublicPostByPath minus the
 *  published filter — including the sanitize-on-READ of body_html (drafts hit the same
 *  dangerouslySetInnerHTML sink as published posts). */
export const getDraftPostForPreview = cache(async (orgId: string, path: string): Promise<PublicPost | null> => {
  if (!(await canPreviewDrafts(orgId))) return null;
  const clean = String(path || "").toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_posts")
    .select("id, path, title, description, cover_url, body_html, published_at")
    .eq("org_id", orgId)
    .eq("path", clean)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const post = data as PublicPost;
  return { ...post, body_html: sanitizeHtml(post.body_html ?? "") };
});

/** Metadata for a draft preview: the page's normal metadata, but noindex and WITHOUT the public
 *  canonical — a draft URL must never be advertised as the canonical of anything. */
export function draftPreviewMetadata(published: Metadata): Metadata {
  return { ...published, alternates: undefined, robots: { index: false, follow: false } };
}

/** Slim fixed banner so a previewer can't mistake a draft for the live page. Bottom edge — the
 *  site header is sticky at the top. */
export function DraftPreviewBanner() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 bg-amber-500 px-4 py-2 text-center text-sm font-semibold text-white shadow-[0_-1px_6px_rgba(0,0,0,0.15)]">
      Draft preview — not visible to the public
    </div>
  );
}
