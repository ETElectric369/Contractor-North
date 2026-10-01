import type Stripe from "stripe";

/**
 * WHY THE CARD SAID NO, IN WORDS A TECH CAN REPEAT TO A CUSTOMER (Apple 5.12 push body; the
 * "Not charged — try again" box on the Pay Now sheet).
 *
 * decline_code is the issuer's reason and the most useful thing Stripe hands back; `message` is
 * Stripe's cardholder-facing sentence ("Your card was declined.") — written to the CUSTOMER, so it
 * reads wrong in a notification to the tech and is the fallback, not the lead. The map covers the
 * codes a driveway actually sees; anything else falls through to the code with its underscores
 * turned into spaces, which is still a plain phrase and never a blank.
 *
 * Lived inside the webhook until 2026-09-30, when the Pay Now sheet started reading a
 * PaymentIntent's last_payment_error straight off Stripe (tapPaymentOutcome): one map, so the
 * push and the sheet say the same thing about the same decline.
 */
export function declineReason(err: Stripe.PaymentIntent.LastPaymentError | null | undefined): string {
  const code = err?.decline_code ?? "";
  const WORDS: Record<string, string> = {
    insufficient_funds: "the card has insufficient funds",
    generic_decline: "the bank declined it without a reason",
    do_not_honor: "the bank declined it (do not honor)",
    expired_card: "the card is expired",
    lost_card: "the card was reported lost",
    stolen_card: "the card was reported stolen",
    incorrect_pin: "the PIN was wrong",
    pin_try_exceeded: "too many wrong PIN tries",
    offline_pin_required: "the card wants a PIN entered",
    online_or_offline_pin_required: "the card wants a PIN entered",
    call_issuer: "the bank wants the cardholder to call them",
    card_velocity_exceeded: "the card hit its spending limit",
    withdrawal_count_limit_exceeded: "the card hit its daily limit",
    transaction_not_allowed: "the card doesn't allow this kind of charge",
    card_not_supported: "the card doesn't support this kind of charge",
    currency_not_supported: "the card doesn't take US dollars",
    fraudulent: "the bank flagged it as suspected fraud",
    merchant_blacklist: "the bank blocks this business",
    restricted_card: "the card is restricted",
    revocation_of_all_authorizations: "the cardholder revoked charges from this business",
    security_violation: "the bank flagged a security problem",
    service_not_allowed: "the bank doesn't allow this charge",
    stop_payment_order: "the cardholder placed a stop on it",
    try_again_later: "the bank said try again later",
    processing_error: "a processing error at the bank",
    reenter_transaction: "the bank asked for the card to be tapped again",
    testmode_decline: "test-mode decline",
  };
  if (code && WORDS[code]) return WORDS[code];
  if (code) return code.replace(/_/g, " ");
  if (err?.message) return err.message.replace(/\.$/, "");
  if (err?.code) return String(err.code).replace(/_/g, " ");
  return "the card was declined";
}

/**
 * A PaymentIntent's last error as a plain phrase, or null when Stripe recorded none. The sheet
 * appends it after "Stripe shows no charge": ": the card has insufficient funds". Never a raw code.
 */
export function lastErrorWords(err: Stripe.PaymentIntent.LastPaymentError | null | undefined): string | null {
  if (!err) return null;
  return declineReason(err);
}
