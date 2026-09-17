import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { rateLimited } from "@/lib/rate-limit";
import { getStripe, billingEnabled } from "@/lib/stripe";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/**
 * A STRIPE TERMINAL CONNECTION TOKEN, FOR THE PHONE IN THE TECH'S HAND (Tap to Pay on iPhone).
 *
 * The Terminal SDK inside the native shell never sees an API key. It authenticates to Stripe with
 * a short-lived, single-use connection token that a trusted server mints on its behalf — and
 * whoever holds that secret can connect a reader and take payments AS THAT STRIPE ACCOUNT. So this
 * is staff-only, behind the session cookie, with a per-person window. The plugin's own
 * `tokenProviderEndpoint` mode is a bare native URLSession POST that carries no cookies and no
 * auth, which is why the web side answers the SDK's `terminalRequestedConnectionToken` event by
 * calling THIS route itself and handing the secret back (src/lib/native-tap.ts).
 *
 * THE MONEY LAW (0161) HOLDS HERE OR NOWHERE. The token is minted ON THE CALLER'S OWN CONNECTED
 * ACCOUNT — `{ stripeAccount }` is the Stripe-Account header — because Stripe binds everything the
 * phone does next to it: "the client SDKs create the PaymentIntent on the same connected account
 * the ConnectionToken belongs to." A platform-account token would make the phone charge as
 * Contractor North, i.e. hold the tenant's customer's money. The account id is read off the
 * caller's own org row through their own session (RLS is the boundary), never from the request:
 * there is no way to ask for another org's token because there is no way to name one.
 */
/**
 * EVERY WAY THIS ROUTE ANSWERS WITHOUT A TOKEN, for the bridge that has to turn it into a fix
 * (native-tap.ts fetchToken keys on the status; `code` is the same fact in a word, for a reader):
 *   401 signed_out     no session cookie the server accepts (expired, revoked, a fresh WebView)
 *   403 not_staff      a technician's shell, or a deactivated seat
 *   400 no_org         the profile has no company
 *   429 rate_limited   more than thirty in a minute for this person
 *   503 not_configured no Stripe keys on this server
 *   500 read_failed    the org row couldn't be read
 *   400 not_enabled    Stripe not finished for this company (no account, or charges off)
 *   502 stripe_refused Stripe wouldn't mint the token (logged to error_events with the real text)
 * Every one is JSON with `error` as a plain sentence. Nothing here redirects: /api/stripe is a
 * PUBLIC_PATH in the middleware, so a signed-out phone gets the 401 above, never the login page.
 * `Cache-Control: no-store` on all of them — a token, or a refusal, is never something to keep.
 */
const NO_STORE = { "Cache-Control": "no-store" };

function refuse(code: string, error: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function POST() {
  const ctx = await requireStaff();
  if ("error" in ctx) {
    const why = ctx.error ?? "This action is staff-only.";
    return why === "Not signed in." ? refuse("signed_out", why, 401) : refuse("not_staff", why, 403);
  }
  if (!ctx.orgId) {
    return refuse("no_org", "Your account isn't attached to a company yet.", 400);
  }
  // The SDK asks for a fresh token per connect and again on every reconnect; thirty a minute is
  // more than a reader ever needs and less than a loop would want.
  if (await rateLimited(`terminal-token:${ctx.userId}`, 30, 60)) {
    return refuse("rate_limited", "Too many Tap to Pay on iPhone sessions in a row — give it a minute.", 429);
  }
  if (!billingEnabled) {
    return refuse("not_configured", "Card payments aren't set up on this server yet.", 503);
  }

  // Real columns only (the collectArtifacts lesson: a select naming a column that does not exist
  // reads as "not set up" to the caller for a reason that was never checked).
  const { data: org, error: orgErr } = await ctx.supabase
    .from("organizations")
    .select("stripe_account_id, stripe_account_status, stripe_charges_enabled")
    .eq("id", ctx.orgId)
    .maybeSingle();
  if (orgErr || !org) {
    return refuse("read_failed", orgErr ? dbError(orgErr) : "Couldn't read this company's payment setup.", 500);
  }
  const connect = connectStateFromOrg(org as never);
  // canAcceptPayments is the same gate the QR door and the public pay route use: an account exists
  // AND Stripe says it may charge. Terminal additionally needs the card_payments capability, which
  // is exactly what charges_enabled mirrors for an Express account.
  if (!canAcceptPayments(connect)) {
    return refuse(
      "not_enabled",
      "Card payments aren't switched on for this company yet. Finish Stripe setup in Settings → Payments first.",
      400,
    );
  }

  try {
    const token = await getStripe().terminal.connectionTokens.create(
      {},
      // THE line that keeps the phone charging as the tenant. No `location` param: Stripe scopes
      // connection tokens by location for internet readers only; Tap to Pay ignores it.
      { stripeAccount: connect.accountId! },
    );
    return NextResponse.json({ secret: token.secret }, { headers: NO_STORE });
  } catch (e) {
    // A Stripe-side refusal (key in the wrong mode, a capability that lapsed since account.updated
    // last spoke) goes to error_events with the real text; the phone gets a sentence it can show.
    reportError("stripe:terminal:token", e, { orgId: ctx.orgId });
    const said = e instanceof Error ? e.message : "";
    return refuse("stripe_refused", `Stripe wouldn't start a Tap to Pay on iPhone session${said ? ` — ${said}` : ""}.`, 502);
  }
}
