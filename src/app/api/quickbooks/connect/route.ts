import { NextResponse } from "next/server";
import { authorizeUrl, qboConfigured } from "@/lib/quickbooks";
import { createClient } from "@/lib/supabase/server";
import { newOAuthState, setOAuthState } from "@/lib/oauth-state";

export const runtime = "nodejs";

/** Kick off the QuickBooks Online OAuth flow (owner/admin only). */
export async function GET() {
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
  const res = NextResponse.redirect(authorizeUrl(state));
  setOAuthState(res, "quickbooks", state);
  return res;
}
