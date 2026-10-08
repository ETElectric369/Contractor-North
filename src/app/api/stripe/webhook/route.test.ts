import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";

/**
 * THE STRIPE WEBHOOK'S BANK-TRANSFER HALF (audit v994 BK2, BK3), without Stripe or a database.
 *
 *   BK2  a debit that clears is booked under the method it was paid with ('ach'), never 'card';
 *   BK3  a debit that starts (completed, unpaid) books NO money but marks the transfer on its way
 *        and tells the office once; async_payment_succeeded books it and clears the mark;
 *        async_payment_failed books nothing, ends the mark, and tells the office once.
 * Every write stands behind the org<->connected-account check the payment itself does.
 */
const state = vi.hoisted(() => ({ db: null as any, event: null as any, pushes: [] as any[] }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ webhooks: { constructEvent: () => state.event } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => state.db }));
// The real notifyPeople runs (the Bell records every push): its bell line goes into the fake
// database's notifications table, and its push lands here.
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => {
    state.pushes.push(a);
    return a[0] as string[];
  }),
  pushKindIsOptIn: vi.fn((kind: string) => kind === "day_ahead"),
  orgStaffIds: vi.fn(async () => ["office-1"]),
}));
vi.mock("@/lib/invoice-recalc", () => ({ recalcInvoice: vi.fn(async () => true) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/processor-fee-capture", () => ({ captureProcessorFee: vi.fn(async () => undefined) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
import { POST } from "./route";

const ORG = "org-et";
const ACCT = "acct_et";
const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_1",
  payment_intent: "pi_bank",
  payment_status: "unpaid",
  payment_method_types: ["us_bank_account"],
  amount_total: 283089,
  metadata: { kind: "invoice_payment", invoice_id: "inv-78", org_id: ORG, pay_method: "bank", invoice_amount: "2830.89", card_fee: "0.00" },
  ...over,
});
const deliver = async (type: string, obj: any, id = `evt_${type}`, account = ACCT) => {
  state.event = { id, type, account, data: { object: obj } };
  return POST(new Request("https://app.example.com/api/stripe/webhook", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=x" } }));
};
const tables = () => ({
  organizations: [{ id: ORG, stripe_account_id: ACCT }],
  invoices: [{ id: "inv-78", org_id: ORG, status: "sent", invoice_number: "INV-078", total: 9590.89, amount_paid: 6760, customers: { name: "Andrew Crake" } }],
  payments: [] as any[],
  pending_bank_transfers: [] as any[],
});

describe("the webhook and a bank transfer", () => {
  beforeEach(() => {
    state.db = fakeDb(tables());
    state.pushes = [];
  });

  it("BK3: the debit starting books no money, marks it on its way, and tells the office once", async () => {
    expect((await deliver("checkout.session.completed", session())).status).toBe(200);
    expect(state.db.tables.payments).toHaveLength(0);
    expect(state.db.tables.pending_bank_transfers).toHaveLength(1);
    expect(state.db.tables.pending_bank_transfers[0]).toMatchObject({ org_id: ORG, invoice_id: "inv-78", status: "pending", amount: 2830.89 });
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0][2].title).toBe("Bank transfer on its way");
    expect(state.pushes[0][2].body).toContain("INV-078");
    // Stripe resends the same event: nothing new, and no second push.
    await deliver("checkout.session.completed", session());
    expect(state.db.tables.pending_bank_transfers).toHaveLength(1);
    expect(state.pushes).toHaveLength(1);
  });

  it("BK2 + BK3: the debit clearing is booked as ach, and the mark is cleared", async () => {
    await deliver("checkout.session.completed", session());
    await deliver("checkout.session.async_payment_succeeded", session({ payment_status: "paid" }), "evt_ok");
    expect(state.db.tables.payments).toHaveLength(1);
    expect(state.db.tables.payments[0]).toMatchObject({ method: "ach", amount: 2830.89, stripe_payment_intent: "pi_bank", note: "Online bank transfer" });
    expect(state.db.tables.pending_bank_transfers[0].status).toBe("cleared");
    expect(state.pushes.at(-1)[2].body).toContain("paid by bank transfer");
  });

  it("BK2: a card checkout is still booked as card", async () => {
    await deliver(
      "checkout.session.completed",
      session({ payment_status: "paid", payment_method_types: ["card"], payment_intent: "pi_card", metadata: { ...session().metadata, pay_method: "card" } }),
    );
    expect(state.db.tables.payments[0]).toMatchObject({ method: "card", note: "Online payment" });
    expect(state.db.tables.pending_bank_transfers).toHaveLength(0);
  });

  it("BK3: the debit failing books nothing, ends the mark, and tells the office once", async () => {
    await deliver("checkout.session.completed", session());
    await deliver("checkout.session.async_payment_failed", session(), "evt_fail");
    await deliver("checkout.session.async_payment_failed", session(), "evt_fail");
    expect(state.db.tables.payments).toHaveLength(0);
    expect(state.db.tables.pending_bank_transfers[0].status).toBe("failed");
    const failed = state.pushes.filter((p) => p[2].title === "Bank transfer failed");
    expect(failed).toHaveLength(1);
    expect(failed[0][2].body).toContain("Nothing was recorded, and the invoice is still open.");
  });

  it("BK3: a success that arrives before its start leaves nothing pending", async () => {
    await deliver("checkout.session.async_payment_succeeded", session({ payment_status: "paid" }), "evt_ok");
    await deliver("checkout.session.completed", session(), "evt_late");
    expect(state.db.tables.payments).toHaveLength(1);
    expect(state.db.tables.pending_bank_transfers.filter((t: any) => t.status === "pending")).toHaveLength(0);
  });

  it("the metadata is a claim: an account that does not own the org marks nothing", async () => {
    await deliver("checkout.session.completed", session(), "evt_x", "acct_someone_else");
    await deliver("checkout.session.async_payment_failed", session(), "evt_y", "acct_someone_else");
    // The cleared path too: no payment is booked, and no 'cleared' marker is written carrying
    // another tenant's org_id and invoice_id.
    expect((await deliver("checkout.session.async_payment_succeeded", session({ payment_status: "paid" }), "evt_z", "acct_someone_else")).status).toBe(200);
    expect(state.db.tables.payments).toHaveLength(0);
    expect(state.db.tables.pending_bank_transfers).toHaveLength(0);
    expect(state.pushes).toHaveLength(0);
  });

  /**
   * A REFUND'S NOTICE CARRIES THE CHARGE AND THE AMOUNT (item C, 2026-10-07): its link opens the
   * invoice with Record This Refund drawn for that charge. A dispute's notice is as it was.
   */
  describe("a refund's notice leads to Record This Refund", () => {
    const paid = () => ({
      ...tables(),
      payments: [{ id: "pay-1", org_id: ORG, invoice_id: "inv-78", amount: 100, stripe_payment_intent: "pi_card", stripe_event_id: "evt_paid" }],
      notifications: [] as any[],
    });

    it("says the amount Stripe refunded and links the invoice with the charge", async () => {
      state.db = fakeDb(paid());
      expect((await deliver("charge.refunded", { id: "ch_1", payment_intent: "pi_card", amount_refunded: 2500 })).status).toBe(200);
      expect(state.pushes).toHaveLength(1);
      const notice = state.pushes[0][2];
      expect(notice.title).toBe("An online payment was refunded");
      expect(notice.body).toContain("$25.00 left Stripe");
      expect(notice.body).toContain("Record This Refund");
      expect(notice.url).toBe("/billing/inv-78?refund=ch_1");
    });

    it("a dispute's notice links the invoice plain, with no charge to record", async () => {
      state.db = fakeDb(paid());
      await deliver("charge.dispute.created", { id: "dp_1", charge: "ch_1", payment_intent: "pi_card" });
      expect(state.pushes).toHaveLength(1);
      expect(state.pushes[0][2].title).toBe("A card payment was disputed");
      expect(state.pushes[0][2].url).toBe("/billing/inv-78");
    });

    it("a refund of a payment North never recorded still tells the office, at the billing board", async () => {
      state.db = fakeDb({ ...tables(), notifications: [] });
      await deliver("charge.refunded", { id: "ch_9", payment_intent: "pi_unknown", amount_refunded: 500 });
      expect(state.pushes).toHaveLength(1);
      expect(state.pushes[0][2].url).toBe("/billing");
    });
  });

  describe("the Bell records what the office is told, once (0366 wave, W1-10)", () => {
    const lines = () => (state.db.tables.notifications ?? []) as any[];

    it("a payment recorded: one bell line beside the one push, and a replay of the event writes neither again", async () => {
      const paid = session({ payment_status: "paid", payment_method_types: ["card"], payment_intent: "pi_card", metadata: { ...session().metadata, pay_method: "card" } });
      await deliver("checkout.session.completed", paid, "evt_paid");
      expect(state.db.tables.payments).toHaveLength(1);
      expect(state.pushes).toHaveLength(1);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatchObject({ org_id: ORG, user_id: "office-1", type: "invoice_paid", title: "Payment received", url: "/billing/inv-78" });
      expect(lines()[0].body).toBe(state.pushes[0][2].body);
      // Stripe resends the same event: the payment insert is a 23505, settled, and nothing is said again.
      expect((await deliver("checkout.session.completed", paid, "evt_paid")).status).toBe(200);
      expect(state.db.tables.payments).toHaveLength(1);
      expect(state.pushes).toHaveLength(1);
      expect(lines()).toHaveLength(1);
    });

    it("a bank transfer on its way, and one that failed: each on the bell once", async () => {
      await deliver("checkout.session.completed", session());
      await deliver("checkout.session.completed", session());
      await deliver("checkout.session.async_payment_failed", session(), "evt_fail");
      await deliver("checkout.session.async_payment_failed", session(), "evt_fail");
      expect(lines().map((l) => l.title)).toEqual(["Bank transfer on its way", "Bank transfer failed"]);
      expect(lines().every((l) => l.user_id === "office-1" && l.org_id === ORG)).toBe(true);
    });

    it("an account that doesn't own the org puts nothing on anybody's bell", async () => {
      await deliver("checkout.session.completed", session({ payment_status: "paid" }), "evt_x", "acct_someone_else");
      expect(lines()).toEqual([]);
    });
  });

  describe("a marker write that fails is retried, never acked", () => {
    it("the debit starting: 500, then Stripe's resend marks it once and tells the office once", async () => {
      state.db.failing.add("pending_bank_transfers");
      await expect(deliver("checkout.session.completed", session())).rejects.toThrow(/on its way failed/);
      expect(state.pushes).toHaveLength(0);
      state.db.failing.delete("pending_bank_transfers");
      expect((await deliver("checkout.session.completed", session())).status).toBe(200);
      expect(state.db.tables.pending_bank_transfers).toMatchObject([{ status: "pending" }]);
      expect(state.pushes).toHaveLength(1);
    });

    it("the debit failing: 500, then the resend ends the mark and tells the office once", async () => {
      await deliver("checkout.session.completed", session());
      state.db.failing.add("pending_bank_transfers");
      await expect(deliver("checkout.session.async_payment_failed", session(), "evt_fail")).rejects.toThrow(/marker/);
      expect(state.pushes.filter((p) => p[2].title === "Bank transfer failed")).toHaveLength(0);
      state.db.failing.delete("pending_bank_transfers");
      expect((await deliver("checkout.session.async_payment_failed", session(), "evt_fail")).status).toBe(200);
      await deliver("checkout.session.async_payment_failed", session(), "evt_fail");
      expect(state.db.tables.pending_bank_transfers[0].status).toBe("failed");
      expect(state.pushes.filter((p) => p[2].title === "Bank transfer failed")).toHaveLength(1);
    });

    it("the debit clearing: 500 after the money is booked, then the resend clears the mark with no second payment or push", async () => {
      await deliver("checkout.session.completed", session());
      state.db.failing.add("pending_bank_transfers");
      await expect(deliver("checkout.session.async_payment_succeeded", session({ payment_status: "paid" }), "evt_ok")).rejects.toThrow(/marker/);
      expect(state.db.tables.payments).toHaveLength(1);
      const pushed = state.pushes.length;
      state.db.failing.delete("pending_bank_transfers");
      expect((await deliver("checkout.session.async_payment_succeeded", session({ payment_status: "paid" }), "evt_ok")).status).toBe(200);
      expect(state.db.tables.payments).toHaveLength(1);
      expect(state.db.tables.pending_bank_transfers[0].status).toBe("cleared");
      expect(state.pushes).toHaveLength(pushed);
    });
  });
});
