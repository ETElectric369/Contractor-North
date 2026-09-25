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
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => void state.pushes.push(a)),
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
  invoices: [{ id: "inv-78", org_id: ORG, status: "sent", invoice_number: "INV-078", total: 9590.89, amount_paid: 6760, customers: { name: "Andrew Cohen" } }],
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
    expect(state.db.tables.pending_bank_transfers).toHaveLength(0);
    expect(state.pushes).toHaveLength(0);
  });
});
