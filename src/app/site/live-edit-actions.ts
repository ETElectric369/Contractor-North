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
): Promise<{ ok: true; values: Record<string, unknown>; dropped: string[] } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  // Read-coerce-write under a CAS token (doc_rev, 0210): two writers (a second tab, the studio's
  // block editor) can no longer silently lose the earlier patch — a collision re-reads and
  // re-applies this patch on the fresh doc, bounded at 3 attempts.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: ver } = await ctx.supabase
      .from("site_versions")
      .select("id, status, doc, doc_rev")
      .eq("id", versionId)
      .maybeSingle();
    if (!ver) return { ok: false, error: "That version wasn't found." };
    if ((ver as { status: string }).status !== "draft")
      return { ok: false, error: "Only drafts can be edited on the page." };
    const rev = Number((ver as { doc_rev?: unknown }).doc_rev) || 0;
    const base = extractSiteDoc((ver as { doc: unknown }).doc);
    const { doc, dropped } = coerceSiteDoc(patch, base);
    const { data: upd, error } = await ctx.supabase
      .from("site_versions")
      .update({ doc, doc_rev: rev + 1 })
      .eq("id", versionId)
      .eq("status", "draft")
      .eq("doc_rev", rev)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (upd?.length) {
      // Echo the server's answer for the patched keys — clamps and refusals must reach the
      // editor's screen, or its live paint drifts from the draft under a green "Saved".
      const values = Object.fromEntries(
        Object.keys(patch)
          .filter((k) => k in doc)
          .map((k) => [k, (doc as unknown as Record<string, unknown>)[k]]),
      );
      return { ok: true, values, dropped };
    }
    // zero rows: doc_rev moved (concurrent write) or the draft was just published — loop re-reads.
  }
  return { ok: false, error: "The save collided with another change — try again." };
}
