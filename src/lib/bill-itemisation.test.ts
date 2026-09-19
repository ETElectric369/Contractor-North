import { describe, it, expect } from "vitest";
import { billItemisation, billLineCost, type BillLine } from "@/lib/bill-itemisation";

/** The invariant, said once: a bill's rows sum to the marked-up BILLABLE total, to the cent. */
const sum = (rows: { quantity: number; unit_price: number }[]) =>
  Math.round(rows.reduce((t, r) => t + r.quantity * r.unit_price, 0) * 100) / 100;
const mark = (cost: number, markup: number) => Math.round(cost * (1 + markup / 100) * 100) / 100;

const bill = { id: "b1", supplier: "CED", bill_number: "88", amount: 100 };
/** Erik's receipt in miniature: the wire, the sales tax, and the Smartwater. */
const wire: BillLine = { id: "l1", description: "12 AWG THHN", quantity: 2, amount: 30, category: "Materials" };
const tax: BillLine = { id: "l2", description: "Sales Tax", quantity: 1, amount: 7, category: "Sales Tax" };
const water: BillLine = { id: "l3", description: "Smartwater 1L", quantity: 1, amount: 2.5, category: "Food & Drink" };

describe("billItemisation — nothing changes for a receipt that is all the customer's", () => {
  it("bills exactly what it billed before 0268 existed", () => {
    // The golden shape, written out rather than computed, so a drift in the arithmetic has to
    // argue with a literal. Tax is NOT itemised and IS billed, inside the remainder row.
    expect(billItemisation(bill, [wire, tax, water], 20)).toEqual([
      { import_key: "bli:l1", description: "12 AWG THHN", quantity: 2, unit: "ea", unit_price: 18 },
      { import_key: "bli:l3", description: "Smartwater 1L", quantity: 1, unit: "ea", unit_price: 3 },
      { import_key: "bill:b1:remainder", description: "Supplies & tax — CED", quantity: 1, unit: "ea", unit_price: 81 },
    ]);
    expect(sum(billItemisation(bill, [wire, tax, water], 20))).toBe(mark(100, 20));
  });

  it("reads a row with no `billable` column (pre-0268, or a mid-deploy fallback) as billable", () => {
    const explicit = billItemisation(bill, [wire, tax, { ...water, billable: true }], 20);
    expect(billItemisation(bill, [wire, tax, water], 20)).toEqual(explicit);
  });

  it("still bills a hand-entered bill with no lines as its one lump", () => {
    expect(billItemisation(bill, [], 20)).toEqual([
      { import_key: "bill:b1", description: "Materials — CED (bill #88)", quantity: 1, unit: "lot", unit_price: 120 },
    ]);
  });

  it("keeps billing tax through the remainder when tax is the only line", () => {
    // "Not itemised" and "not billed" are different ideas. A tax-only bill has no itemised rows,
    // so it falls to the lump — and the lump is still the whole marked-up bill.
    expect(billItemisation(bill, [tax], 20)).toEqual([
      { import_key: "bill:b1", description: "Materials — CED (bill #88)", quantity: 1, unit: "lot", unit_price: 120 },
    ]);
  });
});

describe("billItemisation — a line marked not billable is not billed anywhere", () => {
  it("drops the line AND takes its marked-up money off the target", () => {
    const rows = billItemisation(bill, [wire, tax, { ...water, billable: false }], 20);
    // Gone from the itemisation...
    expect(rows.find((r) => r.import_key === "bli:l3")).toBeUndefined();
    // ...and gone from the total, which is the half that used to leak: the remainder row is
    // where Erik's Smartwater hid on INV-069. The $2.50 comes off, and so does the share of the
    // sales tax that was charged on it — see the tax test below for why.
    expect(sum(rows)).toBe(mark(100 - 2.5 - 0.54, 20));
    expect(sum(rows)).toBe(116.35);
  });

  it("leaves the remainder row balancing the bill to the cent", () => {
    const rows = billItemisation(bill, [wire, tax, { ...water, billable: false }], 20);
    const remainder = rows.find((r) => r.import_key === "bill:b1:remainder");
    expect(remainder?.unit_price).toBe(80.35); // the wire's share of the tax, marked up, plus rounding
    expect(sum(rows)).toBe(mark(100 - 3.04, 20));
  });

  it("takes the excluded line's SHARE OF THE TAX off with it", () => {
    /**
     * TAX RIDES WITH WHAT IT TAXES (review of this wave, 2026-09-18).
     *
     * Tax on the customer's wire is their cost and passes through. Tax on the company's
     * Smartwater is not. A receipt never says which cents of tax belong to which item, so the
     * share of the purchase that was the company's own takes the same share of the tax.
     *
     * Here: $2.50 of water out of $32.50 of purchases is 7.69%, so 54 cents of the $7 tax goes
     * with it and $6.46 still reaches the customer inside the remainder.
     */
    const rows = billItemisation(bill, [wire, tax, { ...water, billable: false }], 20);
    // The whole $7 of tax would have been mark(100 - 2.5) = 117; the water's share of it is gone.
    expect(sum(rows)).toBeLessThan(mark(100 - 2.5, 20));
    // toBeCloseTo, not toBe: this subtraction is done in the TEST, outside the rounding the
    // function itself keeps, so it carries the float dust the code never stores.
    expect(mark(100 - 2.5, 20) - sum(rows)).toBeCloseTo(mark(0.54, 20), 2);

    // And the direction is only ever this one: with the water billable, nothing moves at all.
    expect(sum(billItemisation(bill, [wire, tax, water], 20))).toBe(mark(100, 20));
  });

  it("bills NOTHING for a receipt of snacks that carried sales tax", () => {
    /**
     * The reviewer's reproduction, and Erik's actual skipped receipt. Every purchased line is the
     * company's own, so the tax on them is too. Before this, the tax residue survived as a lump
     * labelled "Materials - Safeway" — the same silent charge under a new name, inside the code
     * written to end it.
     */
    const snackRun = { id: "b2", supplier: "Safeway", bill_number: null, amount: 5.5 };
    const rows = billItemisation(
      snackRun,
      [
        { id: "s1", description: "Smartwater 20 oz", quantity: 1, amount: 2, category: "Food & Drink", billable: false },
        { id: "s2", description: "BodyArmor 28 oz", quantity: 1, amount: 3, category: "Food & Drink", billable: false },
        { id: "s3", description: "Beverage Bottle Dep 0.10", quantity: 1, amount: 0.1, category: "Food & Drink", billable: false },
        { id: "s4", description: "Sales Tax", quantity: 1, amount: 0.4, category: "Tax" },
      ],
      20,
    );
    expect(rows).toEqual([]);
  });

  it("still bills the lump when the lines were unreadable rather than switched off", () => {
    // The lump answers "we could not itemise this", never "there is nothing here for the
    // customer". One billable line with no price keeps the old behaviour intact.
    const rows = billItemisation(bill, [{ id: "x1", description: "Misc", quantity: 0, amount: 0 }], 20);
    expect(rows).toEqual([
      { import_key: "bill:b1", description: "Materials — CED (bill #88)", quantity: 1, unit: "lot", unit_price: 120 },
    ]);
  });

  it("balances on rates and amounts that do not divide evenly", () => {
    const odd = { id: "b9", supplier: "Home Depot", bill_number: null, amount: 123.45 };
    const snacks: BillLine = { id: "s1", description: "BodyArmor 6pk", quantity: 1, amount: 9.99, billable: false };
    const part: BillLine = { id: "s2", description: "1/2 in connector", quantity: 7, amount: 21.63 };
    const rows = billItemisation(odd, [snacks, part], 17.5);
    expect(sum(rows)).toBe(mark(123.45 - 9.99, 17.5));
    for (const r of rows) expect(Math.round(r.unit_price * 100) / 100).toBe(r.unit_price);
  });

  it("bills nothing at all when the whole receipt was the company's own", () => {
    // "i have another receipt that i didnt scan specifically because it was mostly snacks and a
    // $3 part" — with the part switched off too, there is nothing to put in front of a customer,
    // and a $0 "Materials" row would be worse than no row.
    const snackRun = { id: "b2", supplier: "Safeway", bill_number: null, amount: 8 };
    const lines: BillLine[] = [
      { id: "s1", description: "Smartwater", quantity: 2, amount: 5, billable: false },
      { id: "s2", description: "Beverage Bottle Dep", quantity: 1, amount: 3, billable: false },
    ];
    expect(billItemisation(snackRun, lines, 20)).toEqual([]);
  });

  it("does not let a mis-keyed exclusion push a bill negative", () => {
    // Bad data in (the lines claim more than the bill): refuse to emit rather than invent a
    // negative charge. Money is never guessed at here.
    const wrong = { id: "b3", supplier: "CED", bill_number: null, amount: 10 };
    expect(billItemisation(wrong, [{ id: "x", amount: 40, billable: false }], 20)).toEqual([]);
  });
});

describe("billLineCost — one reading, used on both sides of the subtraction", () => {
  it("prefers the stored amount, falls back to unit × qty, and treats a bare unit price as one", () => {
    expect(billLineCost({ id: "a", amount: 12.5, quantity: 4, unit_price: 99 })).toBe(12.5);
    expect(billLineCost({ id: "b", quantity: 3, unit_price: 2.5 })).toBe(7.5);
    expect(billLineCost({ id: "c", unit_price: 4.25 })).toBe(4.25);
    expect(billLineCost({ id: "d" })).toBe(0);
  });
});
