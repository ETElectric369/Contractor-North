import { describe, it, expect } from "vitest";
import { deleteCredit, withdrawCredit } from "./withdraw-credit";
import { fakeDb } from "@/test/fake-supabase";

/**
 * TAKE A CREDIT BACK, THEN DELETE IT IF IT SHOULD NEVER HAVE EXISTED. Take It Back returns an open
 * office credit from its invoice to the account (the money may be the customer's); Delete This Credit
 * removes one that is already off every invoice. Every write is pinned to the row as read and read
 * back by id.
 */
const credit = (over: Record<string, unknown> = {}) => ({
  id: "cr-1", amount: 165, disposition: "credit", status: "open", invoice_id: "inv-1", stripe_refund_id: null, ...over,
});

describe("withdrawCredit — back to the account", () => {
  it("takes the credit off its invoice (invoice_id null) and names the invoice to recompute; the money stays", async () => {
    const { sb, tables } = fakeDb({ customer_credits: [credit()] });
    expect(await withdrawCredit(sb, "cr-1")).toEqual({ ok: true, invoiceId: "inv-1", amount: 165 });
    expect(tables.customer_credits).toEqual([credit({ invoice_id: null })]);
  });

  it("refuses what is not its to move: closed, a refund, a card refund's record, already on the account, or nothing there", async () => {
    expect(await withdrawCredit(fakeDb({ customer_credits: [credit({ status: "resolved" })] }).sb, "cr-1")).toEqual({ ok: false, error: "That credit is already closed out." });
    expect((await withdrawCredit(fakeDb({ customer_credits: [credit({ disposition: "refund" })] }).sb, "cr-1")).ok).toBe(false);
    const card = fakeDb({ customer_credits: [credit({ stripe_refund_id: "re_1" })] });
    expect((await withdrawCredit(card.sb, "cr-1")).ok).toBe(false);
    expect(card.tables.customer_credits[0].invoice_id).toBe("inv-1");
    expect((await withdrawCredit(fakeDb({ customer_credits: [credit({ invoice_id: null })] }).sb, "cr-1")).ok).toBe(false);
    expect(await withdrawCredit(fakeDb({ customer_credits: [] }).sb, "cr-1")).toEqual({ ok: false, error: "Credit not found." });
  });
});

describe("deleteCredit — only once it is off every invoice", () => {
  it("deletes an open office credit that sits on the account, and reads the delete back", async () => {
    const { sb, tables } = fakeDb({ customer_credits: [credit({ invoice_id: null })] });
    expect(await deleteCredit(sb, "cr-1")).toEqual({ ok: true, amount: 165 });
    expect(tables.customer_credits).toEqual([]);
  });

  it("refuses a credit still on an invoice (Take It Back first), a refund, a card refund's record", async () => {
    const onBill = fakeDb({ customer_credits: [credit()] });
    expect(await deleteCredit(onBill.sb, "cr-1")).toEqual({ ok: false, error: "That credit is on an invoice — Take It Back first, then delete it." });
    expect(onBill.tables.customer_credits).toHaveLength(1);
    expect((await deleteCredit(fakeDb({ customer_credits: [credit({ invoice_id: null, disposition: "refund" })] }).sb, "cr-1")).ok).toBe(false);
    expect((await deleteCredit(fakeDb({ customer_credits: [credit({ invoice_id: null, stripe_refund_id: "re_1" })] }).sb, "cr-1")).ok).toBe(false);
  });
});
