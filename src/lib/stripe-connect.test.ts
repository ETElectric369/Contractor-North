import { describe, expect, it } from "vitest";
import {
  connectStateFromOrg,
  canAcceptPayments,
  connectStatusLabel,
  accountUpdateFields,
} from "./stripe-connect";

/**
 * The invariant these guard: a contractor's customers' money goes to the CONTRACTOR.
 * The pay route refuses unless canAcceptPayments() is true, so anything that makes it
 * wrongly true is money landing in the platform's balance — or a customer sent to a
 * checkout that fails.
 */
describe("canAcceptPayments — the gate on the pay route", () => {
  it("needs BOTH an account and Stripe's charges_enabled", () => {
    expect(canAcceptPayments({ accountId: "acct_1", status: "active", chargesEnabled: true })).toBe(true);
  });

  it("refuses an account that is still onboarding", () => {
    // The account exists but Stripe hasn't cleared it — sending a customer to that
    // checkout produces a failure with the contractor's name on it.
    expect(canAcceptPayments({ accountId: "acct_1", status: "pending", chargesEnabled: false })).toBe(false);
  });

  it("refuses when there is no connected account at all", () => {
    // THE important case: without this the charge would fall back to the platform
    // account and the contractor's money would land in ours.
    expect(canAcceptPayments({ accountId: null, status: "none", chargesEnabled: false })).toBe(false);
  });

  it("refuses a restricted account even if it once charged", () => {
    expect(canAcceptPayments({ accountId: "acct_1", status: "restricted", chargesEnabled: false })).toBe(false);
  });
});

describe("connectStateFromOrg", () => {
  it("treats missing columns as not-connected rather than throwing", () => {
    expect(connectStateFromOrg({})).toEqual({ accountId: null, status: "none", chargesEnabled: false });
  });

  it("never reports chargesEnabled from a null column", () => {
    const s = connectStateFromOrg({ stripe_account_id: "acct_1", stripe_charges_enabled: null });
    expect(s.chargesEnabled).toBe(false);
    expect(canAcceptPayments(s)).toBe(false);
  });
});

describe("accountUpdateFields — mirroring Stripe onto our columns", () => {
  const acct = (o: Record<string, unknown>) => o as never;

  it("charges_enabled true → active and chargeable", () => {
    expect(accountUpdateFields(acct({ charges_enabled: true, requirements: {} }))).toEqual({
      stripe_account_status: "active",
      stripe_charges_enabled: true,
    });
  });

  it("outstanding requirements → pending, not chargeable", () => {
    expect(
      accountUpdateFields(acct({ charges_enabled: false, requirements: { currently_due: ["individual.id_number"] } })),
    ).toEqual({ stripe_account_status: "pending", stripe_charges_enabled: false });
  });

  it("a disabled account with nothing left to do is restricted", () => {
    expect(
      accountUpdateFields(acct({ charges_enabled: false, requirements: { currently_due: [], disabled_reason: "rejected.fraud" } })),
    ).toEqual({ stripe_account_status: "restricted", stripe_charges_enabled: false });
  });

  it("a BRAND-NEW account is pending, not restricted — verified against a real sandbox account", () => {
    // Stripe sets currently_due AND disabled_reason on a fresh Express account
    // (observed: currently_due=12). Calling that "restricted" tells a contractor
    // who just signed up that they were rejected.
    expect(
      accountUpdateFields(
        acct({
          charges_enabled: false,
          requirements: { currently_due: ["business_profile.url", "external_account"], disabled_reason: "requirements.past_due" },
        }),
      ),
    ).toEqual({ stripe_account_status: "pending", stripe_charges_enabled: false });
  });
});

describe("connectStatusLabel", () => {
  it("tells a connected contractor we never hold their money", () => {
    const s = connectStatusLabel({ accountId: "acct_1", status: "active", chargesEnabled: true });
    expect(s.tone).toBe("green");
    expect(s.detail).toMatch(/never hold it/i);
  });

  it("offers to resume an interrupted setup rather than start over", () => {
    expect(connectStatusLabel({ accountId: "acct_1", status: "pending", chargesEnabled: false }).label).toBe("Finish setup");
  });
});
