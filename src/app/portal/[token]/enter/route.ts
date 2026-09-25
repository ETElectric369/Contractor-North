import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { hashSecret, isSessionSecret, newSessionSecret } from "@/lib/portal/code";
import { PORTAL_OFFICE_COOKIE, PORTAL_OFFICE_COOKIE_SECONDS, isPortalToken, portalCookieOptions } from "@/lib/portal/session-cookie";

/**
 * THE OFFICE'S SEE WHAT THEY SEE, ON THE CUSTOMER'S HOST (0331).
 *
 * The customer's page lives on the business's own domain (etelectricity.com/portal/<token>), where
 * the office's app sign-in doesn't reach, and the office must never need the customer's code. So
 * the office's button asks the app (signed in, staff, same org) for a one-use ticket good for two
 * minutes (portal_preview_ticket), and opens /portal/<token>/enter?t=<ticket>. Here the ticket is
 * traded for an 8-hour OFFICE session on this link only (portal_preview_redeem), and the browser
 * goes on to the page. The ticket is spent on first use, so the URL in the office's history opens
 * nothing later; an office session never stamps Last Opened and is never counted as a device.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function expired(): NextResponse {
  return new NextResponse(
    `<!doctype html><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Look expired</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 16px;color:#0f172a">` +
      `<p style="font-size:16px">This look at the customer's page has expired or was already used.</p>` +
      `<p style="font-size:14px;color:#475569">Go back to the app and tap See What They See again.</p></body>`,
    { status: 410, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ticket = request.nextUrl.searchParams.get("t") ?? "";
  const job = request.nextUrl.searchParams.get("job") ?? "";
  if (!isPortalToken(token) || !isSessionSecret(ticket)) return expired();

  const secret = newSessionSecret();
  const { data, error } = await createServiceClient().rpc("portal_preview_redeem", {
    p_token: token,
    p_ticket_hash: hashSecret(ticket),
    p_session_hash: hashSecret(secret),
  });
  if (error) {
    reportError("portal.previewRedeem", error);
    return expired();
  }
  if (data !== true) return expired();

  // Same host the ticket came in on (the business's own domain), the ticket itself left behind.
  const dest = request.nextUrl.clone();
  dest.pathname = `/portal/${token}${UUID.test(job) ? `/jobs/${job.toLowerCase()}` : ""}`;
  dest.search = "";
  dest.searchParams.set("look", "office");
  const res = NextResponse.redirect(dest, 303);
  // Its own cookie, which middleware never slides (the session behind it ends at 8 hours).
  res.cookies.set(PORTAL_OFFICE_COOKIE, secret, portalCookieOptions(token, PORTAL_OFFICE_COOKIE_SECONDS));
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}
