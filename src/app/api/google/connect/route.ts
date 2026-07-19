import { NextResponse } from "next/server";
import { gcalAuthorizeUrl, gcalConfigured } from "@/lib/google-calendar";
import { createClient } from "@/lib/supabase/server";
import { newOAuthState, setOAuthState } from "@/lib/oauth-state";
import { oauthRedirectBase } from "@/lib/oauth-base";

export const runtime = "nodejs";

/** Kick off the Google Calendar OAuth flow (staff only). */
export async function GET(req: Request) {
  const site = process.env.NEXT_PUBLIC_SITE_URL || "";
  if (!gcalConfigured()) {
    return new NextResponse(
      "Google Calendar isn't configured. Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
      { status: 503 },
    );
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${site}/login`);

  const state = newOAuthState();
  // Redirect base = THIS request's origin (app host): the session + state cookies are
  // host-only, so Google must return the user to the same host or the callback finds
  // neither. The callback derives the identical base for its state check + token exchange.
  const res = NextResponse.redirect(gcalAuthorizeUrl(state, oauthRedirectBase(req)));
  setOAuthState(res, "google", state);
  return res;
}
