import "server-only";
import Stripe from "stripe";

/** True when Stripe is configured. When false, the app skips all billing gates
 *  so it stays fully usable without Stripe set up. */
export const billingEnabled = Boolean(process.env.STRIPE_SECRET_KEY);

export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";

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
