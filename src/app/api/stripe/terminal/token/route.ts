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
export async function POST() {
  const ctx = await requireStaff();
  if ("error" in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.error === "Not signed in." ? 401 : 403 });
  }
  if (!ctx.orgId) {
    return NextResponse.json({ error: "Your account isn't attached to a company yet." }, { status: 400 });
  }
  // The SDK asks for a fresh token per connect and again on every reconnect; thirty a minute is
  // more than a reader ever needs and less than a loop would want.
  if (await rateLimited(`terminal-token:${ctx.userId}`, 30, 60)) {
    return NextResponse.json({ error: "Too many Tap to Pay sessions in a row — give it a minute." }, { status: 429 });
  }
  if (!billingEnabled) {
    return NextResponse.json({ error: "Card payments aren't set up on this server yet." }, { status: 503 });
  }

  // Real columns only (the collectArtifacts lesson: a select naming a column that does not exist
  // reads as "not set up" to the caller for a reason that was never checked).
  const { data: org, error: orgErr } = await ctx.supabase
    .from("organizations")
    .select("stripe_account_id, stripe_account_status, stripe_charges_enabled")
    .eq("id", ctx.orgId)
    .maybeSingle();
  if (orgErr || !org) {
    return NextResponse.json(
      { error: orgErr ? dbError(orgErr) : "Couldn't read this company's payment setup." },
      { status: 500 },
    );
  }
  const connect = connectStateFromOrg(org as never);
  // canAcceptPayments is the same gate the QR door and the public pay route use: an account exists
  // AND Stripe says it may charge. Terminal additionally needs the card_payments capability, which
  // is exactly what charges_enabled mirrors for an Express account.
  if (!canAcceptPayments(connect)) {
    return NextResponse.json(
      { error: "Card payments aren't switched on for this company yet. Finish Stripe setup in Settings → Payments first." },
      { status: 400 },
    );
  }

  try {
    const token = await getStripe().terminal.connectionTokens.create(
      {},
      // THE line that keeps the phone charging as the tenant. No `location` param: Stripe scopes
      // connection tokens by location for internet readers only; Tap to Pay ignores it.
      { stripeAccount: connect.accountId! },
    );
    return NextResponse.json({ secret: token.secret }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // A Stripe-side refusal (key in the wrong mode, a capability that lapsed since account.updated
    // last spoke) goes to error_events with the real text; the phone gets a sentence it can show.
    reportError("stripe:terminal:token", e, { orgId: ctx.orgId });
    const said = e instanceof Error ? e.message : "";
    return NextResponse.json(
      { error: `Stripe wouldn't start a Tap to Pay session${said ? ` — ${said}` : ""}.` },
      { status: 502 },
    );
  }
}
