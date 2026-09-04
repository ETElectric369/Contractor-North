import { describe, it, expect } from "vitest";
import { sellPrice, markupFromSell, marginFromMarkup, markupFromMargin } from "./markup";

describe("the sell arithmetic, once", () => {
  it("prices to cents", () => {
    expect(sellPrice(38, 35)).toBe(51.3);
    expect(sellPrice(0.67, 25)).toBe(0.84);
    expect(sellPrice(100, 0)).toBe(100);
  });
  it("back-solves markup from a typed sell price", () => {
    expect(markupFromSell(38, 51.3)).toBe(35);
    expect(markupFromSell(100, 100)).toBe(0);
    expect(markupFromSell(0, 50)).toBe(0);
  });
  it("converts between markup and margin both ways", () => {
    expect(marginFromMarkup(25)).toBe(20);
    expect(marginFromMarkup(35)).toBe(25.9);
    expect(markupFromMargin(20)).toBe(25);
    expect(markupFromMargin(0)).toBe(0);
  });
});
