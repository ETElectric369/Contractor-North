import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { DEFAULT_SETTINGS, type OrgSettings } from "@/lib/org-settings";

/**
 * The marketing/on-page-SEO settings keys an external collaborator may edit — and, just as
 * important, the ONLY settings values that may be sent to their browser. Must stay in lockstep with
 * the whitelist in the update_site_content RPC (migration 0113, last re-created 0134): that RPC is
 * the write boundary, this is the read boundary. Everything else in settings (pricing, playbook,
 * secrets, thresholds) is business config and never leaves the server for a collaborator.
 */
export const SITE_CONTENT_KEYS = [
  "splash_headline", "splash_headline_size", "splash_tagline", "splash_bg_url", "splash_bullets",
  "splash_credentials", "portfolio", "specialty_headline", "specialty_blurb", "service_area",
  "site_theme", "social_instagram", "google_business_url", "reviews", "home_blocks",
] as const satisfies readonly (keyof OrgSettings)[];

/** Build a settings object safe to hand a collaborator's browser: real marketing values overlaid on
 *  DEFAULTS, so sensitive keys carry harmless defaults (never the org's real business config). */
export function marketingSettingsFor(full: OrgSettings): OrgSettings {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of SITE_CONTENT_KEYS) (out as Record<string, unknown>)[k] = full[k];
  return out;
}

export type SiteContext = {
  supabase: SupabaseClient;
  userId: string;
  orgId: string;
  isCollaborator: boolean;
};

/**
 * Resolve WHO is editing site content and for WHICH org. Two kinds of caller:
 *  - org STAFF → their own org.
 *  - an EXTERNAL site collaborator (an outside SEO/content pro): their profile.org_id is NULL, so
 *    they're not an org member and every operational table denies them; their only access is a
 *    site_collaborators grant. For the MVP a collaborator holds one grant; pass orgId to
 *    disambiguate once they can hold several.
 *
 * This only RESOLVES the org — it grants nothing. The returned client is the caller's own
 * RLS-bound client, and site_posts RLS independently admits staff-of-org OR grant-of-org, so a
 * mis-resolved org still can't read or write another org's posts.
 */
export async function resolveSiteContext(orgId?: string): Promise<SiteContext | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: me } = await supabase.from("profiles").select("org_id, role").eq("id", user.id).maybeSingle();
  const staffOrg = me?.org_id && isStaffRole(me.role) ? me.org_id : null;

  // Grants the caller holds (site_collab_self lets them read their own). A person can be BOTH staff
  // of their own org AND an external collaborator of others — resolve by the requested org, not by
  // assuming one role wins.
  const { data: grants } = await supabase
    .from("site_collaborators")
    .select("org_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  const grantedOrgs = [...new Set((grants ?? []).map((g) => (g as { org_id: string }).org_id))];

  if (orgId) {
    if (staffOrg === orgId) return { supabase, userId: user.id, orgId, isCollaborator: false };
    if (grantedOrgs.includes(orgId)) return { supabase, userId: user.id, orgId, isCollaborator: true };
    return { error: "You don't have access to that site." };
  }
  // Infer when unambiguous.
  if (staffOrg) return { supabase, userId: user.id, orgId: staffOrg, isCollaborator: false };
  if (grantedOrgs.length === 1) return { supabase, userId: user.id, orgId: grantedOrgs[0], isCollaborator: true };
  if (grantedOrgs.length > 1) return { error: "You manage more than one site — open the one you want first." };
  return { error: "You don't have access to manage articles." };
}
