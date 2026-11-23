import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgSettings } from "@/lib/org-settings";
import { offersOpenTimes, openInspectionTimes, openTimeLabel } from "@/lib/schedule/open-times";

/** What the Inspection Days card shows as "right now": the labels, a failed read, or nothing read. */
export type OpenTimesPreview = { labels: string[] } | { failed: true } | null;

/**
 * WHAT A WEBSITE VISITOR WOULD BE OFFERED RIGHT NOW (cn-v1185), for the settings page. Read only
 * while the saved offer is on, with the signed-in staff member's own client and own company id, by
 * the same reader the public door uses. A throw from the reader is { failed } ("Couldn't read the
 * calendar"), never an empty list ("nothing open"): a failed read is never "nothing is busy".
 */
export async function readOpenTimesPreview(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
  settings: OrgSettings,
  now?: Date,
): Promise<OpenTimesPreview> {
  if (!orgId || !offersOpenTimes(settings)) return null;
  try {
    const times = await openInspectionTimes(supabase, orgId, settings, now);
    return { labels: times.map((t) => openTimeLabel(t)) };
  } catch {
    return { failed: true };
  }
}
