import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-next";
import { endSessionIfDeactivated, DEACTIVATED_MESSAGE } from "@/lib/deactivation-gate";

/**
 * Handles the email-confirmation / magic-link redirect from Supabase.
 * Exchanges the `code` for a session, then sends the user to the app.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Same-app relative paths only — an absolute ?next= on the magic-link callback was an open redirect.
  const next = safeNextPath(searchParams.get("next")) ?? "/planner";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // A deactivated account must not get a session at all — the same rule the password form and
      // the 6-digit code enforce (audit v921 high: this door skipped it, so a cut employee could
      // request a login link, open it, and hold a live refreshable session).
      if (await endSessionIfDeactivated(supabase)) {
        return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(DEACTIVATED_MESSAGE)}`);
      }
      // An external site collaborator (no org membership, only a content grant) belongs on the
      // /content workspace, never the app — route them there before the (app) shell bounces a
      // no-org user to /onboarding.
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: me } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
        if (!me?.org_id) {
          await supabase.rpc("claim_site_collaborations");
          const { data: g } = await supabase.from("site_collaborators").select("org_id").eq("user_id", user.id).limit(1);
          if (g?.length) return NextResponse.redirect(`${origin}/content`);
        }
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // WHY THIS FAILS, SAID PLAINLY (audit v921 high): the exchange needs the PKCE verifier cookie
  // that was written where the link was REQUESTED. Ask from the native shell or the installed
  // PWA and the emailed link opens in Safari — a different cookie jar — so the exchange fails and
  // "Could not sign you in" was a dead end with no way forward. Name the cause and the way out.
  const why =
    "That link was opened somewhere else than where you asked for it, so we couldn't finish signing you in. " +
    "Sign in with a code instead — no password needed.";
  return NextResponse.redirect(`${origin}/login?mode=code&error=${encodeURIComponent(why)}`);
}
