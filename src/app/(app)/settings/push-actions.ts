"use server";
import { dbError } from "@/lib/db-error";

import { createClient, createServiceClient } from "@/lib/supabase/server";

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

/**
 * Register THIS PHONE for Apple push (the native shell). The web flow above stores a Web Push
 * endpoint; the shell has no service worker and therefore no endpoint at all, only an APNs device
 * token — 0250 lets one table hold either, so the whole fan-out, the `active` boundary and the
 * per-user toggles stay in one place.
 *
 * org_id rides along like the web row's does, so an org's rows are prunable together.
 */
export async function saveDeviceToken(deviceToken: string, userAgent?: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };
  // APNs tokens are hex. Refuse anything else rather than storing junk that can only ever 400.
  const token = String(deviceToken ?? "").trim();
  if (!/^[0-9a-fA-F]{32,200}$/.test(token)) return { ok: false, error: "Invalid device token" };

  // A PHONE BELONGS TO WHOEVER IS SIGNED IN ON IT. A crew phone gets handed around, and a device
  // token is unique per INSTALL, not per person — so registering has to be able to take the token
  // off the previous signed-in user, or the next person's alerts keep going to the last one.
  //
  // RLS can't express that: push_subs_own is `profile_id = auth.uid()`, so an upsert colliding
  // with someone else's row fails its USING check and errors on the unique index instead of
  // re-pointing. Hence the SERVICE client, scoped BY HAND to this one token — the same pattern,
  // and the same reasoning, as the fan-out in lib/push.ts. The user is already authenticated
  // above; the only thing this widens is which ROW may be replaced, and only for a caller who
  // already holds the 64-hex token the OS issued to that install.
  const svc = createServiceClient();
  await svc.from("push_subscriptions").delete().eq("device_token", token);
  const { data: rows, error } = await svc
    .from("push_subscriptions")
    .insert({
      profile_id: user.id,
      platform: "ios",
      device_token: token,
      user_agent: userAgent ?? null,
      // Null: the sender probes production, then sandbox, and writes back whichever answered.
      apns_env: null,
    })
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  // THE SILENT-WRITE LAW: a refused write is a 200 with no rows.
  if (!rows?.length) return { ok: false, error: "Couldn't register this device for notifications." };
  return { ok: true };
}

/** Turn this phone's notifications off — the native twin of removePushSubscription. */
export async function removeDeviceToken(deviceToken: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  // Scoped to the caller's OWN row on purpose — turning notifications off is not a reason to be
  // able to delete somebody else's registration.
  const { data: gone, error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("device_token", deviceToken)
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
