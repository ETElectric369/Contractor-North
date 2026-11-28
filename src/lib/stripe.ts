import "server-only";
import Stripe from "stripe";
import { reportBlocker } from "@/lib/observe-blocker";

/** True when Stripe is configured. When false, the app skips all billing gates
 *  so it stays fully usable without Stripe set up.
 *
 *  ONE SWITCH, TWO MEANINGS (the 2026-10-26 review's integrations-01): this is both the paywall
 *  switch and the card-payments switch. An explicit paywall setting apart from the key is an
 *  LLC-time decision; until then its ABSENCE in production is said out loud (stripeConfigAlarm),
 *  never silent. */
export const billingEnabled = Boolean(process.env.STRIPE_SECRET_KEY);

export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";

/**
 * Test keys → Stripe's SIMULATED Tap to Pay reader (works in the Simulator, needs no Apple
 * entitlement); live keys → the real one. The plugin's native default is `isTest: true`, which
 * would silently simulate in production, so the bridge always passes it explicitly from THIS
 * fact rather than trusting a default. Read from the key, not a flag, because a flag drifts.
 * (Lived in the Tap to Pay actions until cn-v1129; the keys-health door reads the same fact.)
 */
export function stripeLivemode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return !!key && !/^(sk|rk)_test_/.test(key);
}

let alarmed = false;
/**
 * THE PAYWALL IS OFF AND NOBODY SAID SO (cn-v1129): an empty STRIPE_SECRET_KEY in production
 * lets every lapsed company in free and turns card payments off, with no word anywhere. Called
 * where the wall is decided (the app layout's gate), it files ONE blocker row per server instance
 * in the error sink; dev and CI (no VERCEL_ENV) stay quiet. Never throws.
 */
export function stripeConfigAlarm(): void {
  if (alarmed || process.env.STRIPE_SECRET_KEY || process.env.VERCEL_ENV !== "production") return;
  alarmed = true;
  // A blocker (cn-v1136): platform-wide, so the first row pages North's own team.
  reportBlocker("stripe:config", new Error("STRIPE_SECRET_KEY is missing: the paywall is off and card payments are down"));
}

/**
 * THE API VERSION IS NAMED HERE, ONCE (cn-v1194). Until this release the client was built with the key
 * alone, so it spoke whatever version the installed SDK happened to be built for, and an SDK upgrade
 * would have moved every call in the app to a newer Stripe API without one line of this app changing.
 * The string below is the one the SDK of that day (17.7) was already using, so naming it changed nothing.
 * It moves by hand and on purpose: read Stripe's changelog between the two versions first.
 * NOT governed by this: webhook events, which arrive in the version set on each webhook endpoint in the
 * Stripe dashboard, and the card reader plugin, which carries its own SDK.
 *
 * THE SDK IS NEWER THAN THE VERSION THE APP SPEAKS (cn-v1210). The installed SDK (23.1) is built for a
 * later API and its types describe only that one; the app still speaks the version named here, and
 * Stripe serves the version a request names. So three things are passed past the SDK's types, each
 * with a note beside it: the name itself, where the client is built below, and the parameter
 * `payment_method_types` on the two calls that pin one way to pay (the pay link's checkout and the
 * Tap to Pay payment). The later API no longer takes that parameter and answers 400 to it, so the day
 * this version moves to 2026-09-30 or later those two calls are rewritten first.
 * tests/stripe-wire.test.ts holds what the SDK puts on the wire for a table that mirrors every call
 * site in the app, against a recording from the SDK that was replaced.
 */
export const STRIPE_API_VERSION = "2025-02-24.acacia";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  if (!_stripe) {
    // The SDK's type for this option is the one version it was built for; the app names its own.
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION as string as Stripe.LatestApiVersion });
  }
  return _stripe;
}
