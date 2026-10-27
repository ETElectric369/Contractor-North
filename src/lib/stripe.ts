import "server-only";
import Stripe from "stripe";
import { reportError } from "@/lib/observe";

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
 * where the wall is decided (the app layout's gate), it files ONE row per server instance in the
 * error sink; dev and CI (no VERCEL_ENV) stay quiet. Never throws.
 */
export function stripeConfigAlarm(): void {
  if (alarmed || process.env.STRIPE_SECRET_KEY || process.env.VERCEL_ENV !== "production") return;
  alarmed = true;
  reportError("stripe:config", new Error("STRIPE_SECRET_KEY is missing: the paywall is off and card payments are down"));
}

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}
