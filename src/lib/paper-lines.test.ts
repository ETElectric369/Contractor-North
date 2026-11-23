import { describe, expect, it } from "vitest";
import { cleanLines } from "./paper-lines";
import { penSummary } from "./pen-marks";

/**
 * A PAPER'S LINES CARRY THE PEN (cn-v1181, P2). cleanLines puts each line the reader transcribed
 * through applyPenMark (src/lib/pen-marks.ts): a struck line comes off the customer's bill at its
 * PRINTED price, a quantity changed by hand becomes two lines (kept, and what went back) whose
 * amounts add back to the printed extension, a mark nobody can be sure of is held off and asked.
 * File It and an Undo read stored lines back through cleanLines, so it must be IDEMPOTENT.
 * Stand-ins only: supplier Northline Supply, nothing from anybody's books.
 */
const printed = (o: Record<string, unknown> = {}) => ({
  description: "1/2 in EMT connector",
  quantity: 10,
  unit_price: 1.25,
  amount: 12.5,
  category: "Materials",
  ...o,
});

describe("cleanLines reads the pen (cn-v1181)", () => {
  it("an ordinary line is exactly what it always was: no pen, no returned key", () => {
    const [l] = cleanLines([printed()]);
    expect(l).toEqual({ description: "1/2 in EMT connector", quantity: 10, unit_price: 1.25, amount: 12.5, category: "Materials", billable: true });
    expect("pen" in l).toBe(false);
    expect("returned" in l).toBe(false);
    // A pen the reader called null is no mark.
    expect(cleanLines([printed({ pen: null, hand_quantity: null })])).toEqual([l]);
  });

  it("a struck line keeps its printed price and comes off the customer's bill", () => {
    expect(cleanLines([printed({ pen: "struck" })])).toEqual([
      { description: "1/2 in EMT connector", quantity: 10, unit_price: 1.25, amount: 12.5, category: "Materials", billable: false, pen: "struck", returned: true },
    ]);
  });

  it("a hand quantity splits the printed extension, cent-exact: the kept line bills, the rest went back", () => {
    const out = cleanLines([printed({ quantity: 3, unit_price: 3.33, amount: 9.99, pen: "quantity", hand_quantity: 1 })]);
    expect(out).toEqual([
      { description: "1/2 in EMT connector", quantity: 1, unit_price: 3.33, amount: 3.33, category: "Materials", billable: true, pen: "quantity", returned: false },
      { description: "1/2 in EMT connector", quantity: 2, unit_price: 3.33, amount: 6.66, category: "Materials", billable: false, pen: "quantity", returned: true },
    ]);
    expect(Math.round((out[0].amount + out[1].amount) * 100)).toBe(999);
  });

  it("an unclear mark is held off the customer's bill and asked; a hand number larger than printed is unclear", () => {
    expect(cleanLines([printed({ pen: "unclear" })])).toEqual([
      { description: "1/2 in EMT connector", quantity: 10, unit_price: 1.25, amount: 12.5, category: "Materials", billable: false, pen: "unclear" },
    ]);
    expect(cleanLines([printed({ pen: "quantity", hand_quantity: 14 })])[0]).toMatchObject({ pen: "unclear", billable: false });
  });

  it("a part-used amount stays only on a line that still bills after its mark", () => {
    // Struck: off the bill, so no part of it bills.
    expect(cleanLines([printed({ pen: "struck", billed_amount: 5 })])[0].billed_amount).toBeUndefined();
    // Split 10 -> 6 kept ($7.50): the kept half keeps a part that fits it, the returned half none.
    const [kept, back] = cleanLines([printed({ pen: "quantity", hand_quantity: 6, billed_amount: 5 })]);
    expect(kept).toMatchObject({ amount: 7.5, billed_amount: 5 });
    expect(back.billed_amount).toBeUndefined();
    // A part larger than the kept half is not a part of it.
    expect(cleanLines([printed({ pen: "quantity", hand_quantity: 2, billed_amount: 5 })])[0].billed_amount).toBeUndefined();
    // An ordinary line keeps its part, as before.
    expect(cleanLines([printed({ billed_amount: 5 })])[0].billed_amount).toBe(5);
  });

  it("a person's answer on a stored line stands: Returned and Kept pass through", () => {
    expect(cleanLines([printed({ pen: "struck", returned: false, billable: true })])[0]).toMatchObject({ pen: "struck", returned: false, billable: true });
    expect(cleanLines([printed({ returned: true })])[0]).toMatchObject({ returned: true, billable: false });
  });

  it("the 100-line cap applies after the split", () => {
    const raw = Array.from({ length: 60 }, (_, i) => printed({ description: `Part ${i}`, pen: "quantity", hand_quantity: 4 }));
    const out = cleanLines(raw);
    expect(out).toHaveLength(100);
    expect(out[99]).toMatchObject({ description: "Part 49", returned: true });
  });

  it("IDEMPOTENT: struck, split, unclear and answered lines read back exactly as they were written", () => {
    const table = [
      printed({ description: "Struck", pen: "struck" }),
      printed({ description: "Split", pen: "quantity", hand_quantity: 7, billed_amount: 2 }),
      printed({ description: "Unclear", pen: "unclear" }),
      printed({ description: "Answered kept", pen: "struck", returned: false, billable: true }),
      printed({ description: "Answered returned", pen: "struck", returned: true }),
      printed({ description: "Ice", category: "Food & Drink", pen: "struck" }),
      printed({ description: "Plain" }),
      printed({ description: "Sales tax", category: "Tax", quantity: 1, unit_price: 0.98, amount: 0.98 }),
    ];
    const once = cleanLines(table);
    expect(once).toHaveLength(table.length + 1);
    expect(cleanLines(once)).toEqual(once);
    // ...and through JSON, the way a tray row stores them.
    expect(cleanLines(JSON.parse(JSON.stringify(once)))).toEqual(once);
    // What the pen came to is the same on the second read.
    expect(penSummary(cleanLines(once))).toEqual(penSummary(once));
    expect(penSummary(once)).toMatchObject({ struck: 4, quantity: 1, unclear: 1 });
  });
});

describe("a tax line never takes a pen mark (cn-v1184, B1)", () => {
  const tax = (o: Record<string, unknown> = {}) =>
    printed({ description: "Sales tax", category: "Tax", quantity: 1, unit_price: 9.6, amount: 9.6, ...o });

  it("the reader's struck tax line beside struck and kept items: the tax comes out ordinary and billable, the items as before", () => {
    const out = cleanLines([
      printed({ description: "Struck part", pen: "struck" }),
      printed({ description: "Kept part" }),
      printed({ description: "Split part", pen: "quantity", hand_quantity: 4 }),
      tax({ pen: "struck" }),
    ]);
    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({ description: "Struck part", pen: "struck", returned: true, billable: false });
    expect(out[1]).toEqual({ description: "Kept part", quantity: 10, unit_price: 1.25, amount: 12.5, category: "Materials", billable: true });
    expect(out[2]).toMatchObject({ pen: "quantity", returned: false, billable: true, quantity: 4 });
    expect(out[3]).toMatchObject({ pen: "quantity", returned: true, billable: false, quantity: 6 });
    expect(out[4]).toEqual({ description: "Sales tax", quantity: 1, unit_price: 9.6, amount: 9.6, category: "Tax", billable: true });
  });

  it("a tax line by its printed words alone, struck or changed by hand or unclear: ordinary", () => {
    for (const pen of [{ pen: "struck" }, { pen: "unclear" }, { pen: "quantity", hand_quantity: 0 }]) {
      const [l] = cleanLines([tax({ category: null, description: "TAX", ...pen })]);
      expect(l).toMatchObject({ description: "TAX", billable: true });
      expect("pen" in l).toBe(false);
      expect("returned" in l).toBe(false);
    }
  });

  it("the stored shape the old read wrote on a tax line ({pen: struck, returned: true, billable: false}) reads back ordinary", () => {
    const [l] = cleanLines([tax({ pen: "struck", returned: true, billable: false })]);
    expect(l).toEqual({ description: "Sales tax", quantity: 1, unit_price: 9.6, amount: 9.6, category: "Tax", billable: true });
    // returned alone, with the off switch it brought: ordinary too.
    expect(cleanLines([tax({ returned: true, billable: false })])[0]).toMatchObject({ billable: true });
  });

  it("a tax line a person switched off with no mark on it stays off", () => {
    expect(cleanLines([tax({ billable: false })])).toEqual([
      { description: "Sales tax", quantity: 1, unit_price: 9.6, amount: 9.6, category: "Tax", billable: false },
    ]);
    // Crossed off on a receipt paid at purchase ({pen: struck, returned: false, billable: false}) was
    // the mark's doing, not a person's switch: ordinary and billable.
    expect(cleanLines([tax({ pen: "struck", returned: false, billable: false })])[0]).toMatchObject({ billable: true });
  });

  it("IDEMPOTENT over the sweep, with every mark a tax line could carry", () => {
    const table = [
      printed({ description: "Struck", pen: "struck" }),
      printed({ description: "Split", pen: "quantity", hand_quantity: 7, billed_amount: 2 }),
      printed({ description: "Unclear", pen: "unclear" }),
      printed({ description: "Answered kept", pen: "struck", returned: false, billable: true }),
      printed({ description: "Plain" }),
      tax({ pen: "struck" }),
      tax({ description: "Sales tax 2", pen: "unclear" }),
      tax({ description: "Sales tax 3", pen: "quantity", hand_quantity: 0.5 }),
      tax({ description: "Sales tax 4", pen: "struck", returned: true, billable: false }),
      tax({ description: "Sales tax 5", billable: false }),
    ];
    const once = cleanLines(table);
    expect(cleanLines(once)).toEqual(once);
    expect(cleanLines(JSON.parse(JSON.stringify(once)))).toEqual(once);
    expect(once.filter((l) => l.category === "Tax").map((l) => l.billable)).toEqual([true, true, true, true, false]);
    expect(once.filter((l) => l.category === "Tax").every((l) => !("pen" in l) && !("returned" in l))).toBe(true);
  });
});
