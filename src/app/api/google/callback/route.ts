import { NextResponse } from "next/server";
import { isStaffRole } from "@/lib/actions/perms";
import { gcalExchangeCode } from "@/lib/google-calendar";
import { createClient } from "@/lib/supabase/server";
import { verifyOAuthState } from "@/lib/oauth-state";

export const runtime = "nodejs";

/** OAuth redirect target: exchange the code and store the org's connection. */
export async function GET(req: Request) {
  const site = process.env.NEXT_PUBLIC_SITE_URL || "";
  const { searchParams } = new URL(req.url);
  // CSRF: the returned state must match the cookie set at connect-time, or this
  // callback is a forged/injected code (binding an attacker's account to the org).
  const fail = NextResponse.redirect(`${site}/settings?gcal=denied`);
  if (!(await verifyOAuthState(fail, "google", searchParams.get("state")))) return fail;
  const code = searchParams.get("code");
  if (!code) return NextResponse.redirect(`${site}/settings?gcal=error`);

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
  if (!profile?.org_id || !isStaffRole(profile.role)) {
    return NextResponse.redirect(`${site}/settings?gcal=denied`);
  }

  try {
    const t = await gcalExchangeCode(code);
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
    return NextResponse.redirect(`${site}/settings?gcal=connected`);
  } catch {
    return NextResponse.redirect(`${site}/settings?gcal=error`);
  }
}
