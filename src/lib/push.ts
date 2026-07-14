import "server-only";
import webpush from "web-push";
import { STAFF_ROLES } from "@/lib/actions/perms";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";

const PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@contractor-north.app";

let vapidReady = false;
export function pushConfigured() {
  return !!(PUBLIC && PRIVATE);
}
function ensureVapid() {
  if (!pushConfigured()) return false;
  if (!vapidReady) {
    webpush.setVapidDetails(SUBJECT, PUBLIC!, PRIVATE!);
    vapidReady = true;
  }
  return true;
}

/** Profile ids of an org's office staff (owner/admin/office) — for staff-facing
 *  alerts like new inquiries, accepted quotes, and paid invoices. */
export async function orgStaffIds(orgId: string | null | undefined): Promise<string[]> {
  if (!orgId) return [];
  try {
    const sb = createServiceClient();
    const { data } = await sb
      .from("profiles")
      .select("id")
      .eq("org_id", orgId)
      .in("role", STAFF_ROLES);
    return (data ?? []).map((p: any) => p.id);
  } catch {
    return [];
  }
}

export type PushKind =
  | "assigned"
  | "inquiry"
  | "quote_accepted"
  | "invoice_paid"
  | "day_ahead"
  | "clock_out"
  | "daily_report";

// What each trigger defaults to when a user hasn't set an explicit toggle.
const DEFAULTS: Record<PushKind, boolean> = {
  assigned: true,
  inquiry: true,
  quote_accepted: true,
  invoice_paid: true,
  day_ahead: false,
  // Defaults ON now that a sender exists (notifyGeofenceExit): it only fires for a
  // NON-STAFF user who left the geofence while clocked in — Erik: "push at geofence
  // for clock out only for techs". Opt out per-user in Settings → Notifications.
  clock_out: true,
  // A crew lead's end-of-day debrief was filed — staff-facing, like quote_accepted.
  daily_report: true,
};

/**
 * Best-effort web push to a set of profiles, respecting each user's toggle for
 * this notification kind. Never throws — safe to call (un-awaited) from any
 * server action; a push failure must not break the underlying operation.
 */
export async function sendPushToProfiles(
  profileIds: (string | null | undefined)[],
  kind: PushKind,
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  try {
    if (!ensureVapid()) return;
    const ids = [...new Set(profileIds.filter((x): x is string => !!x))];
    if (!ids.length) return;

    const sb = createServiceClient();
    const { data: profs } = await sb.from("profiles").select("id, push_prefs").in("id", ids);
    const allowed = (profs ?? [])
      .filter((p: any) => {
        const pref = (p.push_prefs ?? {})[kind];
        return pref === undefined ? DEFAULTS[kind] : !!pref;
      })
      .map((p: any) => p.id);
    if (!allowed.length) return;

    const { data: subs } = await sb
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .in("profile_id", allowed);
    if (!subs?.length) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? "/planner",
    });

    await Promise.all(
      subs.map(async (s: any) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
          );
        } catch (e: any) {
          // Prune dead/expired subscriptions so we stop retrying them.
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await sb.from("push_subscriptions").delete().eq("id", s.id);
          }
        }
      }),
    );
  } catch (e) {
    // A whole-batch failure (VAPID/config) is systematic, not an expected dead sub.
    reportError("push", e);
  }
}
