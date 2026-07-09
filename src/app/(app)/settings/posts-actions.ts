"use server";

import { revalidatePath } from "next/cache";
import { resolveSiteContext } from "@/lib/site-editor-guard";
import { sanitizeHtml, textToHtml } from "@/lib/sanitize-html";
import { CONTENT_ROOTS, isValidPostPath } from "@/lib/site-content-roots";

/**
 * Site articles (site_posts) — the "SEO vendor publishes into North" door. Editable by org STAFF
 * and by an invited EXTERNAL site collaborator (resolveSiteContext resolves which, and for which
 * org); RLS independently enforces org scope on every row. Body HTML is sanitized at write so the
 * public article page can render it directly. `path` is the post's full public path on the org's
 * domain ("blog/<slug>" for new posts; a migrated post keeps its ORIGINAL path so the indexed URL
 * keeps working).
 */
export type Result = { ok: boolean; error?: string; id?: string };

function revalidateSite() {
  revalidatePath("/settings");
  revalidatePath("/content");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function saveSitePost(input: {
  id?: string | null;
  title: string;
  /** Full public path — left blank, it becomes blog/<slug-of-title>. */
  path?: string | null;
  description?: string | null;
  /** Article body — pasted HTML (sanitized) or plain text (auto-paragraphed). */
  body: string;
  published?: boolean;
  cover_url?: string | null;
  /** Which org's site — only needed to disambiguate a collaborator with grants to several. */
  orgId?: string;
}): Promise<Result> {
  const ctx = await resolveSiteContext(input.orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "Give the article a title." };

  let path = String(input.path ?? "").trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!path) path = `blog/${slugify(title) || "untitled"}`;
  // Must route: only paths under a known content root are served on the org's own domain, so
  // refusing others here keeps the sitemap/blog-index from ever advertising a URL that 301s home.
  if (!isValidPostPath(path)) {
    return {
      ok: false,
      error: `Web address must start with ${CONTENT_ROOTS.map((r) => `${r}/`).join(" or ")} (e.g. blog/${slugify(title) || "my-article"}).`,
    };
  }

  const raw = String(input.body ?? "");
  const body_html = /<[a-z][\s\S]*>/i.test(raw) ? sanitizeHtml(raw) : textToHtml(raw);
  const published = input.published ?? true;

  const base = {
    title,
    path,
    description: String(input.description ?? "").trim() || null,
    body_html,
    published,
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    // Read the prior state so we (a) never null a cover the editor didn't carry, and (b) stamp
    // published_at only on the draft→published transition (so a live post's date isn't reset by
    // an edit, and a just-published draft doesn't show its draft-creation date).
    const { data: prev } = await supabase
      .from("site_posts")
      .select("cover_url, published, published_at")
      .eq("id", input.id)
      .maybeSingle();
    if (!prev) return { ok: false, error: "That article no longer exists." };
    const row: Record<string, unknown> = {
      ...base,
      cover_url: input.cover_url !== undefined ? input.cover_url || null : prev.cover_url,
    };
    if (published && !prev.published) row.published_at = new Date().toISOString();
    const { data: updated, error } = await supabase.from("site_posts").update(row).eq("id", input.id).select("id");
    if (error) {
      return { ok: false, error: /duplicate|unique/i.test(error.message) ? "An article already exists at that web address." : error.message };
    }
    if (!updated?.length) return { ok: false, error: "That article no longer exists." };
    revalidateSite();
    return { ok: true, id: input.id };
  }

  const { data, error } = await supabase
    .from("site_posts")
    // Stamp org_id explicitly: a collaborator's auth_org_id() is null (they're not an org member),
    // so the set_org_id trigger can't infer it — and RLS with-check confirms they hold the grant.
    .insert({ ...base, org_id: ctx.orgId, cover_url: input.cover_url || null, created_by: ctx.userId })
    .select("id")
    .single();
  if (error) {
    return {
      ok: false,
      error: /duplicate|unique/i.test(error.message) ? "An article already exists at that web address." : error.message,
    };
  }
  revalidateSite();
  return { ok: true, id: data.id };
}

export async function deleteSitePost(id: string, orgId?: string): Promise<Result> {
  const ctx = await resolveSiteContext(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.supabase.from("site_posts").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "That article no longer exists." };
  revalidateSite();
  return { ok: true };
}
