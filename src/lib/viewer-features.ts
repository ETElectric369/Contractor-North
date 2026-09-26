import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { ALL_ON, FEATURE_BY_KEY, type FeatureKey, type FeatureMap } from "@/lib/features";

/**
 * THE SWITCHES FOR A PAGE THAT DOESN'T READ ITS COMPANY ALREADY (the switch board, 0352). One read:
 * the signed-in person's role and their company's settings, normalized by getOrgSettings (missing =
 * ON). The Off line needs both: the switch, and whether this person is the one who can turn it on.
 *
 * A failed read is everything ON and not the owner: exactly today's app, and never a Turn On button
 * that might refuse. cache(): a page and the parts it renders ask once per request.
 */
export type ViewerFeatures = { features: FeatureMap; isOwner: boolean };
const FALLBACK: ViewerFeatures = { features: ALL_ON, isOwner: false };

export const readViewerFeatures = cache(async (): Promise<ViewerFeatures> => {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return FALLBACK;
    // The embed follows profiles.org_id, so it can only ever be this person's own company.
    const { data, error } = await supabase
      .from("profiles")
      .select("role, organizations(settings)")
      .eq("id", user.id)
      .maybeSingle();
    if (error || !data) return FALLBACK;
    const row = data as { role?: string | null; organizations?: { settings?: unknown } | { settings?: unknown }[] | null };
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    return { features: getOrgSettings(org?.settings).features, isOwner: row.role === "owner" };
  } catch {
    return FALLBACK;
  }
});

/** The plain refusal a server door gives while its feature is off: what is off, and who can turn it
 *  on. One sentence, so every door says it the same way. */
export function featureOffSentence(key: FeatureKey): string {
  return `${FEATURE_BY_KEY[key].label} is off. The owner can turn it on in Settings, Features.`;
}
