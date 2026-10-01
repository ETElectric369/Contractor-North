import { describe, it, expect } from "vitest";
import { lineExtension, listMoney, listTotalCaveat } from "./materials-money";

/**
 * A MATERIALS LIST'S MONEY, LINE BY LINE (item C4, from Erik's report on /materials/<id>).
 *
 * The footer summed `(est_cost ?? 0) × quantity`, so every line nobody had priced counted as zero and
 * nothing on the screen said so: a list of twenty lines where six had no price printed a total that
 * looked finished and was short by whatever those six cost.
 */
describe("one line's own money", () => {
  it("is the extension: how many × the price each", () => {
    expect(lineExtension({ quantity: 12, est_cost: 18.66 })).toBe(223.92);
  });

  it("is NOTHING, not zero, when nobody has priced it", () => {
    expect(lineExtension({ quantity: 12, est_cost: null })).toBeNull();
    expect(lineExtension({ quantity: 12 })).toBeNull();
  });

  it("an explicit zero is a real answer (a line thrown in free)", () => {
    expect(lineExtension({ quantity: 12, est_cost: 0 })).toBe(0);
  });

  it("rounds to the cent, so the footer and the lines add up to the same figure", () => {
    expect(lineExtension({ quantity: 3, est_cost: 0.335 })).toBe(1.01);
  });
});

describe("the whole list", () => {
  it("totals the priced lines and counts the ones it left out", () => {
    const money = listMoney([
      { quantity: 12, est_cost: 18.66 },
      { quantity: 2, est_cost: 10 },
      { quantity: 5, est_cost: null },
      { quantity: 1 },
    ]);
    expect(money).toEqual({ total: 243.92, priced: 2, unpriced: 2 });
  });

  it("an empty list is zero and says nothing", () => {
    expect(listMoney([])).toEqual({ total: 0, priced: 0, unpriced: 0 });
    expect(listTotalCaveat(listMoney([]))).toBeNull();
  });
});

describe("what the figure leaves out is SAID", () => {
  it("names how many lines are not in the total", () => {
    expect(listTotalCaveat({ total: 100, priced: 3, unpriced: 2 })).toBe(
      "2 lines have no price on them yet, so they are not in that total.",
    );
    expect(listTotalCaveat({ total: 100, priced: 3, unpriced: 1 })).toBe(
      "1 line has no price on it yet, so it is not in that total.",
    );
  });

  it("says there is nothing to total when NO line has a price", () => {
    expect(listTotalCaveat({ total: 0, priced: 0, unpriced: 6 })).toMatch(/nothing to total/);
    expect(listTotalCaveat({ total: 0, priced: 0, unpriced: 1 })).toBe("This line has no price on it yet, so there is nothing to total.");
  });

  it("says nothing when the total covers the whole list", () => {
    expect(listTotalCaveat({ total: 100, priced: 4, unpriced: 0 })).toBeNull();
  });
});
