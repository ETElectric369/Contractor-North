import { describe, it, expect } from "vitest";
import { openPurchasesOf, planPaymentAllocation, type OpenPurchase } from "./payment-allocation";

const purchase = (rootId: string, open: number, date: string, discount = 0, members?: OpenPurchase["members"]): OpenPurchase => ({
  rootId,
  label: rootId,
  date,
  open,
  members: members ?? [{ billId: rootId, open }],
  discount,
});

describe("openPurchasesOf: a bill and its corrections are one purchase, oldest first", () => {
  it("nets the members, lists only what is open, and sorts undated last", () => {
    const out = openPurchasesOf(
      [
        { id: "o1", amount: 613.19, amountPaid: 0, billDate: "2001-09-29", createdAt: "2001-09-29T01" },
        { id: "c1", amount: 95.99, amountPaid: 0, billDate: "2001-10-01", correctsBillId: "o1" },
        { id: "paid", amount: 100, amountPaid: 100, billDate: "2001-08-01" },
        { id: "credit", amount: -20, amountPaid: 0, billDate: "2001-08-02" },
        { id: "part", amount: 523.47, amountPaid: 200, billDate: "2001-06-25" },
        { id: "undated", amount: 10, amountPaid: 0, billDate: null },
        { id: "o2", amount: 100, amountPaid: 100, billDate: "2001-07-01" },
        { id: "c2", amount: -30, amountPaid: 0, billDate: "2001-07-02", correctsBillId: "o2" },
      ],
      (root, kids) => (kids.length ? `${root.id} corrected by ${kids.map((k) => k.id).join(", ")}` : root.id),
    );
    expect(out.map((p) => [p.rootId, p.open, p.label])).toEqual([
      ["part", 323.47, "part"],
      ["o1", 709.18, "o1 corrected by c1"],
      ["undated", 10, "undated"],
    ]);
    expect(out[1].members).toEqual([
      { billId: "o1", open: 613.19 },
      { billId: "c1", open: 95.99 },
    ]);
  });
});

describe("planPaymentAllocation: his three answers", () => {
  const book = [purchase("a", 100, "2001-01-01"), purchase("b", 80, "2001-02-01"), purchase("c", 70, "2001-03-01")];

  it("no boxes: a payment to the account marks off oldest first and leaves the last one part-paid", () => {
    const plan = planPaymentAllocation({ amount: 150, purchases: book });
    expect(plan.rows).toEqual([
      { billId: "a", amount: 100, discount: 0 },
      { billId: "b", amount: 50, discount: 0 },
    ]);
    expect(plan.paidInFull.map((p) => p.rootId)).toEqual(["a"]);
    expect(plan.partPaid).toEqual({ purchase: book[1], paid: 50, left: 30 });
    expect(plan.ahead).toBe(0);
    expect(plan.spilled).toEqual([]);
  });

  it("boxes: the checked purchases first, oldest first, whatever order the boxes came in", () => {
    const plan = planPaymentAllocation({ amount: 150, purchases: book, chosen: ["c", "b"] });
    expect(plan.rows).toEqual([
      { billId: "b", amount: 80, discount: 0 },
      { billId: "c", amount: 70, discount: 0 },
    ]);
    expect(plan.ahead).toBe(0);
    expect(plan.spilled).toEqual([]);
  });

  it("extra over the boxes applies to the next open purchase, oldest first, and the rest is ahead (answer 3)", () => {
    const plan = planPaymentAllocation({ amount: 100, purchases: book, chosen: ["c"] });
    expect(plan.rows).toEqual([
      { billId: "c", amount: 70, discount: 0 },
      { billId: "a", amount: 30, discount: 0 },
    ]);
    expect(plan.spilled.map((p) => p.rootId)).toEqual(["a"]);
    expect(plan.partPaid?.purchase.rootId).toBe("a");
    const more = planPaymentAllocation({ amount: 300, purchases: book, chosen: ["c"] });
    expect(more.rows.map((r) => r.amount)).toEqual([70, 100, 80]);
    expect(more.ahead).toBe(50);
  });

  it("a payment short of the boxes by the printed discount is paid in full with the discount recorded (answer 2)", () => {
    const withDiscount = [purchase("a", 100, "2001-01-01", 2), purchase("b", 80, "2001-02-01", 1.6), purchase("c", 70, "2001-03-01", 0)];
    const plan = planPaymentAllocation({ amount: 176.4, purchases: withDiscount, chosen: ["a", "b"] });
    expect(plan.tookDiscounts).toBe(true);
    expect(plan.rows).toEqual([
      { billId: "a", amount: 98, discount: 2 },
      { billId: "b", amount: 78.4, discount: 1.6 },
    ]);
    expect(plan.discounts).toBe(3.6);
    expect(plan.ahead).toBe(0);
    expect(plan.partPaid).toBeNull();
    // The full total takes no discount and leaves nothing ahead.
    const full = planPaymentAllocation({ amount: 180, purchases: withDiscount, chosen: ["a", "b"] });
    expect(full.tookDiscounts).toBe(false);
    expect(full.rows.map((r) => r.discount)).toEqual([0, 0]);
    expect(full.ahead).toBe(0);
    // Between the two is read as full payments with the last one short, never a guessed discount.
    const between = planPaymentAllocation({ amount: 178, purchases: withDiscount, chosen: ["a", "b"] });
    expect(between.tookDiscounts).toBe(false);
    expect(between.partPaid).toEqual({ purchase: withDiscount[1], paid: 78, left: 2 });
    // Discounts never apply to a payment to the account.
    const account = planPaymentAllocation({ amount: 176.4, purchases: withDiscount });
    expect(account.tookDiscounts).toBe(false);
  });

  it("a purchase with a credit correction takes cash on its positive members only, and the discount rides the first", () => {
    const p = purchase("o", 80, "2001-01-01", 4, [
      { billId: "o", open: 100 },
      { billId: "credit", open: -20 },
    ]);
    const plan = planPaymentAllocation({ amount: 76, purchases: [p], chosen: ["o"] });
    expect(plan.rows).toEqual([{ billId: "o", amount: 76, discount: 4 }]);
    const two = purchase("o2", 709.18, "2001-01-02", 0, [
      { billId: "o2", open: 613.19 },
      { billId: "c2", open: 95.99 },
    ]);
    const split = planPaymentAllocation({ amount: 650, purchases: [two] });
    expect(split.rows).toEqual([
      { billId: "o2", amount: 613.19, discount: 0 },
      { billId: "c2", amount: 36.81, discount: 0 },
    ]);
    expect(split.partPaid).toEqual({ purchase: two, paid: 650, left: 59.18 });
  });

  it("nothing open: every dollar is ahead", () => {
    const plan = planPaymentAllocation({ amount: 25, purchases: [] });
    expect(plan.rows).toEqual([]);
    expect(plan.ahead).toBe(25);
  });
});
