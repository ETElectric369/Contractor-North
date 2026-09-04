import { describe, it, expect } from "vitest";
import { autoMapPriceHeaders } from "./csv-map";

describe("autoMapPriceHeaders — one column never feeds two fields", () => {
  it("reads a 'Cost Code' column as the code, never as the cost (the Vivian Builders damage)", () => {
    const m = autoMapPriceHeaders(["Cost Code", "Description", "Unit", "Unit Cost"]);
    expect(m.code).toBe(0);
    expect(m.description).toBe(1);
    expect(m.unit).toBe(2);
    expect(m.buy_price).toBe(3);
  });
  it("leaves cost unmapped rather than reuse the code column when no price column exists", () => {
    const m = autoMapPriceHeaders(["Cost Code", "Description"]);
    expect(m.code).toBe(0);
    expect(m.buy_price).toBeUndefined();
  });
  it("maps the usual supplier export", () => {
    const m = autoMapPriceHeaders(["SKU", "Product Name", "Category", "Vendor", "UOM", "Net Price", "Markup"]);
    expect(m).toEqual({ code: 0, description: 1, category: 2, supplier: 3, unit: 4, buy_price: 5, markup_pct: 6 });
  });
  it("does not let 'Unit Price' be taken as the unit column", () => {
    const m = autoMapPriceHeaders(["Item", "Description", "Unit Price"]);
    expect(m.unit).toBeUndefined();
    expect(m.buy_price).toBe(2);
  });
});
