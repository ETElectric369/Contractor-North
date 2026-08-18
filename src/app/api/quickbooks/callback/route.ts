import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/quickbooks";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { verifyOAuthState } from "@/lib/oauth-state";
import { oauthRedirectBase } from "@/lib/oauth-base";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/** OAuth redirect target: exchange the code and store the org's connection. */
export async function GET(req: Request) {
  // The REQUEST's host, not a build-time env (audit 9) — the same dead-end its Google twin was
  // fixed for at the app.contractornorth.com cutover: an org connecting from the canonical host
  // was bounced to whatever NEXT_PUBLIC_SITE_URL was baked in, landing signed-out on a stranger
  // of a domain with the connection half-made.
  const site = oauthRedirectBase(req);
  const { searchParams } = new URL(req.url);
  // CSRF: the returned state must match the cookie set at connect-time, or this is a
  // forged code (binding an attacker's QuickBooks realm to the signed-in user's org).
  const fail = NextResponse.redirect(`${site}/settings?tab=integrations&qbo=denied`);
  if (!(await verifyOAuthState(fail, "quickbooks", searchParams.get("state")))) return fail;
  const code = searchParams.get("code");
  const realmId = searchParams.get("realmId");
  if (!code || !realmId) {
    return NextResponse.redirect(`${site}/settings?tab=integrations&qbo=error`);
  }

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
  if (!profile?.org_id || !["owner", "admin"].includes(profile.role)) {
    return NextResponse.redirect(`${site}/settings?tab=integrations&qbo=denied`);
  }

  try {
    // Same per-request base the connect route sent to Intuit — the token exchange
    // must repeat the exact redirect_uri that was authorized.
    const t = await exchangeCode(code, oauthRedirectBase(req));
    const svc = createServiceClient();
    // VERIFY THE WRITE BEFORE CLAIMING THE CONNECTION (audit 9). This was fire-and-forget: any
    // failure — a constraint, a migration not run in that environment, a PostgREST timeout —
    // left no row while the user was shown the green "Connected to QuickBooks Online", and
    // every later push answered "Connect QuickBooks first". Silent-write law, on the one screen
    // where the person cannot possibly diagnose it.
    const { data: saved, error: upErr } = await svc
      .from("accounting_connections")
      .upsert({
        org_id: profile.org_id,
        provider: "quickbooks",
        realm_id: realmId,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
        connected_at: new Date().toISOString(),
      })
      .select("org_id");
    if (upErr || !saved?.length) {
      reportError("quickbooks:callback:save", upErr ?? new Error("connection row not written"), {
        orgId: profile.org_id,
      });
      return NextResponse.redirect(`${site}/settings?tab=integrations&qbo=error`);
    }
    return NextResponse.redirect(`${site}/settings?tab=integrations&qbo=connected`);
  } catch (e) {
    // The ONE error the person can't see and we can (audit 9): a redirect_uri_mismatch from
    // Intuit looked identical to every other failure, and the bare catch threw the reason away.
    reportError("quickbooks:callback:exchange", e, { orgId: profile.org_id });
    return NextResponse.redirect(`${site}/settings?tab=integrations&qbo=error`);
  }
}
