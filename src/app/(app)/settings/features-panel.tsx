import { createClient } from "@/lib/supabase/server";
import { FEATURE_KEYS, type FeatureKey } from "@/lib/features";
import { featureCounts } from "@/lib/feature-counts";
import { orgPublicBaseUrl, type OrgSettings } from "@/lib/org-settings";
import { FeatureBoard } from "./feature-board";

/**
 * Settings > Features, the server half: ONE read for the board (the counts behind "Off · N saved"
 * and the Recurring Billing confirm, whether anyone but the owner is on the team, and whether the
 * database has the switches yet), then the board itself. Rendered only when the Features cluster is
 * the one open, so no other Settings page pays for these counts.
 */
export async function FeaturesPanel({ orgId, settings, isOwner }: { orgId: string; settings: OrgSettings; isOwner: boolean }) {
  const supabase = await createClient();
  // Counts only where they are said: a switch that is off (its own value), and the repeat invoices
  // the Recurring Billing confirm names.
  const counted: FeatureKey[] = [...FEATURE_KEYS.filter((k) => settings.features[k] === false), "recurring_billing"];
  const [counts, crew, probe] = await Promise.all([
    featureCounts(supabase, orgId, counted),
    supabase.from("profiles").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("active", true).neq("role", "owner"),
    supabase.rpc("feature_keys"),
  ]);
  // Before 0352 the switches can't save; the board says so instead of rendering switches that fail.
  const ready = !(probe.error && (probe.error.code === "PGRST202" || probe.error.code === "42883"));
  const siteName =
    settings.custom_domain || settings.public_handle ? orgPublicBaseUrl(settings).replace(/^https?:\/\//, "") : null;
  return (
    <FeatureBoard
      features={settings.features}
      isOwner={isOwner}
      counts={counts}
      siteName={siteName}
      crewQuiet={crew.count === 0}
      ready={ready}
    />
  );
}
