import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";

/**
 * /api/pay (audit v994 BK1, BK3): the bank door opens only where the contractor turned Bank Transfer
 * on, and no second online payment opens while a bank transfer is on its way. In both refusals
 * Stripe is never asked for a Checkout session: that is the whole test.
 */
const state = vi.hoisted(() => ({ db: null as any, create: null as any }));
vi.mock("@/lib/stripe", () => ({
  billingEnabled: true,
  getStripe: () => ({ checkout: { sessions: { create: state.create } } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => state.db, createClient: async () => state.db }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { GET } from "./route";

const ORG = "org-et";
const tables = (settings: Record<string, unknown>, pending: any[] = []) => ({
  invoices: [{ id: "inv-78", invoice_number: "INV-078", total: 9590.89, amount_paid: 6760, status: "sent", org_id: ORG, public_token: "tok", customers: { email: "a@b.c" } }],
  organizations: [{ id: ORG, name: "ET Electric", settings, stripe_account_id: "acct_1", stripe_account_status: "active", stripe_charges_enabled: true }],
  pending_bank_transfers: pending,
});
const call = (method?: string) =>
  GET(new Request(`https://app.example.com/api/pay/tok${method ? `?method=${method}` : ""}`), { params: Promise.resolve({ token: "tok" }) });
const where = (res: Response) => res.headers.get("location") ?? "";

describe("GET /api/pay/<token>", () => {
  beforeEach(() => {
    state.create = vi.fn(async () => ({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
  });

  it("BK1: a hand-typed ?method=bank on an org that never turned Bank Transfer on is refused, with no checkout", async () => {
    state.db = fakeDb(tables({}));
    const res = await call("bank");
    expect(res.status).toBe(303);
    expect(where(res)).toMatch(/\/i\/tok\?pay=bank_unavailable$/);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("BK1: the card door is untouched by the switch", async () => {
    state.db = fakeDb(tables({}));
    const res = await call();
    expect(where(res)).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create.mock.calls[0][0].payment_method_types).toEqual(["card"]);
  });

  it("BK1: with the switch on, the bank door opens an ACH checkout", async () => {
    state.db = fakeDb(tables({ bank_transfer_enabled: true }));
    await call("bank");
    expect(state.create.mock.calls[0][0].payment_method_types).toEqual(["us_bank_account"]);
  });

  it("BK3: while a bank transfer is on its way, neither door opens a second checkout", async () => {
    const pending = [{ id: "t1", org_id: ORG, invoice_id: "inv-78", amount: 2830.89, status: "pending", started_at: "2026-09-24T18:00:00Z" }];
    state.db = fakeDb(tables({ bank_transfer_enabled: true }, pending));
    for (const m of [undefined, "bank"]) {
      const res = await call(m);
      expect(where(res)).toMatch(/\/i\/tok\?pay=pending$/);
    }
    expect(state.create).not.toHaveBeenCalled();
  });

  it("BK3: another org's pending transfer on the same invoice id does not hold this one up", async () => {
    const pending = [{ id: "t1", org_id: "org-other", invoice_id: "inv-78", amount: 5, status: "pending", started_at: "2026-09-24T18:00:00Z" }];
    state.db = fakeDb(tables({}, pending));
    await call();
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it("a database before 0338 has nothing on its way: a card payment is never held up by it", async () => {
    state.db = fakeDb(tables({}), { missing: ["pending_bank_transfers"] });
    await call();
    expect(state.create).toHaveBeenCalledTimes(1);
  });
});
