"use server";

import { dbError } from "@/lib/db-error";
import { coerceSiteDoc, extractSiteDoc } from "@/lib/site-doc";
import { requireStaff } from "@/lib/staff-guard";

/**
 * THE ON-PAGE EDITOR'S SAVE (Erik: "edit the fonts and size ... or change the text right there
 * on the screen so i can see it and design it in real time"). A field patch from the live editor
 * lands on the DRAFT version through the same trust boundary as a design pass — coerceSiteDoc
 * with absent-keeps-base, so the patch touches exactly the fields the person edited and nothing
 * else. Draft-only, staff-only (the editor only mounts inside an authorized preview, but the
 * server re-checks — a route is never the gate).
 */
export async function updateVersionFields(
  versionId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  const { data: ver } = await ctx.supabase
    .from("site_versions")
    .select("id, status, doc")
    .eq("id", versionId)
    .maybeSingle();
  if (!ver) return { ok: false, error: "That version wasn't found." };
  if ((ver as { status: string }).status !== "draft")
    return { ok: false, error: "Only drafts can be edited on the page." };
  const base = extractSiteDoc((ver as { doc: unknown }).doc);
  const { doc } = coerceSiteDoc(patch, base);
  const { data: upd, error } = await ctx.supabase
    .from("site_versions")
    .update({ doc })
    .eq("id", versionId)
    .eq("status", "draft")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!upd?.length) return { ok: false, error: "The save didn't land — the version may have just been published." };
  return { ok: true };
}
