/**
 * WHAT A TAP TO PAY PAYMENTINTENT'S STATUS MEANS — one reading, shared by the server action that asks
 * Stripe (billing/tap-actions tapPaymentIntentStatus) and its test.
 *
 * Rich Seiler, INV-083, 2026-09-29: the phone said "confirmed" and Stripe had charged nothing. The
 * plugin's confirmPaymentIntent resolves on any non-nil intent, whatever its status, so "resolved"
 * was read as "charged". The only word that means charged is `succeeded`. `processing` is Stripe
 * still at it. Everything else — `requires_payment_method` (never charged, or declined),
 * `requires_confirmation`, `requires_action`, `requires_capture` (never expected: the intent
 * captures automatically) and `canceled` — is "nothing was taken", with Stripe's own reason when it
 * gave one.
 */

export type TapPaymentStatus =
  /** Stripe took the money: `succeeded`. The webhook books it; the screen's watch sees it land. */
  | { ok: true; charged: true; amountReceived: number }
  /** Stripe has NOT taken the money. `waiting` = still might (`processing`); otherwise the card
   *  door is back where it started (`requires_payment_method`), or the intent is gone (`canceled`). */
  | { ok: true; charged: false; status: string; waiting: boolean; reason: string | null }
  | { ok: false; error: string };

export type TapIntentLike = {
  status: string;
  amount_received?: number | null;
  last_payment_error?: { message?: string | null; decline_code?: string | null; code?: string | null } | null;
};

export function tapIntentStatusOf(pi: TapIntentLike): Extract<TapPaymentStatus, { ok: true }> {
  if (pi.status === "succeeded") return { ok: true, charged: true, amountReceived: (pi.amount_received ?? 0) / 100 };
  const err = pi.last_payment_error;
  const reason = err?.decline_code
    ? `declined (${String(err.decline_code).replace(/_/g, " ")})`
    : err?.message
      ? String(err.message)
      : null;
  return { ok: true, charged: false, status: pi.status, waiting: pi.status === "processing", reason };
}

/**
 * The sentence for a tap the phone called confirmed and Stripe says it never took. Plain words, the
 * figure, and the two doors that work: the tap again (a fresh PaymentIntent) or the link.
 */
export function notChargedSentence(amountDollars: number, status: string, reason: string | null): string {
  const money = `$${amountDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const why = reason ? ` Stripe says: ${reason}.` : status === "canceled" ? " Stripe says the payment was cancelled." : "";
  return `The phone said the card was approved, but Stripe did not take the ${money} — nothing was charged.${why} Press Tap to Pay again, or send them the link.`;
}
