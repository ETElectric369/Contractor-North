import { NextResponse } from "next/server";
import { authorizeUrl, qboConfigured } from "@/lib/quickbooks";
import { createClient } from "@/lib/supabase/server";

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

  return NextResponse.redirect(authorizeUrl("qbo"));
}
