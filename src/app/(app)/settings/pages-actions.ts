"use server";

import { revalidatePath } from "next/cache";
import { resolveSiteContext } from "@/lib/site-editor-guard";
import { sanitizeHtml, textToHtml } from "@/lib/sanitize-html";
import { normalizeBlocks, type Block } from "@/lib/site-blocks";
import { isReservedSlug } from "@/lib/site-reserved";

/**
 * Custom builder PAGES (site_pages). Editable by org staff and a granted external collaborator
 * (resolveSiteContext); RLS enforces org scope. Blocks are stored as typed data — the `text` block's
 * HTML is sanitized at write (the only raw-HTML sink, same as articles); everything else renders
 * through React. Served at /p/<slug> on the org site.
 */
export type Result = { ok: boolean; error?: string; id?: string };

function slugify(s: string): string {
  return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

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
  orgId?: string;
}): Promise<Result> {
  const ctx = await resolveSiteContext(input.orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "Give the page a title." };

  const slug = slugify(String(input.slug ?? "") || title);
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
    nav_order: Number.isFinite(input.nav_order) ? input.nav_order : 0,
    updated_at: new Date().toISOString(),
  };

  const dupMsg = "A page already exists at that web address.";
  if (input.id) {
    delete (row as { org_id?: unknown }).org_id; // don't move a page across orgs on edit
    // Scope to the validated org too (not just id): RLS already gates writes, this pins the edit to
    // the context's org so a multi-grant collaborator can't touch another granted org's page by id.
    const { data, error } = await ctx.supabase.from("site_pages").update(row).eq("id", input.id).eq("org_id", ctx.orgId).select("id");
    if (error) return { ok: false, error: /duplicate|unique/i.test(error.message) ? dupMsg : error.message };
    if (!data?.length) return { ok: false, error: "That page no longer exists." };
    revalidatePath("/settings");
    revalidatePath("/content");
    return { ok: true, id: input.id };
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
 *  as pages, merged into the org's settings jsonb. Staff or a granted collaborator; org-scoped. */
export async function saveHomeBlocks(blocks: Block[], orgId?: string): Promise<Result> {
  const ctx = await resolveSiteContext(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const clean = cleanBlocks(blocks ?? []);

  const { data: org } = await ctx.supabase.from("organizations").select("settings").eq("id", ctx.orgId).single();
  const merged = { ...((org?.settings as Record<string, unknown>) ?? {}), home_blocks: clean };
  const { error } = await ctx.supabase.from("organizations").update({ settings: merged }).eq("id", ctx.orgId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/content");
  revalidatePath("/", "layout");
  return { ok: true };
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
