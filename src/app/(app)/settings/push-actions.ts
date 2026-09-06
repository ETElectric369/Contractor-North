"use server";
import { dbError } from "@/lib/db-error";

import { createClient } from "@/lib/supabase/server";

/** Save (or refresh) the current user's push subscription for this device. */
export async function savePushSubscription(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return { ok: false, error: "Invalid subscription" };
  }
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      profile_id: user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      user_agent: userAgent ?? null,
    },
    { onConflict: "endpoint" },
  );
  if (error) return { ok: false, error: dbError(error) };
  return { ok: true };
}

/** Remove a device subscription (when the user turns notifications off). */
export async function removePushSubscription(endpoint: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  // A ZERO-ROW DELETE IS A 204 (audit v921). Deleting by endpoint alone matched nothing whenever
  // the row belonged to another profile on a shared device — push_subs_own scopes to auth.uid()
  // and endpoint is unique — yet this said ok, so the screen read "Turned off for this device"
  // while the server row lived on until web-push finally got a 410.
  const { data: gone, error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("profile_id", user.id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) {
    return { ok: false, error: "This device's notifications weren't registered to your account — nothing was turned off on the server." };
  }
  return { ok: true };
}

/** Save the current user's per-trigger notification toggles. */
export async function savePushPrefs(prefs: Record<string, boolean>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const { error } = await supabase.from("profiles").update({ push_prefs: prefs }).eq("id", user.id);
  if (error) return { ok: false, error: dbError(error) };
  return { ok: true };
}
