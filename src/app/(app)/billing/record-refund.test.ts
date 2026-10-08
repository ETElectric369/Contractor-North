import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";

/**
 * RECORD THIS REFUND (item C, 2026-10-07), without Stripe or a database: the amount comes from
 * Stripe on the company's own connected account, capped at the invoice's payment; one row per
 * charge, raised when Stripe's total grows; a charge on no payment of this invoice records nothing.
 * Made-up figures.
 */
const state = vi.hoisted(() => ({ client: null as any, charges: {} as Record<string, any>, retrieves: [] as any[] }));

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/server", () => ({ after: vi.fn((fn: any) => fn?.()) }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => true), notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => []), orgStaffIds: vi.fn(async () => []), orgStaffIdsOrThrow: vi.fn(async () => []) }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    charges: {
      retrieve: vi.fn(async (id: string, _p: unknown, opts: { stripeAccount?: string }) => {
        state.retrieves.push([id, opts]);
        const c = state.charges[id];
        if (!c) throw new Error("No such charge");
        return c;
      }),
    },
  }),
  billingEnabled: () => true,
}));

import { recordStripeRefund } from "./actions";

const tables = () => ({
  organizations: [{ id: "org-1", stripe_account_id: "acct_et" }],
  invoices: [{ id: "inv-78", org_id: "org-1", invoice_number: "INV-078", customer_id: "cust-1", status: "paid", total: 100, amount_paid: 100 }],
  payments: [{ id: "pay-1", org_id: "org-1", invoice_id: "inv-78", amount: 100, stripe_payment_intent: "pi_card" }],
  customer_credits: [] as any[],
});

describe("recordStripeRefund", () => {
  beforeEach(() => {
    state.client = fakeDb(tables());
    state.charges = { ch_1: { id: "ch_1", payment_intent: "pi_card", amount_refunded: 2500 } };
    state.retrieves = [];
  });

  it("records the refund once, from Stripe's figure on the company's own account, resolved, carrying the charge", async () => {
    const res = await recordStripeRefund({ invoiceId: "inv-78", chargeId: "ch_1" });
    expect(res).toMatchObject({ ok: true, amount: 25 });
    expect(res.message).toBe("Recorded: $25.00 refunded on INV-078. The invoice stays paid; Collected comes down by it.");
    expect(state.retrieves).toEqual([["ch_1", { stripeAccount: "acct_et" }]]);
    expect(state.client.tables.customer_credits).toEqual([
      expect.objectContaining({ invoice_id: "inv-78", customer_id: "cust-1", amount: 25, disposition: "refund", status: "resolved", stripe_refund_id: "ch_1", note: "Refunded in Stripe (ch_1)", created_by: "user-1" }),
    ]);
    // The invoice is not rewritten: it stays paid.
    expect(state.client.tables.invoices[0]).toMatchObject({ status: "paid", amount_paid: 100 });
    // A second tap, the notice opened again: the same one row.
    const again = await recordStripeRefund({ invoiceId: "inv-78", chargeId: "ch_1" });
    expect(again).toMatchObject({ ok: true, amount: 25 });
    expect(again.message).toBe("Already recorded: $25.00 refunded on INV-078.");
    expect(state.client.tables.customer_credits).toHaveLength(1);
  });

  it("a later, larger refund of the same charge raises the one row; the card fee never counts (capped at the payment)", async () => {
    await recordStripeRefund({ invoiceId: "inv-78", chargeId: "ch_1" });
    // Stripe's refunded total is cumulative: now the whole $100 plus the $3.20 card fee.
    state.charges.ch_1.amount_refunded = 10320;
    const res = await recordStripeRefund({ invoiceId: "inv-78", chargeId: "ch_1" });
    expect(res).toMatchObject({ ok: true, amount: 100 });
    expect(res.message).toContain("Updated: $100.00 refunded on INV-078 now (it was $25.00)");
    expect(state.client.tables.customer_credits).toEqual([expect.objectContaining({ amount: 100, stripe_refund_id: "ch_1" })]);
  });

  it("a charge that paid no payment on this invoice, a charge Stripe can't find, or no charge id at all: nothing is written", async () => {
    state.charges.ch_other = { id: "ch_other", payment_intent: "pi_theirs", amount_refunded: 2500 };
    expect(await recordStripeRefund({ invoiceId: "inv-78", chargeId: "ch_other" })).toMatchObject({ ok: false, error: "That Stripe charge isn't a payment on INV-078, so nothing was recorded." });
    expect((await recordStripeRefund({ invoiceId: "inv-78", chargeId: "ch_missing" })).ok).toBe(false);
    expect((await recordStripeRefund({ invoiceId: "inv-78", chargeId: "evt_1" })).ok).toBe(false);
    expect((await recordStripeRefund({ invoiceId: "inv-nope", chargeId: "ch_1" })).ok).toBe(false);
    state.charges.ch_1.amount_refunded = 0;
    expect((await recordStripeRefund({ invoiceId: "inv-78", chargeId: "ch_1" })).ok).toBe(false);
    expect(state.client.tables.customer_credits).toHaveLength(0);
  });

  it("the migration adds the charge column and one row per charge per company, and the notice's button and the page's banner exist", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((f) => f.startsWith("0384_"))!;
    const sql = readFileSync(join(dir, file), "utf8");
    expect(sql).toContain("add column if not exists stripe_refund_id text");
    expect(sql).toMatch(/create unique index if not exists customer_credits_one_per_stripe_refund\s+on public\.customer_credits \(org_id, stripe_refund_id\)\s+where stripe_refund_id is not null/);
    const page = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/page.tsx"), "utf8");
    expect(page).toContain("<RecordRefundButton invoiceId={inv.id} chargeId={refund.chargeId} />");
    expect(page).toContain("This Stripe refund is already recorded");
    const button = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/record-refund-button.tsx"), "utf8");
    expect(button).toContain("Record This Refund");
    expect(button).toContain("min-h-11");
  });
});
