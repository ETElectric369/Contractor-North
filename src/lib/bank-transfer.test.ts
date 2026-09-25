import { describe, it, expect } from "vitest";
import {
  checkoutPaymentMethod,
  isBankCheckout,
  noteTransferStarted,
  pendingTransfers,
  resolveTransfer,
  staleTransfers,
  transferOnItsWaySentence,
} from "@/lib/bank-transfer";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";

const ORG = "org-et";
const OTHER = "org-tahoe";
const start = { orgId: ORG, invoiceId: "inv-78", paymentIntent: "pi_bank", checkoutSession: "cs_1", amount: 2830.89 };

describe("which Checkout is a bank debit (audit v994 BK2)", () => {
  it("reads the method Stripe charged by, then the door's own stamp", () => {
    expect(isBankCheckout({ payment_method_types: ["us_bank_account"] })).toBe(true);
    expect(isBankCheckout({ payment_method_types: ["card"], metadata: { pay_method: "bank" } })).toBe(false);
    expect(isBankCheckout({ payment_method_types: [], metadata: { pay_method: "bank" } })).toBe(true);
    expect(isBankCheckout({ metadata: { pay_method: "card" } })).toBe(false);
    expect(checkoutPaymentMethod({ payment_method_types: ["us_bank_account"] })).toBe("ach");
    expect(checkoutPaymentMethod({ payment_method_types: ["card"] })).toBe("card");
  });
});

describe("the pending marker (audit v994 BK3, 0338)", () => {
  it("a debit that starts is noted once; a retried event is known, not noted again", async () => {
    const db = fakeDb({ payments: [], pending_bank_transfers: [] });
    expect((await noteTransferStarted(db, start)).outcome).toBe("noted");
    expect((await noteTransferStarted(db, start)).outcome).toBe("known");
    expect(db.tables.pending_bank_transfers).toHaveLength(1);
    expect(db.tables.pending_bank_transfers[0]).toMatchObject({ org_id: ORG, invoice_id: "inv-78", status: "pending", amount: 2830.89 });
  });

  it("a debit whose money already landed (the success arrived first) is never marked pending", async () => {
    const db = fakeDb({ payments: [{ id: "p1", org_id: ORG, stripe_payment_intent: "pi_bank" }], pending_bank_transfers: [] });
    expect((await noteTransferStarted(db, start)).outcome).toBe("already_paid");
    expect(db.tables.pending_bank_transfers).toHaveLength(0);
  });

  it("clearing moves the pending row once; a retry changes nothing", async () => {
    const db = fakeDb({ payments: [], pending_bank_transfers: [] });
    await noteTransferStarted(db, start);
    expect((await resolveTransfer(db, { ...start, status: "cleared" })).outcome).toBe("resolved");
    expect((await resolveTransfer(db, { ...start, status: "cleared" })).outcome).toBe("already");
    expect(db.tables.pending_bank_transfers[0]).toMatchObject({ status: "cleared" });
    expect(db.tables.pending_bank_transfers[0].resolved_at).toBeTruthy();
    // A failure arriving after it cleared cannot un-clear it.
    expect((await resolveTransfer(db, { ...start, status: "failed" })).outcome).toBe("already");
    expect(db.tables.pending_bank_transfers[0].status).toBe("cleared");
  });

  it("an end that arrives before its start is written already resolved, so the late start stays quiet", async () => {
    const db = fakeDb({ payments: [], pending_bank_transfers: [] });
    expect((await resolveTransfer(db, { ...start, status: "failed" })).outcome).toBe("recorded");
    expect((await noteTransferStarted(db, start)).outcome).toBe("known");
    const { byInvoice } = await pendingTransfers(db, ORG, ["inv-78"]);
    expect(byInvoice.size).toBe(0);
  });

  it("the one read is org-scoped and pending-only", async () => {
    const db = fakeDb({
      pending_bank_transfers: [
        { id: "a", org_id: ORG, invoice_id: "inv-78", amount: 100, status: "pending", started_at: "2026-09-20T18:00:00Z" },
        { id: "b", org_id: ORG, invoice_id: "inv-78", amount: 50, status: "failed", started_at: "2026-09-19T18:00:00Z" },
        { id: "c", org_id: OTHER, invoice_id: "inv-78", amount: 999, status: "pending", started_at: "2026-09-20T18:00:00Z" },
      ],
    });
    const { byInvoice, problem } = await pendingTransfers(db, ORG, ["inv-78"]);
    expect(problem).toBeNull();
    expect(byInvoice.get("inv-78")!.map((t) => t.id)).toEqual(["a"]);
    expect(transferOnItsWaySentence(byInvoice.get("inv-78")!, "America/Los_Angeles")).toBe(
      "A $100.00 bank transfer started Sep 20, 2026 is on its way.",
    );
  });

  it("a database before 0338 has nothing on its way, and says no problem", async () => {
    const db = fakeDb({}, { missing: ["pending_bank_transfers"] });
    expect(await pendingTransfers(db, ORG, ["inv-78"])).toEqual({ byInvoice: new Map(), problem: null });
    expect((await noteTransferStarted(db, start)).outcome).toBe("no_table");
    expect((await staleTransfers(db)).rows).toEqual([]);
  });

  it("a debit pending more than a week, not yet said, is stale", async () => {
    const db = fakeDb({
      pending_bank_transfers: [
        { id: "old", org_id: ORG, invoice_id: "i1", amount: 10, status: "pending", started_at: "2026-09-10T18:00:00Z", stale_alerted_at: null },
        { id: "said", org_id: ORG, invoice_id: "i2", amount: 10, status: "pending", started_at: "2026-09-10T18:00:00Z", stale_alerted_at: "2026-09-18T15:00:00Z" },
        { id: "new", org_id: ORG, invoice_id: "i3", amount: 10, status: "pending", started_at: "2026-09-22T18:00:00Z", stale_alerted_at: null },
        { id: "done", org_id: ORG, invoice_id: "i4", amount: 10, status: "cleared", started_at: "2026-09-01T18:00:00Z", stale_alerted_at: null },
      ],
    });
    const { rows } = await staleTransfers(db, new Date("2026-09-25T15:00:00Z"));
    expect(rows.map((r) => r.id)).toEqual(["old"]);
  });
});
