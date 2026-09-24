/**
 * WHAT STRIPE TOOK FOR A PAYMENT, IN DOLLARS: the pure half of migration 0284.
 *
 * Erik absorbs card fees as a business cost that comes off his draw, so the app has to know the
 * real fee, not an estimate at 2.9% + 30 cents. The real figure lives in exactly one place: the
 * `fee` on the charge's balance transaction, in cents, on the contractor's connected account. With
 * a Connect direct charge and no application fee (stripe-connect.ts), that whole fee is what the
 * contractor paid to be paid.
 *
 * Everything here answers null rather than guess. NULL on payments.processor_fee means "not known
 * yet", and the daily cron comes back for it; a wrong number stored now would never be looked at
 * again. So a charge that has not succeeded, a balance transaction Stripe has not created yet (a
 * bank debit still settling), one that came back unexpanded (a bare id), or one in a currency that
 * is not dollars all give null. A fee of 0 is a real zero and comes back as 0.
 */

/** The parts of a Stripe balance transaction this reads. Stripe's own type fits it. */
export type BalanceTransactionLike = {
  fee?: unknown;
  currency?: unknown;
};

/** The parts of a Stripe charge this reads. */
export type ChargeLike = {
  status?: unknown;
  balance_transaction?: string | BalanceTransactionLike | null;
};

/** The parts of a Stripe PaymentIntent this reads (retrieved with latest_charge.balance_transaction expanded). */
export type PaymentIntentLike = {
  latest_charge?: string | ChargeLike | null;
};

/**
 * Dollars from a balance transaction's fee, or null when it cannot be read.
 *
 * A PENDING balance transaction still counts: its status only says the money is not yet available
 * to pay out, and the fee is fixed the moment Stripe creates it.
 */
export function feeFromBalanceTransaction(bt: string | BalanceTransactionLike | null | undefined): number | null {
  // A bare id means the expand did not happen; there is nothing to read, and guessing is worse.
  if (!bt || typeof bt !== "object") return null;
  // Stripe's `fee` is in the currency's smallest unit. Every North org charges in dollars; a fee
  // in anything else divided by 100 would be a made-up dollar figure.
  if (String(bt.currency ?? "").toLowerCase() !== "usd") return null;
  const cents = bt.fee;
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) return null;
  return Math.round(cents) / 100;
}

/**
 * Dollars Stripe took for a PaymentIntent's charge, or null when that is not known yet.
 *
 * Only a SUCCEEDED charge has a fee worth storing. A bank debit's charge sits pending for days and
 * can still fail; the payment row is only written once it succeeds, so a pending one here means
 * "come back later", never "free".
 */
export function feeFromPaymentIntent(pi: PaymentIntentLike | null | undefined): number | null {
  const charge = pi?.latest_charge;
  if (!charge || typeof charge !== "object") return null;
  if (charge.status !== undefined && charge.status !== "succeeded") return null;
  return feeFromBalanceTransaction(charge.balance_transaction);
}

/**
 * The words on the staff invoice's payment row. A bank debit's fee is a bank fee, and calling it a
 * card fee would send Erik looking for a card that was never used. Everything else Stripe takes
 * today (a Checkout card, Apple Pay inside it, Tap to Pay) is a card.
 */
export function processorFeeLabel(method: string | null | undefined): "Card fee" | "Bank fee" {
  // Split on anything that isn't a letter: "\b" never fires beside "_", so Stripe's own
  // "us_bank_account" (and "bank_transfer") would have read as a card fee.
  const words = String(method ?? "").toLowerCase().split(/[^a-z]+/);
  return words.some((w) => w === "ach" || w === "bank" || w === "transfer") ? "Bank fee" : "Card fee";
}
