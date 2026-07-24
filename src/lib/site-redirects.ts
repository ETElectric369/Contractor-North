import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";

/**
 * Org-site URL redirects (migration 0148) — the automatic Squarespace-style URL-mappings
 * manager. Written by the page/post save actions whenever a slug/path is renamed; read by
 * the public-site resolvers on a miss, BEFORE the 404, so an old indexed URL 301s to its
 * new home instead of soft-404ing. Service client on both sides: reads are org-scoped by
 * the host/handle resolved upstream (never caller input), writes happen inside the
 * already-authenticated save actions. Paths are public paths with a leading slash.
 */

const clean = (p: string): string => "/" + String(p || "").trim().toLowerCase().replace(/^\/+|\/+$/g, "");

/** The redirect target for a missed public path, or null. */
export const getSiteRedirect = cache(async (orgId: string, fromPath: string): Promise<string | null> => {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_redirects")
    .select("to_path")
    .eq("org_id", orgId)
    .eq("from_path", clean(fromPath))
    .maybeSingle();
  return (data as { to_path?: string } | null)?.to_path ?? null;
});

/**
 * Record old→new on a rename. Also clears any stale mapping FROM the new path (a page
 * re-created at — or renamed back to — a previously-redirected URL must reclaim it), and
 * re-points any older chain ENDING at the old path straight to the new one (A→B, B→C
 * collapses to A→C — Google dislikes redirect chains). Best-effort: a failure must never
 * block the save itself.
 */
export async function recordSiteRedirect(orgId: string, fromPath: string, toPath: string): Promise<void> {
  const from = clean(fromPath);
  const to = clean(toPath);
  if (from === to || from === "/") return;
  try {
    const supabase = createServiceClient();
    await supabase.from("site_redirects").delete().eq("org_id", orgId).eq("from_path", to);
    await supabase.from("site_redirects").update({ to_path: to }).eq("org_id", orgId).eq("to_path", from);
    await supabase
      .from("site_redirects")
      .upsert({ org_id: orgId, from_path: from, to_path: to }, { onConflict: "org_id,from_path" });
  } catch (e) {
    reportError("site-redirects", e, { orgId, from, to });
  }
}
