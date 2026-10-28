import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /SUBSCRIBE (cn-v1137): the headline by the one access rule's reason; ONE door for an owner/admin
 * (Manage Billing while a Stripe subscription is live, the plan cards otherwise) and the accountant's
 * export the lapsed notice promised; everyone else is told who holds the key by first name, through
 * THE one owner read (lib/lapse-words ownerFirstName: the service client, limit 1); a standing company
 * bounces to /planner; a failed read is said. The actions are mocked (never run); the page is rendered
 * with react-dom/server.
 */
const state = vi.hoisted(() => ({
  profile: { org_id: "org-1", role: "owner" } as { org_id: string | null; role: string } | null,
  org: {} as Record<string, unknown> | null,
  orgError: null as { message: string } | null,
  owners: [] as { full_name: string | null }[],
  ownersError: null as { message: string } | null,
  ownerReads: 0,
}));

function from(table: string) {
  // The owner read is the profiles read filtered to role = owner (lapse-words ownerFirstName): one row.
  let ownerRead = false;
  const b: any = {
    select: () => b,
    eq: (col: string, val: unknown) => {
      if (col === "role" && val === "owner") ownerRead = true;
      return b;
    },
    limit: () => b,
    maybeSingle: async () => {
      if (table !== "profiles") return { data: state.org, error: state.orgError };
      if (!ownerRead) return { data: state.profile, error: null };
      state.ownerReads++;
      return { data: state.ownersError ? null : (state.owners[0] ?? null), error: state.ownersError };
    },
  };
  return b;
}
const client = {
  auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
  from: (t: string) => from(t),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/stripe", () => ({ billingEnabled: true }));
vi.mock("@/app/(app)/settings/billing-actions", () => ({ startCheckout: vi.fn(), openPortal: vi.fn() }));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
const reportError = vi.fn();
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock("@/lib/plans", async (orig) => ({ ...(await orig<typeof import("@/lib/plans")>()), plansConfigured: () => true }));

import SubscribePage from "./page";

const DAY = 86_400_000;
const past = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function render(billing_error?: string) {
  return renderToStaticMarkup(await SubscribePage({ searchParams: Promise.resolve({ billing_error }) }));
}

beforeEach(() => {
  state.profile = { org_id: "org-1", role: "owner" };
  state.org = { id: "org-1", subscription_status: "trialing", trial_ends_at: past(2), stripe_customer_id: null, stripe_subscription_id: null };
  state.orgError = null;
  state.owners = [];
  state.ownersError = null;
  state.ownerReads = 0;
  reportError.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("the headline, by reason", () => {
  it("a trial that ended", async () => {
    const html = await render();
    expect(html).toContain("Your Free Trial Has Ended");
    expect(html).toContain("Pick a plan to keep using Contractor North.");
  });
  it("a card that was not updated in time", async () => {
    state.org = { ...state.org, subscription_status: "past_due", current_period_end: past(20), stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" };
    expect(await render()).toContain("Your Card Was Declined");
  });
  it("a canceled subscription", async () => {
    state.org = { ...state.org, subscription_status: "canceled", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" };
    expect(await render()).toContain("Your Subscription Has Ended");
  });
  it("no standing at all", async () => {
    state.org = { ...state.org, subscription_status: null, trial_ends_at: null };
    expect(await render()).toContain("Your Plan Needs Attention");
  });
});

describe("one door for the owner or admin", () => {
  it("no Stripe subscription: the plan cards (Checkout), and no Manage Billing", async () => {
    const html = await render();
    expect(html).toContain("Choose Handyman");
    expect(html).toContain("Choose Crew");
    expect(html).toContain("Choose Company");
    expect(html).not.toContain("Manage Billing");
  });
  it("a live subscription (past due, waiting on the card): Manage Billing alone, with the line", async () => {
    state.org = { ...state.org, subscription_status: "past_due", current_period_end: past(20), stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" };
    const html = await render();
    expect(html).toContain("Manage Billing");
    expect(html).toContain("Update the card or pick a plan there.");
    expect(html).not.toContain("Choose ");
    expect(html).not.toContain("Subscribe Now");
  });
  it("a canceled subscription cannot be restarted in the portal: the plan cards again (the customer is reused)", async () => {
    state.org = { ...state.org, subscription_status: "canceled", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" };
    const html = await render();
    expect(html).toContain("Choose Handyman");
    expect(html).not.toContain("Manage Billing");
  });
  it("an admin gets the same doors as the owner, and the owner is not looked up", async () => {
    state.profile = { org_id: "org-1", role: "admin" };
    const html = await render();
    expect(html).toContain("Choose Handyman");
    expect(state.ownerReads).toBe(0);
  });
  it("a billing_error from a refused action is shown", async () => {
    const html = await render("A subscription already exists — use Manage Billing.");
    expect(html).toContain("A subscription already exists — use Manage Billing.");
  });
  it("Download For Your Accountant is linked for the owner or admin — the door the lapsed notice promised (skeptic #43, S7); never for the crew", async () => {
    const owner = await render();
    expect(owner).toMatch(/<a href="\/analytics\/accountant"[^>]*>Download For Your Accountant<\/a>/);
    state.profile = { org_id: "org-1", role: "admin" };
    expect(await render()).toContain("Download For Your Accountant");
    state.profile = { org_id: "org-1", role: "tech" };
    expect(await render()).not.toContain("Download For Your Accountant");
  });
});

describe("everyone else is told who holds the key", () => {
  it("the single active owner, by first name; no plan cards, no portal", async () => {
    state.profile = { org_id: "org-1", role: "tech" };
    state.owners = [{ full_name: "Larkspur Snowbell" }];
    const html = await render();
    expect(html).toContain("Ask Larkspur to pick a plan.");
    expect(html).not.toContain("Choose ");
    expect(html).not.toContain("Manage Billing");
    expect(html).toContain("Sign Out");
  });
  it("no active owner, or a name that is blank: 'the owner'", async () => {
    state.profile = { org_id: "org-1", role: "office" };
    state.owners = [];
    expect(await render()).toContain("Ask the owner to pick a plan.");
    state.owners = [{ full_name: "   " }];
    expect(await render()).toContain("Ask the owner to pick a plan.");
    expect(state.ownerReads).toBe(2);
  });
  it("a failed owner read: 'the owner', and the failure is filed by the one helper (lapse-words:owner-read)", async () => {
    state.profile = { org_id: "org-1", role: "tech" };
    state.ownersError = { message: "boom" };
    expect(await render()).toContain("Ask the owner to pick a plan.");
    expect(reportError).toHaveBeenCalledWith("lapse-words:owner-read", state.ownersError, { orgId: "org-1" });
  });
  it("the page carries no owner read of its own (skeptic #43, S12): it asks lib/lapse-words", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/subscribe/page.tsx", "utf8");
    expect(src).toContain('import { ownerFirstName } from "@/lib/lapse-words";');
    expect(src).not.toContain('.eq("role", "owner")');
    expect(src).not.toContain("@/lib/owner-draw");
  });
});

describe("the bounce and the failed read", () => {
  it("a standing company is sent to /planner (active, a live trial, grace, comped_until)", async () => {
    state.org = { ...state.org, subscription_status: "active" };
    await expect(render()).rejects.toThrow("REDIRECT:/planner");
    state.org = { ...state.org, subscription_status: "trialing", trial_ends_at: future(3) };
    await expect(render()).rejects.toThrow("REDIRECT:/planner");
    state.org = { ...state.org, subscription_status: "past_due", current_period_end: past(2) };
    await expect(render()).rejects.toThrow("REDIRECT:/planner");
    state.org = { ...state.org, subscription_status: "canceled", comped_until: future(30) };
    await expect(render()).rejects.toThrow("REDIRECT:/planner");
  });
  it("the env comp list bounces too", async () => {
    vi.stubEnv("COMPED_ORG_IDS", "org-1");
    await expect(render()).rejects.toThrow("REDIRECT:/planner");
  });
  it("nobody signed in → /login; no company → /onboarding", async () => {
    state.profile = { org_id: null, role: "owner" };
    await expect(render()).rejects.toThrow("REDIRECT:/onboarding");
  });
  it("a failed company read is said, with one action, and decides nothing", async () => {
    state.org = null;
    state.orgError = { message: "read failed" };
    const html = await render();
    expect(html).toContain("Your Plan Needs Attention");
    expect(html).toContain("We couldn&#x27;t read your plan just now");
    expect(html).toContain("Try Again");
    expect(html).not.toContain("Choose ");
    expect(html).not.toContain("Manage Billing");
    expect(reportError).toHaveBeenCalledWith("subscribe:org-read", state.orgError, { orgId: "org-1" });
  });
});
