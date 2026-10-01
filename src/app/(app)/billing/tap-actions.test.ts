import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";

/**
 * TAP TO PAY TELLS THE TRUTH (0e2cb937 — Rich Seiler, INV-083, $420, 2026-09-30), the server half.
 *
 * tapPaymentOutcome reads the PaymentIntent off the tenant's connected account and answers with
 * Stripe's word, not the phone's. The metadata is a claim (another company's intent, another
 * invoice's intent: refused in words, nothing written). A succeeded intent the webhook hasn't
 * booked is booked HERE through the one writer — once, under the key the webhook uses too, so
 * the second writer (this action again, or the webhook a beat later) finds the row and heals
 * instead of booking twice.
 */
const state = vi.hoisted(() => ({
  db: null as any,
  pi: null as any,
  reported: [] as { where: string; extra: any }[],
  bells: [] as any[],
  completed: [] as string[],
}));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: state.db, userId: "user-erik", orgId: "org-et" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(), createServiceClient: () => state.db }));
vi.mock("@/lib/stripe", () => ({
  billingEnabled: true,
  getStripe: () => ({ paymentIntents: { retrieve: vi.fn(async () => state.pi) } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/push", () => ({
  orgStaffIds: vi.fn(async () => ["office-1"]),
  pushConfigured: () => false,
  sendPushToProfiles: vi.fn(async () => []),
  pushKindIsOptIn: () => false,
}));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async (...a: any[]) => void state.bells.push(a)) }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string, _e: unknown, extra: any) => void state.reported.push({ where, extra }) }));
vi.mock("@/lib/invoice-recalc", () => ({ recalcInvoice: vi.fn(async () => true) }));
vi.mock("@/lib/complete-job-when-paid", () => ({ completeJobWhenPaid: vi.fn(async (_db: unknown, id: string) => void state.completed.push(id)) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/processor-fee-capture", () => ({ captureProcessorFee: vi.fn(async () => undefined) }));
vi.mock("@/lib/pay-door-send", () => ({ needsSendRefusal: vi.fn(), sendDraftForPayment: vi.fn() }));

process.env.STRIPE_SECRET_KEY = "sk_live_x";
const { tapPaymentOutcome } = await import("./tap-actions");
const { recordStripeInvoicePayment, tapPaymentKey, TAP_VIA } = await import("@/lib/record-invoice-payment");

const ORG = "org-et";
const ACCT = "acct_et";
const INV = "inv-83";
const tables = () => ({
  organizations: [{ id: ORG, stripe_account_id: ACCT }],
  invoices: [{ id: INV, org_id: ORG, status: "sent", invoice_number: "INV-083", total: 420, amount_paid: 0, customers: { name: "Rich Seiler" } }],
  payments: [] as any[],
});
const intent = (over: Record<string, unknown> = {}) => ({
  id: "pi_420",
  status: "succeeded",
  amount: 42000,
  amount_received: 42000,
  livemode: true,
  payment_method_types: ["card_present"],
  last_payment_error: null,
  metadata: { kind: "invoice_payment", source: "tap_to_pay", invoice_id: INV, org_id: ORG, user_id: "user-erik" },
  ...over,
});

describe("tapPaymentOutcome — Stripe's word, not the phone's", () => {
  beforeEach(() => {
    state.db = fakeDb(tables());
    state.pi = intent();
    state.reported.length = 0;
    state.bells.length = 0;
    state.completed.length = 0;
  });

  it("another company's intent is refused in words, and nothing is written", async () => {
    state.pi = intent({ metadata: { ...intent().metadata, org_id: "org-someone-else" } });
    expect(await tapPaymentOutcome(INV, "pi_420")).toEqual({ ok: false, error: "That payment isn't this company's." });
    // An intent without the Tap marker (a Checkout intent) is not this door's either.
    state.pi = intent({ metadata: { kind: "invoice_payment", invoice_id: INV, org_id: ORG } });
    expect(await tapPaymentOutcome(INV, "pi_420")).toEqual({ ok: false, error: "That payment isn't this company's." });
    expect(state.db.tables.payments).toHaveLength(0);
  });

  it("an intent minted for a different invoice is refused in words", async () => {
    expect(await tapPaymentOutcome("inv-other", "pi_420")).toEqual({ ok: false, error: "That payment is for a different invoice." });
    expect(state.db.tables.payments).toHaveLength(0);
  });

  it("something that isn't a payment id never reaches Stripe", async () => {
    expect(await tapPaymentOutcome(INV, "evt_123")).toEqual({ ok: false, error: "That isn't a payment id." });
  });

  it("INV-083: the phone said approved, Stripe says requires_payment_method — not charged, in plain words, and in error_events", async () => {
    state.pi = intent({
      status: "requires_payment_method",
      amount_received: 0,
      last_payment_error: { decline_code: "insufficient_funds", code: "card_declined", message: "Your card has insufficient funds." },
    });
    const r = await tapPaymentOutcome(INV, "pi_420");
    expect(r).toEqual({ ok: true, status: "requires_payment_method", amountReceived: 0, lastError: "the card has insufficient funds", booked: false, recorded: false });
    expect(state.db.tables.payments).toHaveLength(0);
    expect(state.reported).toHaveLength(1);
    expect(state.reported[0].where).toBe("stripe:terminal:confirm-not-succeeded");
    expect(state.reported[0].extra).toMatchObject({ orgId: ORG, invoiceId: INV, paymentIntentId: "pi_420", status: "requires_payment_method", lastError: "the card has insufficient funds" });
  });

  it("no last error → lastError is null, never a blank or a raw code", async () => {
    state.pi = intent({ status: "requires_payment_method", amount_received: 0 });
    const r = await tapPaymentOutcome(INV, "pi_420");
    expect(r.ok && r.lastError).toBeNull();
  });

  it("succeeded with no row yet: booked once, under the tap key, through the one writer (recalc, job completion, the bell)", async () => {
    const r = await tapPaymentOutcome(INV, "pi_420");
    expect(r).toEqual({ ok: true, status: "succeeded", amountReceived: 42000, lastError: null, booked: true, recorded: true });
    expect(state.db.tables.payments).toHaveLength(1);
    expect(state.db.tables.payments[0]).toMatchObject({
      invoice_id: INV,
      org_id: ORG,
      amount: 420,
      method: "card",
      note: TAP_VIA.note,
      stripe_event_id: tapPaymentKey("pi_420"),
      stripe_payment_intent: "pi_420",
    });
    expect(state.completed).toEqual([INV]);
    expect(state.bells).toHaveLength(1);
    expect(state.bells[0][3].title).toBe("Payment received");
    expect(state.bells[0][3].body).toContain("paid by card in person");
    expect(state.reported).toHaveLength(0);
  });

  it("called twice: one row, the second answer says recorded but not booked, and the bell rings once", async () => {
    await tapPaymentOutcome(INV, "pi_420");
    const again = await tapPaymentOutcome(INV, "pi_420");
    expect(again).toEqual({ ok: true, status: "succeeded", amountReceived: 42000, lastError: null, booked: false, recorded: true });
    expect(state.db.tables.payments).toHaveLength(1);
    expect(state.bells).toHaveLength(1);
  });

  it("the webhook arriving after the sheet booked it finds the row: 'already', still one row", async () => {
    await tapPaymentOutcome(INV, "pi_420");
    const outcome = await recordStripeInvoicePayment(state.db, {
      invoiceId: INV,
      orgId: ORG,
      amount: 420,
      idempotencyKey: tapPaymentKey("pi_420"),
      paymentIntent: "pi_420",
      connectedAccount: ACCT,
      via: TAP_VIA,
    });
    expect(outcome).toBe("already");
    expect(state.db.tables.payments).toHaveLength(1);
    expect(state.bells).toHaveLength(1);
  });

  it("the sheet arriving after the webhook booked it finds the row — even a row from before the shared key (keyed on the event id)", async () => {
    state.db.tables.payments.push({ id: "pay-old", invoice_id: INV, org_id: ORG, amount: 420, method: "card", stripe_event_id: "evt_old", stripe_payment_intent: "pi_420" });
    const r = await tapPaymentOutcome(INV, "pi_420");
    expect(r).toEqual({ ok: true, status: "succeeded", amountReceived: 42000, lastError: null, booked: false, recorded: true });
    expect(state.db.tables.payments).toHaveLength(1);
    expect(state.bells).toHaveLength(0);
  });

  it("succeeded but the write fails: said as succeeded and NOT recorded, never 'not charged'", async () => {
    state.db.failing.add("payments");
    const r = await tapPaymentOutcome(INV, "pi_420");
    expect(r).toEqual({ ok: true, status: "succeeded", amountReceived: 42000, lastError: null, booked: false, recorded: false });
    expect(state.reported.map((x) => x.where)).toEqual(["stripe:terminal:outcome-book"]);
  });
});
