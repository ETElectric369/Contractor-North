"use server";

import { revalidatePath } from "next/cache";
import { resolveSiteContext } from "@/lib/site-editor-guard";
import { recordSiteRedirect } from "@/lib/site-redirects";
import { sanitizeHtml, textToHtml } from "@/lib/sanitize-html";
import { normalizeBlocks, type Block } from "@/lib/site-blocks";
import { isReservedSlug, slugifySiteSlug } from "@/lib/site-reserved";
import { updateOrgSettings } from "./actions";

/**
 * Custom builder PAGES (site_pages). Editable by org staff and a granted external collaborator
 * (resolveSiteContext); RLS enforces org scope. Blocks are stored as typed data — the `text` block's
 * HTML is sanitized at write (the only raw-HTML sink, same as articles); everything else renders
 * through React. Served at /p/<slug> on the org site.
 */
export type Result = { ok: boolean; error?: string; id?: string };

/** Sanitize the one raw-HTML sink (text blocks) + normalize every block shape before storing. */
function cleanBlocks(blocks: Block[]): Block[] {
  return normalizeBlocks(
    blocks.map((b) => {
      if (b.type === "text") {
        const raw = b.props.html ?? "";
        return { type: "text", props: { html: /<[a-z][\s\S]*>/i.test(raw) ? sanitizeHtml(raw) : textToHtml(raw) }, style: b.style };
      }
      return b;
    }),
  );
}

export async function saveSitePage(input: {
  id?: string | null;
  slug?: string | null;
  title: string;
  description?: string | null;
  blocks: Block[];
  published?: boolean;
  nav_label?: string | null;
  nav_order?: number;
  /** Optional search-result title override (the <title> tag) — blank keeps "<title> — <org>". */
  seo_title?: string | null;
  orgId?: string;
}): Promise<Result> {
  const ctx = await resolveSiteContext(input.orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "Give the page a title." };

  const slug = slugifySiteSlug(String(input.slug ?? "") || title);
  if (!slug) return { ok: false, error: "Give the page a valid web address." };
  // Pages serve at root-level slugs (/about) — a reserved slug would shadow a real app/site route.
  if (isReservedSlug(slug)) return { ok: false, error: `"${slug}" is a reserved address — pick another.` };

  const row: Record<string, unknown> = {
    org_id: ctx.orgId,
    slug,
    title,
    description: String(input.description ?? "").trim() || null,
    blocks: cleanBlocks(input.blocks ?? []),
    published: input.published ?? true,
    nav_label: String(input.nav_label ?? "").trim() || null,
    seo_title: String(input.seo_title ?? "").trim().slice(0, 120) || null,
    updated_at: new Date().toISOString(),
  };
  // nav_order: only write it when the caller actually sent one. The editor doesn't (yet)
  // carry an order field, so an omitted value must PRESERVE the stored order on edit —
  // the old `?? 0` reset every edited page to 0, piling the menu into undefined tie order.
  if (Number.isFinite(input.nav_order)) row.nav_order = input.nav_order;

  const dupMsg = "A page already exists at that web address.";
  if (input.id) {
    delete (row as { org_id?: unknown }).org_id; // don't move a page across orgs on edit
    // Rename detection BEFORE the write: a changed slug orphans the old public URL, so the
    // old→new mapping is recorded in site_redirects (0148) and the resolvers 301 it — the
    // Squarespace-style URL-mappings behavior, kept automatic (SEO wave 2026-07-24).
    const { data: prior } = await ctx.supabase
      .from("site_pages").select("slug").eq("id", input.id).eq("org_id", ctx.orgId).maybeSingle();
    // Scope to the validated org too (not just id): RLS already gates writes, this pins the edit to
    // the context's org so a multi-grant collaborator can't touch another granted org's page by id.
    const { data, error } = await ctx.supabase.from("site_pages").update(row).eq("id", input.id).eq("org_id", ctx.orgId).select("id");
    if (error) return { ok: false, error: /duplicate|unique/i.test(error.message) ? dupMsg : error.message };
    if (!data?.length) return { ok: false, error: "That page no longer exists." };
    const oldSlug = (prior as { slug?: string } | null)?.slug;
    if (oldSlug && oldSlug !== slug) await recordSiteRedirect(ctx.orgId, `/${oldSlug}`, `/${slug}`);
    revalidatePath("/settings");
    revalidatePath("/content");
    return { ok: true, id: input.id };
  }

  // New pages APPEND to the menu (max nav_order + 1) instead of piling at the DB default 0,
  // where the tie order between them is undefined and the public nav could shuffle.
  if (!Number.isFinite(input.nav_order)) {
    const { data: last } = await ctx.supabase
      .from("site_pages")
      .select("nav_order")
      .eq("org_id", ctx.orgId)
      .order("nav_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    row.nav_order = (Number((last as { nav_order?: number } | null)?.nav_order) || 0) + 1;
  }
  const { data, error } = await ctx.supabase
    .from("site_pages")
    .insert({ ...row, created_by: ctx.userId })
    .select("id")
    .single();
  if (error) return { ok: false, error: /duplicate|unique/i.test(error.message) ? dupMsg : error.message };
  revalidatePath("/settings");
  revalidatePath("/content");
  return { ok: true, id: data.id };
}

/** Save the homepage's custom sections (settings.home_blocks) — same block model + text sanitization
 *  as pages. Routes through updateOrgSettings, so it works for BOTH org staff (direct, protected-key
 *  strip) AND a granted external collaborator (the whitelist RPC — home_blocks is a whitelisted array
 *  key, so business config stays unreachable). Sanitized here at write; the homepage re-sanitizes on
 *  read (renderReadyBlocks), so a direct-RPC write that skips this action still can't XSS the site. */
export async function saveHomeBlocks(blocks: Block[], orgId?: string): Promise<Result> {
  const ctx = await resolveSiteContext(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const clean = cleanBlocks(blocks ?? []);
  const res = await updateOrgSettings({ home_blocks: clean }, orgId);
  if (res.ok) revalidatePath("/", "layout");
  return res;
}

export async function deleteSitePage(id: string, orgId?: string): Promise<Result> {
  const ctx = await resolveSiteContext(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.supabase.from("site_pages").delete().eq("id", id).eq("org_id", ctx.orgId).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "That page no longer exists." };
  revalidatePath("/settings");
  revalidatePath("/content");
  return { ok: true };
}
