import { NextResponse } from "next/server";
import { gcalAuthorizeUrl, gcalConfigured } from "@/lib/google-calendar";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Kick off the Google Calendar OAuth flow (staff only). */
export async function GET() {
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

  return NextResponse.redirect(gcalAuthorizeUrl());
}
