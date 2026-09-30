import { describe, expect, it } from "vitest";
import { notChargedSentence, tapIntentStatusOf } from "@/lib/tap-intent-status";

/**
 * RICH SEILER, INV-083, 2026-09-29. The Tap to Pay screen said "Stripe confirmed the charge" at
 * 12:41 PM and Stripe had charged nothing; Rich paid the $420 by the link at 1:40 PM. The phone's
 * confirm resolving was the only evidence. These pin the one reading of Stripe's own word.
 */
describe("what a Tap to Pay PaymentIntent's status means", () => {
  it("succeeded is the only word that means charged, with the figure Stripe took", () => {
    expect(tapIntentStatusOf({ status: "succeeded", amount_received: 42000 })).toEqual({ ok: true, charged: true, amountReceived: 420 });
  });

  it("processing is Stripe still at it: not charged, still waiting", () => {
    expect(tapIntentStatusOf({ status: "processing" })).toEqual({ ok: true, charged: false, status: "processing", waiting: true, reason: null });
  });

  it("requires_payment_method after a confirm is nothing taken — INV-083's shape — with Stripe's reason when it gave one", () => {
    expect(tapIntentStatusOf({ status: "requires_payment_method", last_payment_error: null })).toEqual({
      ok: true,
      charged: false,
      status: "requires_payment_method",
      waiting: false,
      reason: null,
    });
    expect(
      tapIntentStatusOf({ status: "requires_payment_method", last_payment_error: { decline_code: "insufficient_funds", message: "Your card has insufficient funds." } }),
    ).toMatchObject({ charged: false, waiting: false, reason: "declined (insufficient funds)" });
    expect(tapIntentStatusOf({ status: "canceled", last_payment_error: { message: "The payment was cancelled." } })).toMatchObject({
      charged: false,
      waiting: false,
      reason: "The payment was cancelled.",
    });
  });

  it("requires_capture and requires_action are not charged either: the intent captures automatically, so neither is expected", () => {
    for (const status of ["requires_capture", "requires_action", "requires_confirmation"]) {
      expect(tapIntentStatusOf({ status })).toMatchObject({ charged: false, waiting: false, status });
    }
  });
});

describe("the sentence for a confirm Stripe never took", () => {
  it("says the figure, that nothing was charged, Stripe's reason, and the two doors that work", () => {
    expect(notChargedSentence(420, "requires_payment_method", null)).toBe(
      "The phone said the card was approved, but Stripe did not take the $420.00 — nothing was charged. Press Tap to Pay again, or send them the link.",
    );
    expect(notChargedSentence(420, "requires_payment_method", "declined (insufficient funds)")).toContain("Stripe says: declined (insufficient funds).");
    expect(notChargedSentence(1.23, "canceled", null)).toContain("Stripe says the payment was cancelled.");
  });
});
