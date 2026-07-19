import { NextResponse } from "next/server";
import { authorizeUrl, qboConfigured } from "@/lib/quickbooks";
import { createClient } from "@/lib/supabase/server";
import { newOAuthState, setOAuthState } from "@/lib/oauth-state";
import { oauthRedirectBase } from "@/lib/oauth-base";

export const runtime = "nodejs";

/** Kick off the QuickBooks Online OAuth flow (owner/admin only). */
export async function GET(req: Request) {
  const site = process.env.NEXT_PUBLIC_SITE_URL || "";
  if (!qboConfigured()) {
    return new NextResponse(
      "QuickBooks isn't configured. Add QBO_CLIENT_ID and QBO_CLIENT_SECRET.",
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
  // host-only, so Intuit must return the user to the same host or the callback finds
  // neither. The callback derives the identical base for its state check + token exchange.
  const res = NextResponse.redirect(authorizeUrl(state, oauthRedirectBase(req)));
  setOAuthState(res, "quickbooks", state);
  return res;
}
