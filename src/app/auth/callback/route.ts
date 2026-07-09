import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Handles the email-confirmation / magic-link redirect from Supabase.
 * Exchanges the `code` for a session, then sends the user to the app.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/planner";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
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

  return NextResponse.redirect(`${origin}/login?error=Could not sign you in`);
}
