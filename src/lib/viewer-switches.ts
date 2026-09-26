import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { ALL_ON, FEATURE_BY_KEY, type FeatureKey, type FeatureMap } from "@/lib/features";

export type ViewerSwitches = { features: FeatureMap; isOwner: boolean };

/** Nothing read (signed out, a failed read): every feature on and no Turn On. All on draws no Off
 *  line and hides no door, so a lost read leaves every page exactly as it was before the switches. */
export const SWITCHES_UNREAD: ViewerSwitches = { features: ALL_ON, isOwner: false };

/** The pure half: a profile row with its company's settings embedded → the switches and whether this
 *  person may move one (the owner of an ACTIVE seat, the same person set_org_feature lets through). */
export function switchesFromRow(row: unknown): ViewerSwitches {
  if (!row || typeof row !== "object") return SWITCHES_UNREAD;
  const r = row as { role?: unknown; active?: unknown; organizations?: unknown };
  // A to-one embed arrives as an object; tolerate the array shape PostgREST gives an ambiguous one.
  const org = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
  return {
    features: getOrgSettings((org as { settings?: unknown } | null | undefined)?.settings).features,
    isOwner: r.role === "owner" && r.active !== false,
  };
}

/**
 * THE SWITCHES AND WHO IS LOOKING (the switch board, 0352), for a page that hides a feature's doors
 * or draws its Off line and doesn't already read the company's settings and the viewer's role.
 * ONE read per request (React cache()), however many doors on the page ask: the viewer, then their
 * profile with the company's settings embedded. The company comes from the profile's own org_id
 * (the embed follows that key), never from a bare organizations read.
 */
export const viewerSwitches = cache(async (): Promise<ViewerSwitches> => {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return SWITCHES_UNREAD;
    const { data, error } = await supabase
      .from("profiles")
      .select("role, active, organizations(settings)")
      .eq("id", user.id)
      .maybeSingle();
    if (error) return SWITCHES_UNREAD;
    return switchesFromRow(data);
  } catch {
    return SWITCHES_UNREAD;
  }
});

/** The plain refusal a server door gives while its feature is off: what is off, and who can turn it
 *  on. One sentence, so every door says it the same way. */
export function featureOffSentence(key: FeatureKey): string {
  return `${FEATURE_BY_KEY[key].label} is off. The owner can turn it on in Settings, Features.`;
}
