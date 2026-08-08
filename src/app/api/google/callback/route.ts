import { NextResponse } from "next/server";
import { isStaffRole } from "@/lib/actions/perms";
import { gcalExchangeCode } from "@/lib/google-calendar";
import { createClient } from "@/lib/supabase/server";
import { verifyOAuthState } from "@/lib/oauth-state";
import { oauthRedirectBase } from "@/lib/oauth-base";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/** OAuth redirect target: exchange the code and store the org's connection. */
export async function GET(req: Request) {
  // LAND THEM BACK ON THE HOST THEY STARTED FROM, not on NEXT_PUBLIC_SITE_URL.
  //
  // The connect route sends Google the REQUEST'S OWN ORIGIN, and this route already derives the
  // same value for the token exchange (it must — the exchange has to repeat the exact authorized
  // redirect_uri). But every user-facing redirect here was built on NEXT_PUBLIC_SITE_URL, which is
  // one fixed host. Whenever that isn't the host the user connected from, the round trip ends on a
  // host where the session cookie — host-only, by design — does not exist: the user lands on a
  // signed-out settings page, or a login screen, after a connect that actually SUCCEEDED. That is
  // the precise dead-end oauth-base.ts documents from the app.contractornorth.com cutover, and it
  // was still live in this file. One source for the base now, used for every branch.
  const site = oauthRedirectBase(req);
  const { searchParams } = new URL(req.url);

  // WHY EACH FAILURE GETS ITS OWN CODE. Every branch below used to land on `denied` or `error`, and
  // the settings card rendered both as "Could not connect — try again." Andrew (Vivian Builders)
  // reported he couldn't connect and there was nothing — for him or for us — that said which of
  // four unrelated causes he hit. Worse, "try again" is actively wrong advice for a redirect-URI
  // mismatch or a Google app that hasn't been granted his account: retrying can never fix either.
  const back = (reason: string) => NextResponse.redirect(`${site}/settings?gcal=${reason}`);

  // The user pressed Cancel on Google's consent screen — not an error, and it says so.
  const googleError = searchParams.get("error");
  if (googleError) return back(googleError === "access_denied" ? "cancelled" : "refused");

  // CSRF: the returned state must match the cookie set at connect-time, or this
  // callback is a forged/injected code (binding an attacker's account to the org).
  const fail = back("state");
  if (!(await verifyOAuthState(fail, "google", searchParams.get("state")))) return fail;
  const code = searchParams.get("code");
  if (!code) return back("nocode");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${site}/login`);

  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.org_id || !isStaffRole(profile.role)) return back("notstaff");

  try {
    // Same per-request base the connect route sent to Google — the token exchange
    // must repeat the exact redirect_uri that was authorized.
    const t = await gcalExchangeCode(code, oauthRedirectBase(req));
    // RLS-friendly upsert: the signed-in staff member owns this org row.
    const { error } = await supabase.from("calendar_connections").upsert(
      {
        org_id: profile.org_id,
        provider: "google",
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? null,
        expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
        connected_by: user.id,
        connected_at: new Date().toISOString(),
        // A (re)connect clears the dead-grant "reauth" marker AND the old
        // per-calendar sync tokens — the next sweep re-baselines each mirror
        // in full, which is exactly right after a broken spell. Calendar
        // picks (selected_calendars) are untouched and survive the reconnect.
        sync_tokens: {},
      },
      { onConflict: "org_id,provider" },
    );
    if (error) throw error;
    return back("connected");
  } catch (e) {
    // LOG IT. A failed OAuth exchange is the one failure a user genuinely cannot diagnose and we
    // genuinely can — the reason Google gives (redirect_uri_mismatch, invalid_client, access
    // blocked for an unverified app) is in this error and nowhere else.
    reportError("google calendar connect", e, { org: profile.org_id });
    return back("exchange");
  }
}
