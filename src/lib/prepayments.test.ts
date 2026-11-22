import { describe, it, expect } from "vitest";
import {
  allocatePrepaidCredit,
  isCreditSource,
  isPrepaymentKind,
  prepaidCreditDescription,
  prepaymentLabel,
  prepaymentStates,
  prepaymentsLeft,
  type PrepaidCreditRow,
  type PrepaymentBillRow,
} from "./prepayments";

/**
 * THE ARITHMETIC OF MONEY ASKED AHEAD (cn-v1177): where each payment request on a job stands, and what
 * one bill takes off. Tables, oldest request first. Stand-ins only (INV-900…).
 */
const req = (o: Partial<PrepaymentBillRow> & { id: string }): PrepaymentBillRow => ({
  invoice_number: o.id.toUpperCase(),
  status: "sent",
  title: "Deposit",
  created_at: "2026-11-01T10:00:00Z",
  amount: 1000,
  amount_paid: 0,
  refunded: 0,
  ...o,
});
const credit = (bill: string, status: string, request: string, amount: number): PrepaidCreditRow => ({
  invoice_id: bill,
  invoice_status: status,
  prepaid_invoice_id: request,
  amount,
});

describe("prepaymentStates", () => {
  it("a request asks for its lines; nothing taken yet leaves all of it, and the money in hand is what was paid", () => {
    const [s] = prepaymentStates([req({ id: "inv-900", amount_paid: 1000 })], []);
    expect(s).toMatchObject({ id: "inv-900", number: "INV-900", label: "Deposit", amount: 1000, paid: 1000, takenTotal: 0, left: 1000, moneyLeft: 1000 });
  });

  const table: { why: string; bills: PrepaymentBillRow[]; credits: PrepaidCreditRow[]; except?: string; left: number[]; moneyLeft: number[] }[] = [
    { why: "a sent bill took 400 off", bills: [req({ id: "r1", amount_paid: 1000 })], credits: [credit("b1", "sent", "r1", -400)], left: [600], moneyLeft: [600] },
    { why: "a DRAFT's credit counts too (two drafts never take the same dollar)", bills: [req({ id: "r1" })], credits: [credit("b1", "draft", "r1", -400)], left: [600], moneyLeft: [0] },
    { why: "…except the draft being resolved right now", bills: [req({ id: "r1" })], credits: [credit("b1", "draft", "r1", -400)], except: "b1", left: [1000], moneyLeft: [0] },
    { why: "a void bill took nothing", bills: [req({ id: "r1" })], credits: [credit("b1", "void", "r1", -400)], left: [1000], moneyLeft: [0] },
    { why: "a refund comes off what is left and off the money in hand", bills: [req({ id: "r1", amount_paid: 1000, refunded: 250 })], credits: [], left: [750], moneyLeft: [750] },
    { why: "taken in full: nothing left, never below zero", bills: [req({ id: "r1", amount_paid: 300 })], credits: [credit("b1", "sent", "r1", -1000), credit("b2", "draft", "r1", -50)], left: [0], moneyLeft: [0] },
    { why: "an unpaid request still comes off (the two add up)", bills: [req({ id: "r1", amount_paid: 0 })], credits: [credit("b1", "paid", "r1", -1000)], left: [0], moneyLeft: [0] },
  ];
  for (const t of table) {
    it(t.why, () => {
      const states = prepaymentStates(t.bills, t.credits, t.except);
      expect(states.map((s) => s.left)).toEqual(t.left);
      expect(states.map((s) => s.moneyLeft)).toEqual(t.moneyLeft);
    });
  }

  it("a void or draft request asks for nothing and is not listed; the rest come oldest first", () => {
    const states = prepaymentStates(
      [
        req({ id: "late", created_at: "2026-11-05T00:00:00Z" }),
        req({ id: "gone", status: "void" }),
        req({ id: "unborn", status: "draft" }),
        req({ id: "early", created_at: "2026-11-02T00:00:00Z" }),
      ],
      [],
    );
    expect(states.map((s) => s.id)).toEqual(["early", "late"]);
    expect(prepaymentsLeft(states)).toBe(2000);
  });

  it("says which bills took how much, one entry per bill", () => {
    const [s] = prepaymentStates([req({ id: "r1" })], [credit("b1", "sent", "r1", -300), credit("b2", "draft", "r1", -200)]);
    expect(s.taken).toEqual([
      { invoiceId: "b1", amount: 300 },
      { invoiceId: "b2", amount: 200 },
    ]);
    expect(s.takenTotal).toBe(500);
  });
});

describe("allocatePrepaidCredit — what ONE bill takes off", () => {
  const states = prepaymentStates(
    [req({ id: "r1", amount: 1000, created_at: "2026-11-01T00:00:00Z" }), req({ id: "r2", amount: 500, created_at: "2026-11-03T00:00:00Z", title: "Materials Payment" })],
    [],
  );
  const table: { why: string; base: number; want: { prepaidInvoiceId: string; amount: number }[] }[] = [
    { why: "a bill bigger than both takes both, oldest first", base: 2000, want: [{ prepaidInvoiceId: "r1", amount: 1000 }, { prepaidInvoiceId: "r2", amount: 500 }] },
    { why: "a bill between them takes the oldest whole and the rest of the next", base: 1200, want: [{ prepaidInvoiceId: "r1", amount: 1000 }, { prepaidInvoiceId: "r2", amount: 200 }] },
    { why: "a small bill takes only what fits: never below zero", base: 300, want: [{ prepaidInvoiceId: "r1", amount: 300 }] },
    { why: "a bill with nothing on it takes nothing", base: 0, want: [] },
    { why: "a bill whose lines sum below zero takes nothing", base: -50, want: [] },
  ];
  for (const t of table) {
    it(t.why, () => {
      expect(allocatePrepaidCredit(states, t.base).map(({ prepaidInvoiceId, amount }) => ({ prepaidInvoiceId, amount }))).toEqual(t.want);
    });
  }
  it("never more than the bill, whatever is left", () => {
    for (const base of [0.01, 1, 999.99, 1000, 1499.99, 1500, 10_000]) {
      const got = allocatePrepaidCredit(states, base).reduce((s, x) => s + x.amount, 0);
      expect(Math.round(got * 100) / 100).toBe(Math.min(base, 1500));
    }
  });
});

describe("the words and the kinds", () => {
  it("names a request and the line that takes it off, in English (the customer reads it)", () => {
    expect(prepaymentLabel("deposit")).toBe("Deposit");
    expect(prepaymentLabel("materials")).toBe("Materials Payment");
    expect(prepaymentLabel("other", "  Panel   upgrade ")).toBe("Panel upgrade");
    expect(prepaymentLabel("other", "")).toBe("Payment");
    expect(prepaidCreditDescription("Deposit", "INV-900")).toBe("Less deposit (INV-900)");
    expect(prepaidCreditDescription("Materials Payment", "INV-901")).toBe("Less materials payment (INV-901)");
    expect(prepaidCreditDescription("Panel upgrade", null)).toBe("Less Panel upgrade");
  });
  it("a credit line is either pool's; a request is its own kind", () => {
    expect(isCreditSource("draw_credit")).toBe(true);
    expect(isCreditSource("prepaid_credit")).toBe(true);
    expect(isCreditSource("prepayment")).toBe(false);
    expect(isCreditSource(null)).toBe(false);
    expect(isPrepaymentKind("prepayment")).toBe(true);
    expect(isPrepaymentKind("deposit")).toBe(false);
  });
});
