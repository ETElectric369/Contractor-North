import type Stripe from "stripe";

/**
 * STRIPE CONNECT — a contractor's customers pay THE CONTRACTOR (0161).
 *
 * The model is DIRECT CHARGES on a connected Express account: every charge for a
 * tenant's invoice is created ON that tenant's own Stripe account, so they are the
 * merchant of record (their name on the card statement, their balance, their payouts,
 * their refunds). Contractor North never holds their customers' money — which is the
 * honest arrangement, and also keeps us out of money-transmission territory.
 *
 * We take NO application fee. The subscription is the business model; skimming a
 * contractor's revenue on top is exactly the extraction the product exists to reject.
 */

/** What the pay route needs to know about a tenant's payment setup. */
export type ConnectState = {
  accountId: string | null;
  status: string;
  chargesEnabled: boolean;
};

export function connectStateFromOrg(org: {
  stripe_account_id?: string | null;
  stripe_account_status?: string | null;
  stripe_charges_enabled?: boolean | null;
}): ConnectState {
  return {
    accountId: org.stripe_account_id ?? null,
    status: org.stripe_account_status ?? "none",
    chargesEnabled: !!org.stripe_charges_enabled,
  };
}

/**
 * Can this org actually accept a card right now? BOTH conditions matter:
 * an account exists AND Stripe says it may charge. An account mid-onboarding
 * (identity docs pending, bank not linked) exists but cannot take money — sending
 * a customer to a checkout that will fail is worse than not showing the button.
 */
export function canAcceptPayments(state: ConnectState): boolean {
  return !!state.accountId && state.chargesEnabled;
}

/** Human-facing status for the Settings panel. */
export function connectStatusLabel(state: ConnectState): {
  label: string;
  tone: "green" | "amber" | "slate";
  detail: string;
} {
  if (canAcceptPayments(state)) {
    return {
      label: "Accepting payments",
      tone: "green",
      detail: "Your customers can pay invoices by card. The money goes straight to your bank — we never hold it.",
    };
  }
  if (state.accountId) {
    return {
      label: "Finish setup",
      tone: "amber",
      detail: "Stripe still needs a few details before you can take cards. Pick up where you left off.",
    };
  }
  return {
    label: "Not set up",
    tone: "slate",
    detail: "Connect a Stripe account to let customers pay invoices online. Takes about five minutes.",
  };
}

/** Mirror Stripe's account object onto our columns. The ONE place that mapping lives. */
export function accountUpdateFields(account: Stripe.Account): {
  stripe_account_status: string;
  stripe_charges_enabled: boolean;
} {
  const charges = !!account.charges_enabled;
  const needs = account.requirements?.currently_due?.length ?? 0;
  const disabled = account.requirements?.disabled_reason;
  // ORDER MATTERS. A brand-new account carries BOTH outstanding requirements and a
  // disabled_reason (verified against a real sandbox account: currently_due=12,
  // disabled_reason set). Checking disabled first labelled every fresh signup
  // "restricted", which reads like Stripe rejected them rather than "you haven't
  // finished yet". Outstanding requirements win: that's work the contractor can do.
  const status = charges ? "active" : needs > 0 ? "pending" : disabled ? "restricted" : "pending";
  return { stripe_account_status: status, stripe_charges_enabled: charges };
}
