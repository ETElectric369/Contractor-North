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
const state = vi.hoisted(() => ({
  db: null as any,
  event: null as any,
  pushes: [] as any[],
  sigError: null as string | null,
  noKey: false,
  /** What subscriptions.retrieve answers (the declined-card branch asks Stripe for the subscription). */
  subscription: null as any,
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    ...(state.noKey ? (() => { throw new Error("STRIPE_SECRET_KEY is not configured."); })() : {}),
    webhooks: {
      constructEvent: () => {
        if (state.sigError) throw new Error(state.sigError);
        return state.event;
      },
    },
    subscriptions: { retrieve: async () => state.subscription },
  }),
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
vi.mock("@/lib/observe", () => ({ reportError: vi.fn(), reportErrorAwaited: vi.fn(async () => {}) }));
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn(), reportBlockerAwaited: vi.fn(async () => {}) }));

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
import { POST } from "./route";
import { reportError, reportErrorAwaited } from "@/lib/observe";
import { reportBlockerAwaited } from "@/lib/observe-blocker";

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

/**
 * A REFUSAL IS FILED (cn-v1129, the review's sink-01): a wrong or missing signing secret after a
 * key change refuses every event, and until now the 400 was the only word. Each refusal keeps its
 * response and files one row, waited for — counts, the header's own timestamp and Stripe's reason
 * words; never the secret, the body or the signature. A POST with no signature header is not
 * Stripe: answered, not filed.
 *
 * AND ONLY STRIPE'S SHAPE PAGES (skeptic #42, S1): a refusal is a blocker when the header carries a
 * numeric t= and a v1= part and the body is a JSON event (object "event", an id starting "evt_");
 * anything else is a plain error under its own words ("malformed signature or body", its own dedup
 * key), so a stranger with a stripe-signature header cannot buzz the team and cannot bury a real
 * dead secret under a triaged noise row. The two 503 config refusals stay blockers.
 */
describe("a refused webhook is filed, never only answered", () => {
  const BODY = '{"id":"evt_x","object":"event","type":"charge.refunded"}';
  const call = (headers: Record<string, string>, body: string = BODY) =>
    POST(new Request("https://app.example.com/api/stripe/webhook", { method: "POST", body, headers }));
  // A BLOCKER (cn-v1136): every refusal is every company's card payment refused, so it goes through
  // the waited-for blocker door, which pages North's own team on the first one; the plain error
  // doors, waited for or not, must not carry it.
  const filed = () => vi.mocked(reportBlockerAwaited).mock.calls.filter((c) => c[0] === "stripe:webhook:refused");
  const filedLoose = () => [...vi.mocked(reportError).mock.calls, ...vi.mocked(reportErrorAwaited).mock.calls].filter((c) => c[0] === "stripe:webhook:refused");
  /** The malformed branch: a plain error, WAITED FOR (the function answers on the same tick), never the fire-and-forget door. */
  const filedMalformed = () => vi.mocked(reportErrorAwaited).mock.calls.filter((c) => c[0] === "stripe:webhook:refused");

  beforeEach(() => {
    state.sigError = null;
    state.noKey = false;
    vi.mocked(reportError).mockClear();
    vi.mocked(reportErrorAwaited).mockClear();
    vi.mocked(reportBlockerAwaited).mockClear();
    vi.unstubAllEnvs();
  });

  it("a signature that matches no secret: 400 as before, and one waited-for row with counts, the header's t= and Stripe's words", async () => {
    state.sigError = "No signatures found matching the expected signature for payload";
    const res = await call({ "stripe-signature": "t=1700000000,v1=deadbeef" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Webhook signature failed");
    expect(filed()).toHaveLength(1);
    expect(filedLoose()).toHaveLength(0); // waited for and a blocker, never a plain row on a path that returns at once
    const [, err, extra] = filed()[0];
    expect((err as Error).message).toBe("signature matched no secret");
    expect(extra).toEqual({ secretsTried: 1, bodyChars: BODY.length, sigTimestamp: "1700000000", reason: state.sigError });
    const words = JSON.stringify(extra);
    expect(words).not.toContain("whsec_test");
    expect(words).not.toContain("deadbeef");
    expect(words).not.toContain("evt_x");
  });

  it("a header whose t= is absurdly long is not a timestamp — and so not Stripe's shape: a plain error saying 'no t', no page", async () => {
    state.sigError = "bad";
    const res = await call({ "stripe-signature": "t=" + "9".repeat(40) + ",v1=x" });
    expect(res.status).toBe(400);
    expect(filed()).toHaveLength(0);
    expect(filedMalformed()).toHaveLength(1);
    const [, err, extra] = filedMalformed()[0];
    expect((err as Error).message).toBe("malformed signature or body");
    expect(extra).toEqual({ secretsTried: 1, bodyChars: BODY.length, sigShape: "no t" });
  });

  describe("not Stripe's shape: a plain error under its own words, its own key, never a page (skeptic #42, S1)", () => {
    beforeEach(() => {
      state.sigError = "No signatures found matching the expected signature for payload";
    });

    it("a header with no v1= part: 400, sigShape 'no v1'", async () => {
      const res = await call({ "stripe-signature": "t=1700000000,v0=deadbeef" });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Webhook signature failed");
      expect(filed()).toHaveLength(0);
      expect(vi.mocked(reportError).mock.calls.filter((c) => c[0] === "stripe:webhook:refused")).toHaveLength(0);
      expect(filedMalformed()).toHaveLength(1);
      expect((filedMalformed()[0][1] as Error).message).toBe("malformed signature or body");
      expect(filedMalformed()[0][2]).toEqual({ secretsTried: 1, bodyChars: BODY.length, sigShape: "no v1" });
    });

    it("a body that is not a Stripe event — not JSON, no object 'event', or no evt_ id: sigShape 'not an event'", async () => {
      for (const body of ["<html>scanner</html>", '{"id":"evt_x"}', '{"id":"x","object":"event"}', '{"object":"event"}', "[]", "null"]) {
        vi.mocked(reportErrorAwaited).mockClear();
        vi.mocked(reportBlockerAwaited).mockClear();
        const res = await call({ "stripe-signature": "t=1700000000,v1=deadbeef" }, body);
        expect(res.status, body).toBe(400);
        expect(filed(), body).toHaveLength(0);
        expect(filedMalformed(), body).toHaveLength(1);
        expect(filedMalformed()[0][2], body).toEqual({ secretsTried: 1, bodyChars: body.length, sigShape: "not an event" });
      }
    });

    it("the malformed row never carries the body, the signature or the secret", async () => {
      await call({ "stripe-signature": "t=1700000000,v1=deadbeef" }, '{"id":"evt_secret","object":"thing"}');
      const words = JSON.stringify(filedMalformed()[0]);
      expect(words).not.toContain("whsec_test");
      expect(words).not.toContain("deadbeef");
      expect(words).not.toContain("evt_secret");
    });

    it("the 503 config refusals stay blockers whatever the request's shape", async () => {
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
      vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
      const res = await call({ "stripe-signature": "garbage" }, "<html>");
      expect(res.status).toBe(503);
      expect(filed()).toHaveLength(1);
      expect(filedMalformed()).toHaveLength(0);
    });
  });

  it("no stripe-signature header at all: 400 and NOT filed (not Stripe; scanner noise)", async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    expect(filed()).toHaveLength(0);
    expect(filedLoose()).toHaveLength(0);
  });

  it("no signing secret configured on the server: 503, and the row says so", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
    const res = await call({ "stripe-signature": "t=1,v1=x" });
    expect(res.status).toBe(503);
    expect(filed()).toHaveLength(1);
    expect((filed()[0][1] as Error).message).toBe("no webhook secret configured");
    expect(filed()[0][2]).toEqual({ secretsTried: 0 });
  });

  it("no Stripe secret key on the server: 503 and its own row, never a row that blames the signature", async () => {
    state.noKey = true;
    const res = await call({ "stripe-signature": "t=1,v1=x" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("STRIPE_SECRET_KEY");
    expect(filed()).toHaveLength(1);
    expect((filed()[0][1] as Error).message).toBe("no Stripe secret key configured");
  });

  it("a good signature files nothing under that name", async () => {
    state.event = { id: "evt_ok", type: "charge.refunded", account: ACCT, data: { object: {} } };
    const res = await call({ "stripe-signature": "t=1,v1=x" });
    expect(res.status).toBe(200);
    expect(filed()).toHaveLength(0);
  });
});

/**
 * THE COMPANY'S OWN BILLING (cn-v1137, 0400). A declined card is told ONCE per unpaid period, to the
 * owner and admins under the `billing` kind, behind the stamp claim_billing_notice writes first —
 * Stripe's Smart Retries fire the same event again and claim nothing, push nothing. A late delete of
 * a subscription that is no longer the company's current one is skipped and filed, never applied
 * over a paying company. A sync that lands the company active hands the `lapsed` key back, so the
 * next lapse is told.
 */
describe("the company's own billing (cn-v1137)", () => {
  const PERIOD_END = 1_800_000_000; // seconds; the item's current_period_end
  const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: "sub_1",
    status: "past_due",
    customer: "cus_1",
    metadata: {},
    items: { data: [{ price: { id: "price_crew", nickname: "crew" }, current_period_end: PERIOD_END }] },
    ...over,
  });
  const billingTables = () => ({
    organizations: [{ id: ORG, stripe_account_id: ACCT, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", subscription_status: "active" }],
    profiles: [
      { id: "owner-1", org_id: ORG, role: "owner", active: true },
      { id: "admin-1", org_id: ORG, role: "admin", active: true },
      { id: "office-1", org_id: ORG, role: "office", active: true },
      { id: "tech-1", org_id: ORG, role: "tech", active: true },
      { id: "gone-owner", org_id: ORG, role: "owner", active: false },
      { id: "owner-elsewhere", org_id: "org-thistlewood", role: "owner", active: true },
    ],
    notifications: [] as any[],
  });
  /** The stamps (0400) as a set: a key claimed once answers false after; releasing drops it. */
  let stamps: Set<string>;
  let rpcs: [string, any][];
  let rpcError: { message: string } | null;
  const org = () => state.db.tables.organizations[0];
  const ourEvent = (type: string, obj: any, id: string) => deliver(type, obj, id, null as any);

  beforeEach(() => {
    state.db = fakeDb(billingTables());
    state.pushes = [];
    stamps = new Set();
    rpcs = [];
    rpcError = null;
    state.db.rpc = vi.fn(async (fn: string, args: any) => {
      rpcs.push([fn, args]);
      if (rpcError) return { data: null, error: rpcError };
      const k = `${args.p_org}:${args.p_key}`;
      if (fn === "claim_billing_notice") {
        if (stamps.has(k)) return { data: false, error: null };
        stamps.add(k);
        return { data: true, error: null };
      }
      if (fn === "release_billing_notice") return { data: stamps.delete(k), error: null };
      return { data: null, error: { message: `unknown function ${fn}` } };
    });
    state.subscription = subscription();
    vi.mocked(reportError).mockClear();
  });

  it("a declined card: the state is mirrored, past_due:<period_end> is claimed, and ONE push under billing to the active owner and admins only", async () => {
    expect((await ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf1")).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "past_due", stripe_subscription_id: "sub_1", current_period_end: PERIOD_END_ISO });
    expect(rpcs).toEqual([["claim_billing_notice", { p_org: ORG, p_key: `past_due:${PERIOD_END_ISO}` }]]);
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0]).toEqual([
      ["owner-1", "admin-1"],
      "billing",
      { title: "Your Card Was Declined", body: "Update the card in Settings › Getting Paid › Manage Billing. The crew keeps working for now.", url: "/settings?tab=getpaid" },
    ]);
    // The bell records it, for the same two people, under the same kind.
    const lines = state.db.tables.notifications as any[];
    expect(lines.map((l) => [l.user_id, l.type, l.title])).toEqual([
      ["owner-1", "billing", "Your Card Was Declined"],
      ["admin-1", "billing", "Your Card Was Declined"],
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("Stripe's retry of the decline (a second payment_failed for the same period): the claim answers false, nothing is pushed, nothing is written to the bell", async () => {
    await ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf1");
    await ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf2");
    expect(rpcs.filter(([fn]) => fn === "claim_billing_notice")).toHaveLength(2);
    expect(state.pushes).toHaveLength(1);
    expect(state.db.tables.notifications).toHaveLength(2);
    // The next period's decline is its own key, and is told.
    state.subscription = subscription({ items: { data: [{ price: { id: "price_crew" }, current_period_end: PERIOD_END + 30 * 86_400 }] } });
    await ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf3");
    expect(rpcs.at(-1)).toEqual(["claim_billing_notice", { p_org: ORG, p_key: `past_due:${new Date((PERIOD_END + 30 * 86_400) * 1000).toISOString()}` }]);
    expect(state.pushes).toHaveLength(2);
  });

  it("a claim that could not be read: 500 so Stripe retries (the sync is idempotent), nothing pushed", async () => {
    rpcError = { message: "function claim_billing_notice does not exist" };
    await expect(ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf1")).rejects.toThrow(/claim_billing_notice past_due:.* failed/);
    expect(state.pushes).toHaveLength(0);
  });

  it("a decline on a connected account (a contractor's own customer) is not our billing: nothing claimed, nothing pushed", async () => {
    await deliver("invoice.payment_failed", { subscription: "sub_x", customer: "cus_x" }, "evt_pf_connect");
    expect(rpcs).toEqual([]);
    expect(state.pushes).toHaveLength(0);
  });

  describe("customer.subscription.deleted", () => {
    it("for a subscription that is NOT the company's current one: skipped and filed, the company stays active", async () => {
      org().stripe_subscription_id = "sub_2"; // the company re-subscribed; sub_1 is history
      expect((await ourEvent("customer.subscription.deleted", subscription({ status: "canceled", metadata: { org_id: ORG } }), "evt_del_old")).status).toBe(200);
      expect(org()).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_2" });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith("stripe:webhook:stale-subscription-event", expect.any(Error), { orgId: ORG, eventSub: "sub_1", storedSub: "sub_2" });
      expect(rpcs).toEqual([]);
    });

    it("the same, matched by the customer when the event carries no org_id", async () => {
      org().stripe_subscription_id = "sub_2";
      await ourEvent("customer.subscription.deleted", subscription({ status: "canceled" }), "evt_del_old");
      expect(org().subscription_status).toBe("active");
      expect(reportError).toHaveBeenCalledWith("stripe:webhook:stale-subscription-event", expect.any(Error), { orgId: ORG, eventSub: "sub_1", storedSub: "sub_2" });
    });

    it("for the company's current subscription: applied, the company is canceled", async () => {
      await ourEvent("customer.subscription.deleted", subscription({ status: "canceled", metadata: { org_id: ORG } }), "evt_del");
      expect(org()).toMatchObject({ subscription_status: "canceled", stripe_subscription_id: "sub_1" });
      expect(reportError).not.toHaveBeenCalled();
    });

    it("when no subscription is recorded yet: applied (there is nothing to be stale against)", async () => {
      org().stripe_subscription_id = null;
      await ourEvent("customer.subscription.deleted", subscription({ status: "canceled", metadata: { org_id: ORG } }), "evt_del");
      expect(org().subscription_status).toBe("canceled");
      expect(reportError).not.toHaveBeenCalled();
    });

    it("a read that failed: 500 so Stripe retries, nothing applied, nothing guessed", async () => {
      state.db.failing.add("organizations");
      await expect(ourEvent("customer.subscription.deleted", subscription({ status: "canceled", metadata: { org_id: ORG } }), "evt_del")).rejects.toThrow(/subscription read failed/);
      state.db.failing.delete("organizations");
      expect(org().subscription_status).toBe("active");
    });
  });

  /**
   * STRIPE DELIVERS OUT OF ORDER AND RETRIES FOR DAYS (skeptic #43, S5). A late `updated` for the
   * subscription a company canceled last month, landing after its new one is active, would have
   * written past_due or canceled over a paying company. Every sync — created, updated, and the one
   * payment_failed retrieves — applies only when the company holds no subscription, THIS one, or a
   * dead one (canceled / incomplete_expired); the rest are skipped and filed with both ids.
   */
  describe("a subscription that is not the company's current one (created / updated / payment_failed)", () => {
    it("a late `updated` for the old subscription after the new one is active: skipped, filed with both ids, nothing released", async () => {
      org().stripe_subscription_id = "sub_2";
      expect((await ourEvent("customer.subscription.updated", subscription({ status: "past_due", metadata: { org_id: ORG } }), "evt_up_old")).status).toBe(200);
      expect(org()).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_2" });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith("stripe:webhook:stale-subscription-event", expect.any(Error), {
        orgId: ORG,
        eventSub: "sub_1",
        storedSub: "sub_2",
        eventStatus: "past_due",
      });
      expect(rpcs).toEqual([]);
    });

    it("the same for a late `created`, and when the event is matched by the customer alone", async () => {
      org().stripe_subscription_id = "sub_2";
      await ourEvent("customer.subscription.created", subscription({ status: "active", metadata: { org_id: ORG } }), "evt_cr_old");
      await ourEvent("customer.subscription.updated", subscription({ status: "canceled" }), "evt_up_old_cus");
      expect(org()).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_2" });
      expect(reportError).toHaveBeenCalledTimes(2);
      expect(rpcs).toEqual([]);
    });

    it("the company's current subscription (the same id): applied", async () => {
      await ourEvent("customer.subscription.updated", subscription({ status: "past_due", metadata: { org_id: ORG } }), "evt_up");
      expect(org()).toMatchObject({ subscription_status: "past_due", stripe_subscription_id: "sub_1", current_period_end: PERIOD_END_ISO });
      expect(reportError).not.toHaveBeenCalled();
    });

    it("a stored canceled or incomplete_expired subscription lets a NEW id in (the company subscribed again)", async () => {
      for (const dead of ["canceled", "incomplete_expired"]) {
        org().stripe_subscription_id = "sub_1";
        org().subscription_status = dead;
        await ourEvent("customer.subscription.updated", subscription({ id: "sub_2", status: "active", metadata: { org_id: ORG } }), `evt_new_${dead}`);
        expect(org(), dead).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_2" });
      }
      expect(reportError).not.toHaveBeenCalled();
    });

    it("no subscription recorded yet: applied (nothing to be stale against)", async () => {
      org().stripe_subscription_id = null;
      org().subscription_status = "trialing";
      await ourEvent("customer.subscription.created", subscription({ status: "active", metadata: { org_id: ORG } }), "evt_first");
      expect(org()).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_1" });
      expect(reportError).not.toHaveBeenCalled();
    });

    it("a decline on the OLD subscription after the new one is active: not the company's card — nothing mirrored, claimed or pushed", async () => {
      org().stripe_subscription_id = "sub_2";
      expect((await ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf_old")).status).toBe(200);
      expect(org()).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_2" });
      expect(reportError).toHaveBeenCalledWith("stripe:webhook:stale-subscription-event", expect.any(Error), expect.objectContaining({ eventSub: "sub_1", storedSub: "sub_2" }));
      expect(rpcs).toEqual([]);
      expect(state.pushes).toHaveLength(0);
      expect(state.db.tables.notifications).toHaveLength(0);
    });

    it("the holders read failing: 500 so Stripe retries, nothing applied", async () => {
      state.db.failing.add("organizations");
      await expect(ourEvent("customer.subscription.updated", subscription({ status: "past_due", metadata: { org_id: ORG } }), "evt_up")).rejects.toThrow(/subscription read failed/);
      state.db.failing.delete("organizations");
      expect(org().subscription_status).toBe("active");
    });
  });

  /**
   * THE PEOPLE ARE READ BEFORE THE CLAIM (skeptic #43, N1): a read that threw after the claim had
   * stamped the period and lost the one notice for good. And a claim that answers nothing is a 500,
   * never a silent skip.
   */
  describe("the declined-card notice's order", () => {
    it("the owner and admins that could not be read: 500 with NO stamp, so Stripe's retry can still tell them", async () => {
      state.db.failing.add("profiles");
      await expect(ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf1")).rejects.toThrow(/the owner and admins could not be read/);
      state.db.failing.delete("profiles");
      expect(rpcs.filter(([fn]) => fn === "claim_billing_notice")).toEqual([]);
      expect(stamps.size).toBe(0);
      expect(state.pushes).toHaveLength(0);
      // The retry, with the read working, claims and tells them.
      expect((await ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf1")).status).toBe(200);
      expect(state.pushes).toHaveLength(1);
    });

    it("a claim that answers nothing (no boolean, no error) is a 500, never a notice and never a quiet skip", async () => {
      state.db.rpc = vi.fn(async () => ({ data: null, error: null }));
      await expect(ourEvent("invoice.payment_failed", { subscription: "sub_1", customer: "cus_1" }, "evt_pf1")).rejects.toThrow(/claim_billing_notice past_due:.* answered nothing/);
      expect(state.pushes).toHaveLength(0);
    });
  });

  describe("a sync that lands the company active releases the lapsed notice", () => {
    it("customer.subscription.updated to active: release_billing_notice(org, 'lapsed')", async () => {
      stamps.add(`${ORG}:lapsed`);
      await ourEvent("customer.subscription.updated", subscription({ status: "active", metadata: { org_id: ORG } }), "evt_up");
      expect(org().subscription_status).toBe("active");
      expect(rpcs).toEqual([["release_billing_notice", { p_org: ORG, p_key: "lapsed" }]]);
      expect(stamps.has(`${ORG}:lapsed`)).toBe(false);
    });

    it("a sync to past_due or canceled releases nothing", async () => {
      await ourEvent("customer.subscription.updated", subscription({ status: "past_due", metadata: { org_id: ORG } }), "evt_up");
      await ourEvent("customer.subscription.deleted", subscription({ status: "canceled", metadata: { org_id: ORG } }), "evt_del");
      expect(rpcs.filter(([fn]) => fn === "release_billing_notice")).toEqual([]);
    });

    it("a release that errored is filed and never fails the webhook", async () => {
      rpcError = { message: "permission denied for function release_billing_notice" };
      expect((await ourEvent("customer.subscription.updated", subscription({ status: "active", metadata: { org_id: ORG } }), "evt_up")).status).toBe(200);
      expect(org().subscription_status).toBe("active");
      expect(reportError).toHaveBeenCalledWith("stripe:webhook:release-lapsed", expect.objectContaining({ message: "permission denied for function release_billing_notice" }), { orgId: ORG, subscriptionId: "sub_1" });
    });

    it("a subscription that matched no company releases nothing, and says so as before", async () => {
      await ourEvent("customer.subscription.updated", subscription({ status: "active", customer: "cus_stranger" }), "evt_up");
      expect(rpcs).toEqual([]);
      expect(reportError).toHaveBeenCalledWith("stripe:webhook:subscription-no-org", expect.any(Error), expect.objectContaining({ subscriptionId: "sub_1" }));
    });
  });
});
