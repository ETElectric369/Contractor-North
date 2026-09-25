import { describe, it, expect } from "vitest";
import { billableBillCost, billItemisation, billLineCost, billLineBilledCost, billedPortion, excludedReceiptCost, isTaxLine, shelfLotCost, type BillLine } from "@/lib/bill-itemisation";

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

/**
 * ── THE TWISTER BOX (Erik, 2026-09-19; migration 0272) ────────────────────────────────────────
 *
 *   "the Twister box i was confused about and i remebered that is a whole ccontainer of wire nuts
 *    that we uses some of but is certainly stock and shouldnt be charged to the customer in full
 *    however necessary for the job"
 *
 * The real receipt: a 500 count box of IDEAL 30641 Twisters at $108.36 (21.7 cents each), an eight
 * ounce jar of anti-oxidant at $20.65 used a dab at a time, and the sales tax on both. His customer
 * was billed $135.00 for the whole box. He fixed it by hand — sixty nuts at twenty-seven cents,
 * and the jar line deleted — which is the workaround these numbers exist to retire.
 */
const twisterBill = { id: "b7", supplier: "CED", bill_number: "30641", amount: 139.65 };
const twister: BillLine = {
  id: "t1",
  description: "IDEAL 30641 Twister 341-Tan 500",
  quantity: 500,
  amount: 108.36,
  category: "Electrical",
};
const oxide: BillLine = { id: "t2", description: "Noalox Anti-Oxidant 8 oz", quantity: 1, amount: 20.65, category: "Electrical" };
const twisterTax: BillLine = { id: "t3", description: "Sales Tax", quantity: 1, amount: 10.64, category: "Sales Tax" };

describe("billItemisation — a container billed by what the job used", () => {
  it("changes nothing at all until somebody splits a line", () => {
    // The whole point of a third state is that the other two do not move. This is the invoice he
    // actually got, and it must stay reproducible to the cent after 0272 as before it.
    const rows = billItemisation(twisterBill, [twister, oxide, twisterTax], 25);
    expect(sum(rows)).toBe(mark(139.65, 25));
    expect(rows.find((r) => r.import_key === "bli:t1")).toEqual({
      import_key: "bli:t1",
      description: "IDEAL 30641 Twister 341-Tan 500",
      quantity: 500,
      unit: "ea",
      unit_price: 0.27,
    });
  });

  it("bills the sixty nuts and leaves the rest of the box on the shelf", () => {
    // $108.36 ÷ 500 = 21.672 cents each; sixty of them is $13.00 of cost, $16.25 with his markup.
    // That is the figure he typed in by hand, arrived at by the app instead.
    const rows = billItemisation(twisterBill, [{ ...twister, billed_amount: 13, is_stock: true }, oxide, twisterTax], 25);
    const line = rows.find((r) => r.import_key === "bli:t1");
    expect(line).toEqual({
      import_key: "bli:t1",
      description: "IDEAL 30641 Twister 341-Tan 500 (what this job used)",
      quantity: 1,
      unit: "ea",
      unit_price: 16.25,
    });
    // ...and the $95.36 still in the box is off the target too, so the remainder row cannot
    // quietly put it back. That half is the one that leaked before 0268 and would have leaked
    // again here.
    expect(sum(rows)).toBeLessThan(mark(139.65 - 95.36 + 0.01, 25));
  });

  it("takes the shelf's share of the sales tax off with the shelf's share of the box", () => {
    /**
     * Four fifths of the box stayed on the shelf, so four fifths of the tax charged on that box
     * did too. Billing the whole tax line while billing a fifth of the goods is the 48 cent leak
     * from the all-snacks receipt, rebuilt one layer down with a number instead of a boolean.
     *
     * $95.36 of $129.01 of purchases is 73.92%, so $7.86 of the $10.64 tax goes with it.
     */
    const rows = billItemisation(twisterBill, [{ ...twister, billed_amount: 13 }, oxide, twisterTax], 25);
    expect(sum(rows)).toBe(mark(139.65 - 95.36 - 7.86, 25));
  });

  it("splits the jar of anti-oxidant the same way", () => {
    // An ounce out of eight, $2.58. "used a dab at a time" is the same shape as the box of nuts:
    // a real cost of the job, and not a thing one customer buys outright.
    const rows = billItemisation(
      twisterBill,
      [{ ...twister, billed_amount: 13 }, { ...oxide, billed_amount: 2.58 }, twisterTax],
      25,
    );
    const jar = rows.find((r) => r.import_key === "bli:t2");
    expect(jar?.description).toBe("Noalox Anti-Oxidant 8 oz (what this job used)");
    expect(jar?.quantity).toBe(1);
    // Both shelves' shares of the tax come off: $113.43 of $129.01 is 87.9%, $9.36 of the tax.
    expect(sum(rows)).toBe(mark(139.65 - 113.43 - 9.36, 25));
  });

  it("bills nothing for a container this job took none of", () => {
    // Zero is a decision, not a blank: the box went on the shelf and this job used none of it.
    const rows = billItemisation(twisterBill, [{ ...twister, billed_amount: 0, is_stock: true }, oxide, twisterTax], 25);
    expect(rows.find((r) => r.import_key === "bli:t1")).toBeUndefined();
    expect(sum(rows)).toBe(mark(139.65 - 108.36 - 8.94, 25)); // $8.94 is the box's 84% share of the tax
  });

  it("never bills more of a line than the line cost, whatever the row says", () => {
    // 0272's CHECK says the same thing. Said twice on purpose: a constraint protects the table,
    // this protects the customer from a row that got in before the constraint did.
    const rows = billItemisation(twisterBill, [{ ...twister, billed_amount: 999 }, oxide, twisterTax], 25);
    expect(sum(rows)).toBe(mark(139.65, 25));
  });

  it("reads a blank, a negative or junk as the whole line — never as zero", () => {
    // A blank is PostgREST handing back nothing, not a person saying "none". Reading it as a
    // decision would silently stop billing a line nobody touched.
    for (const raw of [null, undefined, "", "   ", -5, NaN, "abc"]) {
      const rows = billItemisation(twisterBill, [{ ...twister, billed_amount: raw }, oxide, twisterTax], 25);
      expect(sum(rows)).toBe(mark(139.65, 25));
    }
  });

  it("lets the switch win over the split, because off is off", () => {
    // A line somebody switched off bills nothing even with a split stored on it — the two
    // controls are not a contest, and flipping the switch back restores the split he set.
    const rows = billItemisation(twisterBill, [{ ...twister, billed_amount: 13, billable: false }, oxide, twisterTax], 25);
    expect(rows.find((r) => r.import_key === "bli:t1")).toBeUndefined();
    expect(sum(rows)).toBe(mark(139.65 - 108.36 - 8.94, 25)); // $8.94 is the box's 84% share of the tax
  });

  it("reads is_stock as a label and never as money", () => {
    // Two columns that both mean money is how two screens end up disagreeing about one dollar.
    const labelled = billItemisation(twisterBill, [{ ...twister, is_stock: true }, oxide, twisterTax], 25);
    expect(labelled).toEqual(billItemisation(twisterBill, [twister, oxide, twisterTax], 25));
  });

  it("bills nothing at all when every line was either switched off or left on the shelf", () => {
    const rows = billItemisation(twisterBill, [
      { ...twister, billed_amount: 0 },
      { ...oxide, billable: false },
      twisterTax,
    ], 25);
    expect(rows).toEqual([]);
  });

  it("still bills the lump for an unpriced line, which nobody decided anything about", () => {
    // An unpriced line is unreadable money, not a decision. The lump is the honest answer to "we
    // could not itemise this" and it must survive the new state being added beside it.
    const rows = billItemisation(bill, [{ id: "u1", description: "Misc", quantity: 0, amount: 0, billed_amount: null }], 20);
    expect(rows).toEqual([
      { import_key: "bill:b1", description: "Materials — CED (bill #88)", quantity: 1, unit: "lot", unit_price: 120 },
    ]);
  });

  /**
   * TAX A PERSON TYPED IS THE TAX THAT BILLS (review of cn-v966).
   *
   * Nothing on the Bills card exempts the Sales Tax row from the same switch and the same "Bill
   * Only What This Job Used" box every other line gets, so he can act on it directly. When he does
   * on a receipt that ALSO has a split purchased line, the tax he chose to bill used to be shaved a
   * SECOND time by the proportional share of that split: $2.00 typed, about 52 cents billed, and no
   * screen anywhere showing him the difference.
   */
  it("bills the tax a person typed, not a share of it", () => {
    const rows = billItemisation(
      twisterBill,
      [{ ...twister, billed_amount: 13 }, oxide, { ...twisterTax, billed_amount: 2 }],
      25,
    );
    // $13 of nuts + $20.65 of jar + the $2 of tax he chose = $35.65 of cost, marked up once.
    expect(sum(rows)).toBe(mark(35.65, 25));
    expect(excludedReceiptCost([{ ...twister, billed_amount: 13 }, oxide, { ...twisterTax, billed_amount: 2 }])).toBe(104);
  });

  it("an UNTOUCHED tax line still carries the shelf's share, to the same cent as before", () => {
    // The whole safety of the clause above: only tax nobody has acted on is proportional.
    expect(excludedReceiptCost([{ ...twister, billed_amount: 13 }, oxide, twisterTax])).toBe(103.22); // 95.36 + 7.86
    expect(excludedReceiptCost([{ ...twister, billable: false }, oxide, { ...twisterTax, billable: false }])).toBe(119);
  });

  it("ignores a split stored against a return, rather than halving a credit", () => {
    // "Half of minus nine dollars" is an invented number wearing arithmetic's clothes.
    const withReturn = { id: "b8", supplier: "CED", bill_number: null, amount: 91.36 };
    const credit: BillLine = { id: "r1", description: "Returned breaker", quantity: 1, amount: -17, billed_amount: 5 };
    const rows = billItemisation(withReturn, [twister, credit], 25);
    expect(sum(rows)).toBe(mark(91.36, 25));
    expect(rows.find((r) => r.import_key === "bli:r1")?.unit_price).toBe(-21.25);
  });
});

describe("billableBillCost — the one figure a panel may promise", () => {
  /**
   * HIS OSH RUN FOR JASON WALDOW, from the live row (bills 905c9f3d, J-046): $16.28 of receipt,
   * two bags of Kettle Chips and an ice cream bar switched off, ten bulk fasteners and the tax on.
   * The Unbilled card said $20.35 of material; the button beside it writes $8.13.
   */
  const oshBill = { id: "b9", supplier: "OSH - Cupertino", bill_number: null, amount: 16.28 };
  const oshLines: BillLine[] = [
    { id: "o1", description: "Kettle Chip Honey Dijon", quantity: 1, unit_price: 2.09, amount: 2.09, category: "Other", billable: false },
    { id: "o2", description: "Kettle Chips Salt/Pepper", quantity: 1, unit_price: 2.09, amount: 2.09, category: "Other", billable: false },
    { id: "o3", description: "Ice Cream Bar Choc Almond", quantity: 1, unit_price: 4.99, amount: 4.99, category: "Other", billable: false },
    { id: "o4", description: "Bulk Fastener", quantity: 10, unit_price: 0.61, amount: 6.1, category: "Fasteners", billable: true },
    { id: "o5", description: "Tax", quantity: 1, unit_price: 1.01, amount: 1.01, category: "Tax", billable: true },
  ];

  it("equals what the importer will actually bill, to the cent", () => {
    expect(billableBillCost(oshBill.amount, oshLines)).toBe(6.5); // 16.28 − 9.17 of snacks − their 0.61 of tax
    const rows = billItemisation(oshBill, oshLines, 25);
    expect(sum(rows)).toBe(mark(6.5, 25)); // $8.13 — the figure on the button
  });

  it("is the whole bill when nothing was read off it (a hand-entered bill is its lump)", () => {
    expect(billableBillCost(16.28, [])).toBe(16.28);
    expect(billableBillCost(16.28, null)).toBe(16.28);
    expect(billableBillCost("139.65", [twister, oxide, twisterTax])).toBe(139.65);
  });

  it("is ZERO when every purchased line was the company's own, residue and all", () => {
    // billItemisation returns no rows for this receipt, so no panel may promise a dollar of it.
    const allOff = oshLines.map((l) => (l.category === "Tax" ? l : { ...l, billable: false }));
    expect(billableBillCost(oshBill.amount, allOff)).toBe(0);
    expect(billItemisation(oshBill, allOff, 25)).toEqual([]);
    // Even when the receipt total is larger than the lines add up to: unreadable residue on a
    // receipt nobody is billing is not a charge either.
    expect(billableBillCost(25, allOff)).toBe(0);
  });

  it("never returns less than nothing", () => {
    expect(billableBillCost(5, [{ id: "x", amount: 40, billable: false, category: "Materials" }, { id: "y", amount: 8, category: "Materials" }])).toBe(0);
    expect(billableBillCost(null, oshLines)).toBe(0);
  });
});

describe("billedPortion / billLineBilledCost — one reading, both sides of the subtraction", () => {
  it("means the whole line until a number says otherwise", () => {
    expect(billedPortion(108.36, null)).toBeNull();
    expect(billedPortion(108.36, undefined)).toBeNull();
    expect(billedPortion(108.36, 13)).toBe(13);
    expect(billedPortion(108.36, "13.00")).toBe(13); // PostgREST hands numerics back as strings
    expect(billedPortion(108.36, 0)).toBe(0);
  });

  it("clamps to the line's own cost and refuses junk", () => {
    expect(billedPortion(108.36, 999)).toBe(108.36);
    expect(billedPortion(108.36, -1)).toBeNull();
    expect(billedPortion(108.36, "")).toBeNull();
    expect(billedPortion(0, 5)).toBeNull();
    expect(billedPortion(-17, 5)).toBeNull();
  });

  it("agrees with the switch, which outranks it", () => {
    expect(billLineBilledCost({ id: "a", amount: 108.36, billed_amount: 13 })).toBe(13);
    expect(billLineBilledCost({ id: "a", amount: 108.36, billed_amount: 13, billable: false })).toBe(0);
    expect(billLineBilledCost({ id: "a", amount: 108.36 })).toBe(108.36);
  });
});

describe("lines that add up to more than the receipt", () => {
  /**
   * HIS TAO ZHU SCAN, CONDENSED BUT NOT INVENTED. One PDF held two CED invoices and the reader put
   * both sets of lines on one bill: twenty-one rows, $1,547.19 of purchased lines and $128.97 of
   * tax (two tax rows, one per invoice - 8802-1101363 and 8802-1101419), against a bill amount of
   * $1,513.71, which is the second invoice alone. The four rows below carry those exact four
   * figures; the individual parts are not the point and the arithmetic is identical.
   */
  const bill = { id: "tao", supplier: "Consolidated Electrical Distributors, Inc. (CED)", bill_number: null, amount: 1513.71 };
  const lines = [
    { id: "a", description: "NMB 10/3 W/GND (250 ft Coil)", quantity: 250, unit_price: 1.65, amount: 411.68, category: "Electrical", billable: true, billed_amount: null },
    { id: "b", description: "Everything else on the two tickets", quantity: 1, unit_price: 1135.51, amount: 1135.51, category: "Electrical", billable: true, billed_amount: null },
    { id: "c", description: "Sales Tax 9.00000 (Invoice 8802-1101363)", quantity: 1, unit_price: 13.41, amount: 13.41, category: "Tax", billable: true, billed_amount: null },
    { id: "d", description: "Sales Tax 8.26500 (Invoice 8802-1101419)", quantity: 1, unit_price: 115.56, amount: 115.56, category: "Tax", billable: true, billed_amount: null },
  ];

  it("bills the receipt as one amount rather than printing a credit on a customer's invoice", () => {
    const rows = billItemisation(bill, lines, 25);
    const total = rows.reduce((s, r) => Math.round((s + r.quantity * r.unit_price) * 100) / 100, 0);
    expect(total).toBe(1892.14); // 1513.71 x 1.25 - the same money either way
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBe("lot");
    expect(rows.every((r) => r.unit_price > 0)).toBe(true);
  });

  it("still itemises, with a supplies row, when the lines fit inside the receipt", () => {
    const rows = billItemisation({ ...bill, amount: 1800 }, lines, 25);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[rows.length - 1].description).toContain("Supplies & tax");
    expect(rows[rows.length - 1].unit_price).toBeGreaterThan(0);
  });
});

/**
 * ── THE SHELF'S SHARE (Shop Stock, 0303) ──────────────────────────────────────────────────────
 * shelfLotCost is ONE LINE'S part of excludedReceiptCost, and excludedReceiptCost is the SUM of the
 * parts. The identity is the whole point: a roll on the shelf and the receipt it came off can never
 * disagree about a cent, because there is one copy of the tax arithmetic.
 */
const sumShares = (lines: BillLine[]) => Math.round(lines.reduce((s, l) => s + Math.round(shelfLotCost(l, lines) * 100), 0)) / 100;

/** excludedReceiptCost exactly as it was written before 0303 (cn-v966), kept here as the witness
 *  that the refactor into per-line parts changed no receipt anywhere by a cent. */
function legacyExcludedReceiptCost(allLines: BillLine[]): number {
  const sumBy = (ls: BillLine[], f: (l: BillLine) => number) => ls.reduce((sum, l) => Math.round((sum + f(l)) * 100) / 100, 0);
  const notBilled = (l: BillLine) => Math.round((billLineCost(l) - billLineBilledCost(l)) * 100) / 100;
  const purchased = allLines.filter((l) => !isTaxLine(l));
  const purchasedCost = sumBy(purchased, billLineCost);
  const excludedPurchasedCost = sumBy(purchased, notBilled);
  const taxLines = allLines.filter(isTaxLine);
  const excludedTaxDirect = sumBy(taxLines, notBilled);
  const untouchedTax = taxLines.filter((l) => l.billable !== false && billedPortion(billLineCost(l), l.billed_amount) == null);
  const sharedTax = sumBy(untouchedTax, billLineCost);
  const excludedShare = purchasedCost > 0 ? excludedPurchasedCost / purchasedCost : 0;
  const excludedTaxShare = Math.round(sharedTax * excludedShare * 100) / 100;
  return Math.round((excludedPurchasedCost + excludedTaxDirect + excludedTaxShare) * 100) / 100;
}

/** Herringbone's 7/31 CED ticket (bill 387341c7), line for line from the books. */
const herringbone731 = (): BillLine[] => [
  { id: "h1", description: "Flexbox single gang 20.5 cu in", quantity: 33, unit_price: 1.34, amount: 44.22, category: "Electrical" },
  { id: "h2", description: "Flexbox two gang 40 cu in OWB", quantity: 2, unit_price: 6.79, amount: 13.57, category: "Electrical" },
  { id: "h3", description: "Flexbox two gang 43.5 cu in", quantity: 10, unit_price: 2.58, amount: 25.8, category: "Electrical" },
  { id: "h4", description: "Flexbox 3.5 in ceiling", quantity: 8, unit_price: 3.71, amount: 29.68, category: "Electrical" },
  { id: "h5", description: "4 in LED shallow IC housing", quantity: 3, unit_price: 11.83, amount: 35.49, category: "Electrical" },
  { id: "h6", description: "6 in LED housing", quantity: 1, unit_price: 12.33, amount: 12.33, category: "Electrical" },
  { id: "h7", description: "NMB 12/2 w/gnd 250 ft coil", quantity: 250, unit_price: 0.66, amount: 165.29, category: "Electrical" },
  { id: "h8", description: "NMB 14/2 w/gnd 250 ft coil", quantity: 250, unit_price: 0.45, amount: 111.6, category: "Electrical", billed_amount: 0 },
  { id: "h9", description: "Tax @ 9.000%", quantity: 1, unit_price: 39.42, amount: 39.42, category: "Tax" },
];

describe("shelfLotCost: one line's share, and the parts add up to the receipt's figure", () => {
  it("Herringbone 7/31: the 14/2 coil taken off the invoice is $121.64 on the shelf, tax share and all", () => {
    const lines = herringbone731();
    expect(shelfLotCost(lines[7], lines)).toBe(121.64);
    expect(sumShares(lines)).toBe(excludedReceiptCost(lines));
    // Nothing else on the ticket was taken off, so nothing else has a share.
    for (const l of lines.filter((x) => x.id !== "h8")) expect(shelfLotCost(l, lines)).toBe(0);
  });

  it("Herringbone 7/31 with the 12/2 coil also at 0 used: $180.17 + $121.64, and the parts are the bill's figure", () => {
    const lines = herringbone731();
    lines[6] = { ...lines[6], billed_amount: 0 };
    // 39.42 x 165.29 / 437.98 = 14.877 and 39.42 x 111.60 / 437.98 = 10.044 cents-wise: the split
    // must land on the once-per-bill figure, 24.92.
    expect(shelfLotCost(lines[6], lines)).toBe(180.17);
    expect(shelfLotCost(lines[7], lines)).toBe(121.64);
    expect(excludedReceiptCost(lines)).toBe(301.81);
    expect(sumShares(lines)).toBe(301.81);
    // The receipt's own identity: what the job keeps plus what goes on the shelf is the bill.
    expect(Math.round((billableBillCost(477.4, lines) + sumShares(lines)) * 100) / 100).toBe(477.4);
  });

  it("the 8/19 ticket (bill 11e96fc3): the 12/2 coil at 0 used is $180.17 on the shelf", () => {
    const lines: BillLine[] = [
      { id: "a", description: "Flexbox BH bar hanger ground", quantity: 1, amount: 8.82, category: "Electrical" },
      { id: "b", description: "NMB 12/2 w/gnd wire 250 ft coil", quantity: 250, amount: 165.29, category: "Electrical", billed_amount: 0 },
      { id: "c", description: "Flexbox single gang 16 cu in", quantity: 2, amount: 8.9, category: "Electrical" },
      { id: "t", description: "Tax at 9.000 percent", quantity: 1, amount: 16.47, category: "Tax" },
    ];
    expect(shelfLotCost(lines[1], lines)).toBe(180.17);
    expect(sumShares(lines)).toBe(excludedReceiptCost(lines));
    expect(Math.round((billableBillCost(199.48, lines) + sumShares(lines)) * 100) / 100).toBe(199.48);
  });

  it("the Twister box: 60 used of 500, the rest on the shelf with its share of the tax", () => {
    const lines = [{ ...twister, billed_amount: 13 }, oxide, twisterTax];
    expect(sumShares(lines)).toBe(excludedReceiptCost(lines));
    expect(shelfLotCost(lines[0], lines)).toBe(excludedReceiptCost(lines));
    expect(shelfLotCost(oxide, lines)).toBe(0);
  });

  it("three lines off one bill where rounding each share alone misses the bill's figure by a cent", () => {
    // $1 of tax over three equal $10 lines out of $30 purchased: each line's exact share is 33.33...
    // cents. Rounded alone they are 0.33 x 3 = $0.99; the bill's figure is $1.00. The split gives
    // the odd cent to the first line (ties go to the earlier line), so the parts sum to $31.00.
    const lines: BillLine[] = [
      { id: "x", description: "Box A", quantity: 1, amount: 10, billable: false },
      { id: "y", description: "Box B", quantity: 1, amount: 10, billable: false },
      { id: "z", description: "Box C", quantity: 1, amount: 10, billable: false },
      { id: "t", description: "Sales Tax", quantity: 1, amount: 1, category: "Tax" },
    ];
    expect(excludedReceiptCost(lines)).toBe(31);
    expect(lines.map((l) => shelfLotCost(l, lines))).toEqual([10.34, 10.33, 10.33, 0]);
    expect(sumShares(lines)).toBe(31);
  });

  it("finds the line by id when handed a copy, and gives a stranger no share", () => {
    const lines = herringbone731();
    expect(shelfLotCost({ ...lines[7] }, lines)).toBe(121.64);
    expect(shelfLotCost({ id: "nobody", amount: 5 }, lines)).toBe(0);
  });

  it("changed no receipt by a cent: the sum of parts equals the pre-0303 arithmetic on 4,000 random receipts", () => {
    // A seeded generator, so a failure is reproducible: mixes of switched-off lines, split lines,
    // returns, $0 lines, untouched tax, split tax and switched-off tax.
    let seed = 20260924;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const money = (max: number) => Math.round(rnd() * max * 100) / 100;
    for (let n = 0; n < 4000; n++) {
      const lines: BillLine[] = [];
      const count = 1 + Math.floor(rnd() * 7);
      for (let i = 0; i < count; i++) {
        const amount = rnd() < 0.08 ? -money(40) : rnd() < 0.05 ? 0 : money(300);
        const r = rnd();
        lines.push({
          id: `l${i}`,
          amount,
          quantity: 1,
          category: "Electrical",
          ...(r < 0.25 ? { billable: false } : r < 0.5 ? { billed_amount: money(Math.max(amount, 0)) } : {}),
        });
      }
      const taxes = Math.floor(rnd() * 3);
      for (let t = 0; t < taxes; t++) {
        const r = rnd();
        lines.push({
          id: `t${t}`,
          amount: money(30),
          quantity: 1,
          category: "Sales Tax",
          ...(r < 0.15 ? { billable: false } : r < 0.3 ? { billed_amount: money(10) } : {}),
        });
      }
      const legacy = legacyExcludedReceiptCost(lines);
      expect(excludedReceiptCost(lines)).toBe(legacy);
      expect(sumShares(lines)).toBe(legacy);
    }
  });
});
