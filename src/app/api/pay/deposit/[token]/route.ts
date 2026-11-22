import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ensureDepositRequestForQuoteToken } from "@/lib/payment-request";
import { payUrl } from "@/lib/org-settings";
import { rateLimited, clientIp } from "@/lib/rate-limit";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE CUSTOMER'S "PAY THE DEPOSIT" TAP, from the estimate's own link (cn-v1177).
 *   GET /api/pay/deposit/<quote_public_token>
 *
 * IT MAKES NOTHING ITSELF. The one function, ensureDepositRequestForQuoteToken (lib/payment-request),
 * finds the estimate's one live deposit request or makes it (one per estimate, held by a unique index
 * in the database, so a second tap, a double tap or a crawler hands back the same bill), and this door
 * only sends the browser on:
 *   a request still owed  → that bill's own card door (/api/pay/<invoice token>, the existing Checkout);
 *   a request already paid → that bill's page (/i/<invoice token>), which says so;
 *   any refusal (not accepted, no deposit stated, no job or customer yet, a failure) → back to the
 *   estimate with ?deposit=unavailable, where the page says one plain line and the company's phone.
 * Paying is never required to accept: this door is reached only after the yes.
 *
 * The redirects stay on the host the customer is on (the estimate's link is on the company's own
 * domain; the card door builds its own URLs from the company's settings from there). Never cached,
 * never indexed (robots.txt disallows /api/, and the header says it on the response too).
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } as const;

function go(req: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, req.url), { status: 303 });
  for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
  return res;
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const back = `/q/${encodeURIComponent(token)}?deposit=unavailable`;
  // The same limiter posture as the card door: a looped link must not mint Checkout sessions.
  if ((await rateLimited(`pay-deposit:${token}`, 10, 60)) || (await rateLimited(`pay-ip:${clientIp(req.headers)}`, 30, 60))) {
    return new NextResponse("Too many payment attempts in a row — give it a minute.", { status: 429, headers: HEADERS });
  }
  let door: Awaited<ReturnType<typeof ensureDepositRequestForQuoteToken>>;
  try {
    door = await ensureDepositRequestForQuoteToken(createServiceClient(), token);
  } catch (e) {
    reportError("payDeposit", e, {});
    return go(req, back);
  }
  if (!door.ok || !door.invoiceToken) return go(req, back);
  return go(req, door.paid ? `/i/${encodeURIComponent(door.invoiceToken)}` : payUrl(door.invoiceToken, "card"));
}
