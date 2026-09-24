"use server";
import { dbError } from "@/lib/db-error";

import { reportError } from "@/lib/observe";
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
export async function saveDeviceToken(
  deviceToken: string,
  userAgent?: string,
  /** `background: true` = the app-launch re-registration nobody asked for, so the ops-log entry
   *  says which failure this was: a person tapping Enable, or a silent refresh going wrong. */
  opts?: { background?: boolean },
) {
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
  //
  // RE-POINT, DON'T DELETE-THEN-INSERT (2026-09-16). This used to delete the token's row and then
  // insert a fresh one. Two operations with no transaction around them: when the insert failed
  // (an RLS change, a check constraint, a dropped connection) the phone was left with NO row at
  // all — worse off than before it registered — and the background re-registration on app launch
  // threw the result away, so nothing said so. The crew simply stopped getting alerts.
  //
  // An UPDATE keyed on the token does the whole job in one statement and never opens that window:
  // the row for this install is handed to whoever is signed in now. Only a token we have never
  // seen falls through to an INSERT, where there is no row to lose.
  // THE ORG, BY HAND (2026-09-24). The web row gets its org_id from the set_org_id() insert
  // trigger, which reads auth_org_id() — and on the SERVICE client there is no auth.uid(), so
  // every phone row landed with org_id NULL (Erik's two iOS rows were the only NULL-org rows in
  // the table). The fan-out keys on profile_id, so nobody went unbuzzed, but a row with no org
  // is invisible to anything that prunes or counts by org. The org is the signed-in person's own
  // (read through RLS, their own row), and it rides on the re-point too: a phone handed to a
  // person in another org has to move orgs with them.
  // An org we couldn't read is left OFF the claim, never written as null: a re-point would
  // otherwise blank a row whose org is already right (0294 fixed them). The sender keys on
  // profile_id, so a missing org here costs housekeeping, not an alert.
  const { data: me, error: meErr } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user.id)
    .maybeSingle();
  if (meErr) reportError("saveDeviceToken.org", meErr, { background: !!opts?.background });
  const orgId = (me as { org_id?: string | null } | null)?.org_id ?? null;

  const svc = createServiceClient();
  const claim = {
    profile_id: user.id,
    ...(orgId ? { org_id: orgId } : {}),
    platform: "ios",
    user_agent: userAgent ?? null,
    // Null: the sender probes production, then sandbox, and writes back whichever answered.
    apns_env: null,
  };
  const { data: moved, error: moveErr } = await svc
    .from("push_subscriptions")
    .update(claim)
    .eq("device_token", token)
    .select("id");
  if (moveErr) {
    reportError("saveDeviceToken.repoint", moveErr, { background: !!opts?.background });
    return { ok: false, error: dbError(moveErr) };
  }
  if (moved?.length) return { ok: true };

  const { data: rows, error } = await svc
    .from("push_subscriptions")
    .insert({ ...claim, device_token: token })
    .select("id");
  if (error) {
    // 23505: another launch of the same app inserted this token between our UPDATE and our
    // INSERT (the shell re-registers on every launch, and Settings can register at the same
    // time). The row exists and is simply not ours yet — re-point it rather than telling a
    // person their phone couldn't be registered when it plainly was.
    if (String((error as { code?: string }).code) === "23505") {
      const { data: raced, error: raceErr } = await svc
        .from("push_subscriptions")
        .update(claim)
        .eq("device_token", token)
        .select("id");
      if (!raceErr && raced?.length) return { ok: true };
    }
    reportError("saveDeviceToken.insert", error, { background: !!opts?.background });
    return { ok: false, error: dbError(error) };
  }
  // THE SILENT-WRITE LAW: a refused write is a 200 with no rows.
  if (!rows?.length) {
    reportError("saveDeviceToken.insert", new Error("insert returned no row"), { background: !!opts?.background });
    return { ok: false, error: "Couldn't register this device for notifications." };
  }
  return { ok: true };
}

/**
 * A push failure that happens on the PHONE, not on the server — iOS refusing to register, a token
 * that never arrives — has no server call to fail and no screen to fail on when it happens in the
 * background. This is its only way into the ops log. Signed-in callers only, and both strings are
 * clamped: this writes an error_events row, so it must not become a place to dump text.
 */
export async function reportPushRegistrationFailure(stage: string, detail: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  reportError(`nativePush.${String(stage ?? "").slice(0, 40) || "unknown"}`, new Error(String(detail ?? "").slice(0, 300)), {
    profileId: user.id,
  });
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

/**
 * Unbind THIS phone on sign-out. Same delete as removeDeviceToken, but nobody is looking at the
 * screen while it runs — the app is on its way to /login — so a failure has to land in the ops log
 * instead of a toast that will never be painted. A phone that keeps its row keeps buzzing with the
 * previous person's customer names and dollar figures, which is the whole reason this exists.
 */
export async function releaseDeviceTokenOnSignOut(deviceToken: string) {
  const res = await removeDeviceToken(deviceToken);
  if (!res.ok) reportError("signOut.releaseDeviceToken", new Error(res.error ?? "device token not released"));
  return res;
}

/**
 * WHICH ALERTS EVEN APPLY TO ME. Settings renders the per-trigger toggles in a client component,
 * which has no role in hand, and a switch for an alert a role can never receive is a control that
 * does nothing: a tech turning "Invoices paid" on waits for a buzz that is only ever sent to
 * office staff. One read of the caller's OWN row, so it can't be used to ask about anyone else.
 */
export async function myNotificationRole(): Promise<{ ok: boolean; role?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const { data } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const role = (data as { role?: string | null } | null)?.role;
  return role ? { ok: true, role } : { ok: false };
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
