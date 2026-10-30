import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NO_BILLING_ACCOUNT_REFUSAL, SECOND_SUBSCRIPTION_REFUSAL } from "@/lib/lapse-doors";
import { parseTopupMetadata } from "@/lib/stripe-topup";
import {
  ADD_USAGE_NOT_CONFIGURED,
  ADD_USAGE_NOT_PRICED,
  ADD_USAGE_WEB_ONLY,
  EXTRA_USAGE_USD_MAX,
  NO_PLAN_CONFIGURED,
  NO_SUCH_PLAN,
  PICK_PLAN_WEB_ONLY,
  extraUsageUsdOf,
  planNotConfiguredWords,
} from "./billing-doors";

/**
 * THE BILLING DOORS, AGAINST A STRIPE MOCK: what is asserted is which calls are made and where the
 * person is sent.
 *
 * startCheckout (cn-v1137): NEVER A SECOND SUBSCRIPTION ON THE SAME CUSTOMER — refused while a Stripe
 * subscription is live (lapse-doors stripeSubscriptionLive), naming Manage Billing; a canceled or
 * incomplete_expired one goes back through Checkout on the SAME customer. (cn-v1140) A posted tier
 * and cadence resolve lib/plans priceIdFor; a tier with no price is refused in words, never swapped
 * for the legacy price; no tier at all is the legacy STRIPE_PRICE_ID door. Inside the App Store app
 * it is refused in words (Apple 3.1.1), exactly as buyExtraUsage is.
 *
 * openPortal with no customer names its one door — Upgrade (the plan card's word, cn-v1140).
 *
 * buyExtraUsage (cn-v1140): owner/admin, web only; STRIPE_PRICE_EXTRA_USAGE retrieved with its
 * product expanded, product.metadata.usage_usd a positive number; a one-time Checkout on OUR account
 * (one argument: never a connected account) with the metadata shape the webhook reads verbatim, the
 * company's customer when it has one, and the way home on both urls. A product's usage_usd above
 * 1,000 or with more than six decimals is refused before any session. The metadata it stamps is
 * read back by the webhook's parser (lib/stripe-topup parseTopupMetadata): one shape, pinned here.
 *
 * No fixture here wears a vendor's real shape (no price_…, cus_…, cs_…): the ids are invented. The
 * company id is UUID-shaped (the webhook's parser refuses anything else), a stand-in.
 */
const ORG = vi.hoisted(() => "00000000-0000-4000-8000-000000000001");
const state = vi.hoisted(() => ({
  org: {} as Record<string, unknown>,
  profile: { org_id: ORG, role: "owner", active: true } as Record<string, unknown>,
  linkWrites: [] as Record<string, unknown>[],
  ua: "Mozilla/5.0 Safari" as string | null,
  price: {} as Record<string, unknown>,
}));
const stripe = vi.hoisted(() => ({
  customers: { create: vi.fn(async () => ({ id: "cust-larkspur-new" })) },
  checkout: { sessions: { create: vi.fn(async () => ({ url: "https://checkout.stripe.test/s/1" })) } },
  billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.test/p/1" })) } },
  prices: { retrieve: vi.fn(async () => state.price) },
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
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe, STRIPE_PRICE_ID: "price-larkspur-legacy" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => ({ get: (k: string) => (k.toLowerCase() === "user-agent" ? state.ua : null) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
const reportError = vi.fn();
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { startCheckout, openPortal, buyExtraUsage } from "./billing-actions";

const refusal = (words: string) => `REDIRECT:/settings?tab=getpaid&billing_error=${encodeURIComponent(words)}`;
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const sessionArgs = () => stripe.checkout.sessions.create.mock.calls[0] as unknown as [Record<string, any>, ...unknown[]];

beforeEach(() => {
  state.org = {
    id: ORG,
    name: "Larkspur Electric",
    email: "office@larkspur.example",
    settings: { timezone: "America/Los_Angeles" },
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: "trialing",
  };
  state.profile = { org_id: ORG, role: "owner", active: true };
  state.linkWrites = [];
  state.ua = "Mozilla/5.0 Safari";
  state.price = { id: "price-larkspur-extra", product: { id: "prod-larkspur-extra", metadata: { usage_usd: "10" } } };
  stripe.customers.create.mockClear();
  stripe.checkout.sessions.create.mockClear();
  stripe.billingPortal.sessions.create.mockClear();
  stripe.prices.retrieve.mockClear();
  reportError.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("startCheckout", () => {
  it.each(["active", "past_due", "trialing", "unpaid", "incomplete", "paused"])(
    "a %s subscription already exists → refused, Manage Billing named, Stripe never asked",
    async (status) => {
      state.org = { ...state.org, stripe_customer_id: "cust-larkspur-1", stripe_subscription_id: "subn-larkspur-1", subscription_status: status };
      await expect(startCheckout()).rejects.toThrow(refusal(SECOND_SUBSCRIPTION_REFUSAL));
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripe.customers.create).not.toHaveBeenCalled();
    },
  );

  it("a canceled subscription: Checkout again, on the SAME customer (no second customer minted)", async () => {
    state.org = { ...state.org, stripe_customer_id: "cust-larkspur-1", stripe_subscription_id: "subn-larkspur-old", subscription_status: "canceled" };
    await expect(startCheckout()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(sessionArgs()[0].customer).toBe("cust-larkspur-1");
  });

  it("an incomplete_expired subscription (the first payment never came) is dead too: Checkout again, on the SAME customer", async () => {
    state.org = { ...state.org, stripe_customer_id: "cust-larkspur-1", stripe_subscription_id: "subn-larkspur-old", subscription_status: "incomplete_expired" };
    await expect(startCheckout()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(sessionArgs()[0].customer).toBe("cust-larkspur-1");
  });

  it("no customer yet: one is created and linked, then Checkout", async () => {
    await expect(startCheckout()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(state.linkWrites).toEqual([{ stripe_customer_id: "cust-larkspur-new" }]);
    expect(sessionArgs()[0].customer).toBe("cust-larkspur-new");
  });

  it("a tech cannot start billing at all", async () => {
    state.profile = { org_id: ORG, role: "tech", active: true };
    await expect(startCheckout()).rejects.toThrow("Only an owner or admin can manage billing.");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("inside the App Store app: refused in words (Apple 3.1.1), Stripe never asked — exactly as buyExtraUsage is", async () => {
    state.ua = "Mozilla/5.0 (iPhone) CNShell/3 (iOS)";
    await expect(startCheckout(form({ tier: "crew" }))).rejects.toThrow(refusal(PICK_PLAN_WEB_ONLY));
    expect(PICK_PLAN_WEB_ONLY).toBe("Pick a plan on the web at app.contractornorth.com.");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  describe("the tier and the cadence (cn-v1140)", () => {
    it("a tier and a cadence resolve their own price (lib/plans priceIdFor), in subscription mode, with the way home", async () => {
      vi.stubEnv("STRIPE_PRICE_HANDYMAN_ANNUAL", "price-larkspur-handyman-yearly");
      await expect(startCheckout(form({ tier: "handyman", cadence: "annual" }))).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
      const [args] = sessionArgs();
      expect(args.mode).toBe("subscription");
      expect(args.line_items).toEqual([{ price: "price-larkspur-handyman-yearly", quantity: 1 }]);
      expect(args.success_url).toContain("/settings?tab=getpaid&billing=success");
      expect(args.cancel_url).toContain("/settings?tab=getpaid&billing=cancelled");
    });
    it("a tier with no cadence is monthly", async () => {
      vi.stubEnv("STRIPE_PRICE_CREW_MONTHLY", "price-larkspur-crew-monthly");
      await expect(startCheckout(form({ tier: "crew" }))).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
      expect(sessionArgs()[0].line_items).toEqual([{ price: "price-larkspur-crew-monthly", quantity: 1 }]);
    });
    it("a tier whose price is not configured is refused in words naming the plan and the cadence — never swapped for the legacy price", async () => {
      await expect(startCheckout(form({ tier: "crew", cadence: "annual" }))).rejects.toThrow(refusal(planNotConfiguredWords("Crew", "annual")));
      expect(planNotConfiguredWords("Crew", "annual")).toBe("Crew isn't set up for yearly billing yet.");
      expect(planNotConfiguredWords("Company", "monthly")).toBe("Company isn't set up for monthly billing yet.");
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripe.customers.create).not.toHaveBeenCalled();
    });
    it("a tier that is not on the ladder is refused in words", async () => {
      await expect(startCheckout(form({ tier: "gold" }))).rejects.toThrow(refusal(NO_SUCH_PLAN));
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });
    it("no tier posted (the legacy Subscribe Now door): the legacy STRIPE_PRICE_ID", async () => {
      await expect(startCheckout()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
      expect(sessionArgs()[0].line_items).toEqual([{ price: "price-larkspur-legacy", quantity: 1 }]);
      expect(NO_PLAN_CONFIGURED).toBe("No plan is configured yet.");
    });
  });
});

describe("openPortal", () => {
  it("no billing account yet → refused, Upgrade named", async () => {
    await expect(openPortal()).rejects.toThrow(refusal(NO_BILLING_ACCOUNT_REFUSAL));
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
  it("a customer → the portal, with the way home", async () => {
    state.org = { ...state.org, stripe_customer_id: "cust-larkspur-1" };
    await expect(openPortal()).rejects.toThrow("REDIRECT:https://billing.stripe.test/p/1");
    expect((stripe.billingPortal.sessions.create.mock.calls[0] as any)[0]).toMatchObject({ customer: "cust-larkspur-1" });
    expect((stripe.billingPortal.sessions.create.mock.calls[0] as any)[0].return_url).toContain("/settings?tab=getpaid");
  });
});

describe("buyExtraUsage (cn-v1140)", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_PRICE_EXTRA_USAGE", "price-larkspur-extra");
    // 8 PM Pacific on Oct 15, 2026: the company's month is October.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T03:00:00Z"));
  });

  it("the owner, on the web, with a customer: a one-time Checkout on OUR account, the metadata shape the webhook reads, both urls, then the redirect", async () => {
    state.org = { ...state.org, stripe_customer_id: "cust-larkspur-1" };
    await expect(buyExtraUsage()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    expect(stripe.prices.retrieve).toHaveBeenCalledWith("price-larkspur-extra", { expand: ["product"] });
    const call = sessionArgs();
    // One argument: never a request option naming a connected account.
    expect(call).toHaveLength(1);
    const [args] = call;
    expect(args.mode).toBe("payment");
    expect(args.customer).toBe("cust-larkspur-1");
    expect(args).not.toHaveProperty("customer_email");
    expect(args.line_items).toEqual([{ price: "price-larkspur-extra", quantity: 1 }]);
    expect(args.metadata).toEqual({ kind: "extra_usage", org_id: ORG, month: "2026-10", usage_usd: "10" });
    expect(args.success_url).toMatch(/\/settings\?tab=getpaid&usage=added$/);
    expect(args.cancel_url).toMatch(/\/settings\?tab=getpaid$/);
    expect(args).not.toHaveProperty("subscription_data");
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it("CONTRACT: the metadata the door stamps is exactly what the webhook's parser reads (lib/stripe-topup parseTopupMetadata)", async () => {
    await expect(buyExtraUsage()).rejects.toThrow("REDIRECT:");
    const [args] = sessionArgs();
    expect(parseTopupMetadata(args.metadata)).toEqual({ ok: true, value: { orgId: ORG, month: "2026-10", usageUsd: 10 } });
    state.price = { id: "price-larkspur-extra", product: { id: "prod-x", metadata: { usage_usd: "12.5" } } };
    stripe.checkout.sessions.create.mockClear();
    await expect(buyExtraUsage()).rejects.toThrow("REDIRECT:");
    expect(parseTopupMetadata(sessionArgs()[0].metadata)).toMatchObject({ ok: true, value: { usageUsd: 12.5 } });
  });

  it("no customer yet: the company's email, and no customer is minted for a one-time payment", async () => {
    await expect(buyExtraUsage()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    const [args] = sessionArgs();
    expect(args).not.toHaveProperty("customer");
    expect(args.customer_email).toBe("office@larkspur.example");
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(state.linkWrites).toEqual([]);
  });

  it("the month is the company's own calendar month (a UTC date already in the next month is still this one)", async () => {
    // 11 PM Pacific on Oct 31 is already Nov 1 in UTC: the top-up still belongs to October.
    vi.setSystemTime(new Date("2026-11-01T06:00:00Z"));
    await expect(buyExtraUsage()).rejects.toThrow("REDIRECT:");
    expect(sessionArgs()[0].metadata.month).toBe("2026-10");
  });

  it("usage_usd is the product's number as a string, whatever its spelling", async () => {
    state.price = { id: "price-larkspur-extra", product: { id: "prod-x", metadata: { usage_usd: "12.5" } } };
    await expect(buyExtraUsage()).rejects.toThrow("REDIRECT:");
    expect(sessionArgs()[0].metadata.usage_usd).toBe("12.5");
  });

  it("an admin may; a tech and an office seat are refused in words, Stripe never asked", async () => {
    state.profile = { org_id: ORG, role: "admin", active: true };
    await expect(buyExtraUsage()).rejects.toThrow("REDIRECT:https://checkout.stripe.test/s/1");
    for (const role of ["tech", "office"]) {
      stripe.checkout.sessions.create.mockClear();
      state.profile = { org_id: ORG, role, active: true };
      await expect(buyExtraUsage()).rejects.toThrow("Only an owner or admin can manage billing.");
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    }
  });

  it("inside the App Store app: refused in words (Apple 3.1.1), Stripe never asked", async () => {
    state.ua = "Mozilla/5.0 (iPhone) CNShell/3 (iOS)";
    await expect(buyExtraUsage()).rejects.toThrow(refusal(ADD_USAGE_WEB_ONLY));
    expect(stripe.prices.retrieve).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("STRIPE_PRICE_EXTRA_USAGE unset: refused in words, Stripe never asked", async () => {
    vi.stubEnv("STRIPE_PRICE_EXTRA_USAGE", "");
    await expect(buyExtraUsage()).rejects.toThrow(refusal(ADD_USAGE_NOT_CONFIGURED));
    expect(stripe.prices.retrieve).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("a product with no positive usage_usd — or one above 1,000, or with more than six decimals: refused in words, filed, no session", async () => {
    for (const product of [
      { id: "p", metadata: {} },
      { id: "p", metadata: { usage_usd: "0" } },
      { id: "p", metadata: { usage_usd: "ten" } },
      "prod-unexpanded",
      { id: "p", deleted: true, metadata: { usage_usd: "10" } },
      { id: "p", metadata: { usage_usd: "1000.01" } }, // above the ceiling: a typo in Stripe, never a session
      { id: "p", metadata: { usage_usd: "0.1234567" } }, // seven decimals: 0401's column holds six
    ]) {
      stripe.checkout.sessions.create.mockClear();
      reportError.mockClear();
      state.price = { id: "price-larkspur-extra", product };
      await expect(buyExtraUsage(), JSON.stringify(product)).rejects.toThrow(refusal(ADD_USAGE_NOT_PRICED));
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith("stripe:extra-usage:unpriced", expect.any(Error), { orgId: ORG, priceId: "price-larkspur-extra" });
    }
  });

  it("a Stripe refusal is said on the card and filed", async () => {
    stripe.checkout.sessions.create.mockRejectedValueOnce(new Error("No such price"));
    await expect(buyExtraUsage()).rejects.toThrow(refusal("No such price"));
    expect(reportError).toHaveBeenCalledWith("stripe:extra-usage:create", expect.any(Error), { orgId: ORG, priceId: "price-larkspur-extra" });
  });
});

describe("billing-doors extraUsageUsdOf", () => {
  it("reads a positive number from the expanded product's metadata and nothing else", () => {
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "10" } } })).toBe(10);
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: " 7.25 " } } })).toBe(7.25);
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "" } } })).toBeNull();
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "-3" } } })).toBeNull();
    expect(extraUsageUsdOf({ product: { metadata: {} } })).toBeNull();
    expect(extraUsageUsdOf({ product: "prod-unexpanded" })).toBeNull();
    expect(extraUsageUsdOf({ product: { deleted: true, metadata: { usage_usd: "10" } } })).toBeNull();
    expect(extraUsageUsdOf(null)).toBeNull();
  });
  it("refuses a usage_usd above 1,000 (the ceiling itself passes) and one with more than six decimals (six pass)", () => {
    expect(EXTRA_USAGE_USD_MAX).toBe(1000);
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "1000" } } })).toBe(1000);
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "1000.000001" } } })).toBeNull();
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "1001" } } })).toBeNull();
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "15000" } } })).toBeNull();
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "0.123456" } } })).toBe(0.123456);
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "0.1234567" } } })).toBeNull();
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "10.0000001" } } })).toBeNull();
    // Not a plain decimal: an exponent, a sign, a thousands separator — refused, never parsed to something else.
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "1e2" } } })).toBeNull();
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "+10" } } })).toBeNull();
    expect(extraUsageUsdOf({ product: { metadata: { usage_usd: "1,000" } } })).toBeNull();
  });
});
