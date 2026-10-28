import { describe, it, expect, vi, beforeEach } from "vitest";
import { NO_BILLING_ACCOUNT_REFUSAL, SECOND_SUBSCRIPTION_REFUSAL } from "@/lib/lapse-doors";

/**
 * NEVER A SECOND SUBSCRIPTION ON THE SAME CUSTOMER (cn-v1137). startCheckout refuses while a Stripe
 * subscription is live (an id and a status Stripe can still bill or revive: active, trialing,
 * past_due, unpaid, incomplete, paused — lapse-doors stripeSubscriptionLive) and names the one door —
 * Manage Billing; a canceled or incomplete_expired one goes back through Checkout on the SAME customer. openPortal with no customer names its one
 * door — Subscribe. Stripe is a mock: what is asserted is which calls are made and where the
 * person is sent.
 */
const state = vi.hoisted(() => ({
  org: {} as Record<string, unknown>,
  profile: { org_id: "org-1", role: "owner", active: true } as Record<string, unknown>,
  linkWrites: [] as Record<string, unknown>[],
}));
const stripe = vi.hoisted(() => ({
  customers: { create: vi.fn(async () => ({ id: "cus_new" })) },
  checkout: { sessions: { create: vi.fn(async () => ({ url: "https://checkout.stripe.test/s/1" })) } },
  billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.test/p/1" })) } },
}));

function from(table: string) {
  const b: any = {
    select: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: table === "profiles" ? state.profile : state.org, error: null }),
    single: async () => ({ data: table === "profiles" ? state.profile : state.org, error: null }),
    update: (fields: Record<string, unknown>) => {
      state.linkWrites.push(fields);
      const u: any = { eq: async () => ({ data: null, error: null }) };
      return u;
    },
  };
  return b;
}
const client = {
  auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
  from: (t: string) => from(t),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe, STRIPE_PRICE_ID: "price_legacy" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { startCheckout, openPortal } from "./billing-actions";

const refusal = (words: string) => `REDIRECT:/settings?tab=getpaid&billing_error=${encodeURIComponent(words)}`;

beforeEach(() => {
  state.org = { id: "org-1", name: "Larkspur Electric", email: null, stripe_customer_id: null, stripe_subscription_id: null, subscription_status: "trialing" };
  state.profile = { org_id: "org-1", role: "owner", active: true };
  state.linkWrites = [];
  stripe.customers.create.mockClear();
  stripe.checkout.sessions.create.mockClear();
  stripe.billingPortal.sessions.create.mockClear();
});

describe("startCheckout", () => {
  it.each(["active", "past_due", "trialing", "unpaid", "incomplete", "paused"])(
    "a %s subscription already exists → refused, Manage Billing named, Stripe never asked",
    async (status) => {
      state.org = { ...state.org, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", subscription_status: status };
      await expect(startCheckout()).rejects.toThrow(refusal(SECOND_SUBSCRIPTION_REFUSAL));
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripe.customers.create).not.toHaveBeenCalled();
    },
  );

  it("a canceled subscription: Checkout again, on the SAME customer (no second customer minted)", async () => {
    state.org = { ...state.org, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_old", subscription_status: "canceled" };
    await expect(startCheckout()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect((stripe.checkout.sessions.create.mock.calls[0] as any)[0].customer).toBe("cus_1");
  });

  it("an incomplete_expired subscription (the first payment never came) is dead too: Checkout again, on the SAME customer", async () => {
    state.org = { ...state.org, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_old", subscription_status: "incomplete_expired" };
    await expect(startCheckout()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect((stripe.checkout.sessions.create.mock.calls[0] as any)[0].customer).toBe("cus_1");
  });

  it("no customer yet: one is created and linked, then Checkout", async () => {
    await expect(startCheckout()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(state.linkWrites).toEqual([{ stripe_customer_id: "cus_new" }]);
    expect((stripe.checkout.sessions.create.mock.calls[0] as any)[0].customer).toBe("cus_new");
  });

  it("a tech cannot start billing at all", async () => {
    state.profile = { org_id: "org-1", role: "tech", active: true };
    await expect(startCheckout()).rejects.toThrow("Only an owner or admin can manage billing.");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("openPortal", () => {
  it("no billing account yet → refused, Subscribe named", async () => {
    await expect(openPortal()).rejects.toThrow(refusal(NO_BILLING_ACCOUNT_REFUSAL));
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
  it("a customer → the portal, with the way home", async () => {
    state.org = { ...state.org, stripe_customer_id: "cus_1" };
    await expect(openPortal()).rejects.toThrow("REDIRECT:https://billing.stripe.test/p/1");
    expect((stripe.billingPortal.sessions.create.mock.calls[0] as any)[0]).toMatchObject({ customer: "cus_1" });
    expect((stripe.billingPortal.sessions.create.mock.calls[0] as any)[0].return_url).toContain("/settings?tab=getpaid");
  });
});
