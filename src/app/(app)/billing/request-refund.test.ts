import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * A REFUND ON A PAYMENT REQUEST (cn-v1177, skeptic #80, F9). What a later bill took off a request is
 * already counted on that bill, so a refund by hand gives back only the money no bill has used
 * (moneyLeft), and says which bill took the rest. A refund Stripe already made is a fact: recorded as it
 * is, with one warning line when it is more than that. Either way the job's drafts are resolved again.
 * On the small in-memory database. Stand-ins only.
 */
const state = vi.hoisted(() => ({ client: null as any, refundedCents: 0 }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-larkspur", role: "owner" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ charges: { retrieve: vi.fn(async () => ({ payment_intent: "pi_900", amount_refunded: state.refundedCents })) } }),
}));

import { createCustomerCredit, recordStripeRefund } from "./actions";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];

const inv = (id: string, o: Row): Row => ({ id, org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "standard", title: "Larkspur panel", invoice_number: id.toUpperCase(), tax_rate: 0, amount_paid: 0, ...o });
const item = (invoice_id: string, unit_price: number, o: Row = {}): Row => ({ id: `${invoice_id}-${o.import_source ?? "work"}`, org_id: ORG, invoice_id, description: "Labor", quantity: 1, unit_price, line_total: unit_price, import_source: null, prepaid_invoice_id: null, sort_order: 0, ...o });
const credits = (id: string) => db.invoice_items.filter((l) => l.invoice_id === id && l.import_source === "prepaid_credit").map((l) => [l.line_total, l.prepaid_invoice_id]);

beforeEach(() => {
  writes = [];
  state.refundedCents = 0;
  db = {
    jobs: [{ id: JOB, org_id: ORG, status: "in_progress", customer_id: "cust-1" }],
    organizations: [{ id: ORG, settings: {}, stripe_account_id: "acct_larkspur" }],
    invoices: [
      inv("inv-900", { invoice_kind: "prepayment", status: "paid", title: "Deposit", total: 1000, subtotal: 1000, amount_paid: 1000, created_at: "2026-10-01T00:00:00Z" }),
      // INV-901 went out and took $600 of it off.
      inv("inv-901", { status: "sent", total: 0, subtotal: 0, created_at: "2026-10-02T00:00:00Z" }),
      // INV-902, a draft, holds the other $400.
      inv("inv-902", { status: "draft", total: 600, subtotal: 600, created_at: "2026-10-03T00:00:00Z" }),
    ],
    invoice_items: [
      item("inv-900", 1000, { import_source: "prepayment", description: "Deposit" }),
      item("inv-901", 600),
      item("inv-901", -600, { import_source: "prepaid_credit", prepaid_invoice_id: "inv-900", description: "Less deposit (INV-900)" }),
      item("inv-902", 1000),
      item("inv-902", -400, { import_source: "prepaid_credit", prepaid_invoice_id: "inv-900", description: "Less deposit (INV-900)" }),
    ],
    customer_credits: [],
    payments: [{ id: "pay-1", org_id: ORG, invoice_id: "inv-900", amount: 1000, stripe_payment_intent: "pi_900" }],
  };
  state.client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

describe("a refund by hand on a payment request", () => {
  /**
   * RE-PINNED ON PURPOSE (cn-v1178, audit D3). This case used to say "the draft's hold counts too", and
   * so a customer who cancelled after paying a deposit could not be refunded while a DRAFT bill on the
   * job derived a credit from it, with no way through named. A draft's credit line is derived, not
   * money used: only a bill that WENT OUT took anything, and the resync this door runs after the refund
   * shrinks the draft's line to what the request has left.
   */
  it("is refused above what no SENT bill has used, naming only the bill that went out", async () => {
    // INV-901 went out and took 600; the open draft INV-902's 400 is not money used.
    const res = await createCustomerCredit("inv-900", 500, "refund");
    expect(res).toEqual({ ok: false, error: "Only $400.00 of INV-900 can still be given back, because INV-901 took $600.00 of it off." });
    expect(db.customer_credits).toEqual([]);
  });

  it("a paid deposit with a draft holding it can be refunded, and the draft's line then comes off (D3)", async () => {
    expect(await createCustomerCredit("inv-900", 400, "refund")).toEqual({ ok: true });
    expect(db.customer_credits.map((c) => [c.invoice_id, c.amount, c.disposition])).toEqual([["inv-900", 400, "refund"]]);
    // The resync resolved INV-902 again: the request has nothing left to come off.
    expect(credits("inv-902")).toEqual([]);
    expect(db.invoices.find((i) => i.id === "inv-902")!.total).toBe(1000);
  });

  it("within what is left it is recorded, and the job's drafts are resolved again", async () => {
    // The draft lets go of its hold (say it was voided), so $400 is free.
    db.invoices.find((i) => i.id === "inv-902")!.status = "void";
    expect(await createCustomerCredit("inv-900", 400, "refund")).toEqual({ ok: true });
    expect(db.customer_credits.map((c) => [c.invoice_id, c.amount, c.disposition])).toEqual([["inv-900", 400, "refund"]]);
    // A refund above what is left is refused, with the one bill named.
    expect((await createCustomerCredit("inv-900", 1, "refund")).error).toBe("Only $0.00 of INV-900 can still be given back, because INV-901 took $600.00 of it off.");
  });

  it("a plain credit, or a refund on an ordinary bill, is not checked against requests", async () => {
    expect(await createCustomerCredit("inv-901", 50, "refund")).toEqual({ ok: true });
  });
});

describe("a refund Stripe already made, on a payment request", () => {
  it("is recorded as the fact it is, with one warning line naming the bill that still shows the money taken off", async () => {
    db.invoices.find((i) => i.id === "inv-902")!.status = "void";
    state.refundedCents = 100000;
    const res = await recordStripeRefund({ invoiceId: "inv-900", chargeId: "ch_900" });
    expect(res.ok).toBe(true);
    expect(db.customer_credits.map((c) => [c.amount, c.disposition, c.stripe_refund_id])).toEqual([[1000, "refund", "ch_900"]]);
    expect(res.message).toBe(
      "Recorded: $1,000.00 refunded on INV-900. The invoice stays paid; Collected comes down by it. Warning: that is more than the $400.00 no bill had used; INV-901 still shows $600.00 of INV-900 taken off.",
    );
  });

  it("after it, the job's open draft takes off only what the request still has left (here nothing)", async () => {
    // The draft INV-902 holds $400; Stripe gave the whole $1,000 back.
    state.refundedCents = 100000;
    const res = await recordStripeRefund({ invoiceId: "inv-900", chargeId: "ch_900" });
    expect(res.ok).toBe(true);
    // Re-pinned (cn-v1178, D3): the draft's hold is not money used, so only INV-901, which went out, is named.
    expect(res.message).toContain("Warning: that is more than the $400.00 no bill had used; INV-901 still shows $600.00 of INV-900 taken off.");
    expect(credits("inv-902")).toEqual([]);
    expect(db.invoices.find((i) => i.id === "inv-902")!.total).toBe(1000);
  });

  it("within what no bill used: recorded, no warning", async () => {
    db.invoices.find((i) => i.id === "inv-902")!.status = "void";
    state.refundedCents = 30000;
    const res = await recordStripeRefund({ invoiceId: "inv-900", chargeId: "ch_900" });
    expect(res.message).toBe("Recorded: $300.00 refunded on INV-900. The invoice stays paid; Collected comes down by it.");
  });
});
