import { describe, it, expect } from "vitest";
import type Stripe from "stripe";
import { feeFromBalanceTransaction, feeFromPaymentIntent, processorFeeLabel } from "@/lib/processor-fee";

/**
 * Migration 0284: card fees are a business cost that comes off Erik's draw, so the real Stripe fee
 * is stored on each online payment. NULL means "not known yet" and the daily cron comes back for
 * it, so every unreadable shape must answer null, never a guessed number and never a silent 0.
 */
describe("feeFromBalanceTransaction: Stripe's cents to dollars, or nothing", () => {
  it("reads the fee in cents as dollars", () => {
    expect(feeFromBalanceTransaction({ fee: 18218, currency: "usd" })).toBe(182.18);
    expect(feeFromBalanceTransaction({ fee: 34, currency: "usd" })).toBe(0.34);
  });

  it("a zero fee is a real zero, not unknown", () => {
    expect(feeFromBalanceTransaction({ fee: 0, currency: "usd" })).toBe(0);
  });

  it("a pending balance transaction still has its fee (pending only means not paid out yet)", () => {
    const pending = { fee: 205, currency: "usd", status: "pending" };
    expect(feeFromBalanceTransaction(pending)).toBe(2.05);
  });

  it("no balance transaction yet is unknown", () => {
    expect(feeFromBalanceTransaction(null)).toBeNull();
    expect(feeFromBalanceTransaction(undefined)).toBeNull();
  });

  it("a bare id (the expand did not happen) is unknown, not zero", () => {
    expect(feeFromBalanceTransaction("txn_1Abc")).toBeNull();
  });

  it("a fee in another currency is never read as dollars", () => {
    expect(feeFromBalanceTransaction({ fee: 500, currency: "jpy" })).toBeNull();
    expect(feeFromBalanceTransaction({ fee: 500 })).toBeNull();
  });

  it("a missing, negative or non-numeric fee is unknown", () => {
    expect(feeFromBalanceTransaction({ currency: "usd" })).toBeNull();
    expect(feeFromBalanceTransaction({ fee: -30, currency: "usd" })).toBeNull();
    expect(feeFromBalanceTransaction({ fee: "30", currency: "usd" })).toBeNull();
    expect(feeFromBalanceTransaction({ fee: Number.NaN, currency: "usd" })).toBeNull();
  });

  it("accepts Stripe's own balance transaction type", () => {
    const bt = { id: "txn_1", object: "balance_transaction", fee: 1234, currency: "usd" } as Stripe.BalanceTransaction;
    expect(feeFromBalanceTransaction(bt)).toBe(12.34);
  });
});

describe("feeFromPaymentIntent: the fee on the charge that paid", () => {
  const bt = { fee: 18218, currency: "usd" };

  it("walks latest_charge to its expanded balance transaction", () => {
    expect(feeFromPaymentIntent({ latest_charge: { status: "succeeded", balance_transaction: bt } })).toBe(182.18);
  });

  it("a bank debit still settling (charge pending) is unknown, even if a fee is sitting there", () => {
    expect(feeFromPaymentIntent({ latest_charge: { status: "pending", balance_transaction: bt } })).toBeNull();
    expect(feeFromPaymentIntent({ latest_charge: { status: "pending", balance_transaction: null } })).toBeNull();
  });

  it("a failed charge has no fee to store", () => {
    expect(feeFromPaymentIntent({ latest_charge: { status: "failed", balance_transaction: null } })).toBeNull();
  });

  it("no charge, or an unexpanded one, is unknown", () => {
    expect(feeFromPaymentIntent(null)).toBeNull();
    expect(feeFromPaymentIntent({})).toBeNull();
    expect(feeFromPaymentIntent({ latest_charge: null })).toBeNull();
    expect(feeFromPaymentIntent({ latest_charge: "ch_1Abc" })).toBeNull();
    expect(feeFromPaymentIntent({ latest_charge: { status: "succeeded", balance_transaction: "txn_1Abc" } })).toBeNull();
  });

  it("accepts Stripe's own PaymentIntent type", () => {
    const pi = {
      id: "pi_1",
      latest_charge: { id: "ch_1", status: "succeeded", balance_transaction: { fee: 305, currency: "usd" } },
    } as unknown as Stripe.PaymentIntent;
    expect(feeFromPaymentIntent(pi)).toBe(3.05);
  });
});

describe("processorFeeLabel: the words on the staff payment row", () => {
  it("a card, and anything Stripe takes that is not a bank debit, is a card fee", () => {
    expect(processorFeeLabel("card")).toBe("Card fee");
    expect(processorFeeLabel(null)).toBe("Card fee");
    expect(processorFeeLabel("")).toBe("Card fee");
  });

  it("a bank debit is a bank fee", () => {
    expect(processorFeeLabel("ach")).toBe("Bank fee");
    expect(processorFeeLabel("ACH")).toBe("Bank fee");
    expect(processorFeeLabel("bank transfer")).toBe("Bank fee");
  });
});
