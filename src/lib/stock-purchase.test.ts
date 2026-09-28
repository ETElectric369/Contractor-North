import { describe, it, expect } from "vitest";
import {
  STOCK_HOW_MANY,
  STOCK_PICK_ITEM,
  STOCK_SAY_UNIT,
  STOCK_SAY_WHERE,
  stockPurchaseLine,
  stockPurchaseProblem,
  stockPurchaseStatus,
  stockPurchaseWords,
} from "./stock-purchase";

/** SHOP STOCK, TYPED IN (W1-FU-misc B): the pure half the sheet and addStockPurchase share. */
describe("a typed stock purchase, in words", () => {
  const ok = { itemId: null, newItemName: "12/2 NM-B", pieces: 250, unit: "ft", where: "CED" };

  it("asks, in this order: what it is, how many, the unit, where it was bought", () => {
    expect(stockPurchaseProblem({ ...ok, newItemName: "" })).toBe(STOCK_PICK_ITEM);
    expect(stockPurchaseProblem({ ...ok, pieces: 0 })).toBe(STOCK_HOW_MANY);
    expect(stockPurchaseProblem({ ...ok, pieces: 0.001 })).toBe(STOCK_HOW_MANY); // under a hundredth is nothing
    expect(stockPurchaseProblem({ ...ok, unit: " " })).toBe(STOCK_SAY_UNIT);
    expect(stockPurchaseProblem({ ...ok, where: "" })).toBe(STOCK_SAY_WHERE);
    expect(stockPurchaseProblem(ok)).toBeNull();
    expect(stockPurchaseProblem({ ...ok, itemId: "item-7", newItemName: null })).toBeNull();
    expect([STOCK_PICK_ITEM, STOCK_HOW_MANY, STOCK_SAY_UNIT, STOCK_SAY_WHERE]).toEqual([
      "Pick or name the item.",
      "Type how many.",
      "Say the unit.",
      "Say where it was bought.",
    ]);
  });

  it("On Account is never saved as paid: only Already Paid is", () => {
    expect(stockPurchaseStatus("paid")).toBe("paid");
    expect(stockPurchaseStatus("unpaid")).toBe("unpaid");
    expect(stockPurchaseStatus(undefined)).toBe("unpaid");
    expect(stockPurchaseStatus("Paid")).toBe("unpaid");
  });

  it("its one ticket line: the item, how many, the amount as the extension, a Materials line", () => {
    expect(stockPurchaseLine({ item: " 12/2 NM-B ", pieces: 250, amount: 180 })).toEqual({
      description: "12/2 NM-B",
      quantity: 250,
      unit_price: 0.72,
      amount: 180,
      category: "Materials",
      billable: true,
    });
    // The amount is the price, to the cent, whatever the division leaves.
    expect(stockPurchaseLine({ item: "Wire Nuts", pieces: 3, amount: 100 })).toMatchObject({ quantity: 3, unit_price: 33.33, amount: 100 });
  });

  it("says what landed where: '250 ft of 12/2 NM-B in stock, $180.00 from CED.'", () => {
    expect(stockPurchaseWords({ pieces: 250, unit: "ft", item: "12/2 NM-B", amount: 180, where: "CED" })).toBe("250 ft of 12/2 NM-B in stock, $180.00 from CED.");
    expect(stockPurchaseWords({ pieces: 12.5, unit: "each", item: "Straps", amount: 9.5, where: " Home Depot " })).toBe("12.5 each of Straps in stock, $9.50 from Home Depot.");
  });
});
