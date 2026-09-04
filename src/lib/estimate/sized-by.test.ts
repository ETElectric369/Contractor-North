import { describe, it, expect } from "vitest";
import { kitItemQuantity, measurementValue } from "./parametric-kit";

/** 0241 — counted per ONE measurement of the org's own walk-through, not the deck's two. */
describe("counted per measurement", () => {
  const strap = { description: "1-1/2 2H COND STRAP", quantity: 1, unit: "ea", unit_price: 1.46, price_list_item_id: "i1",
    price_list_items: { id: "i1", description: "1-1/2 2H COND STRAP", unit: "ea", buy_price: 1.17, markup_pct: 0, sized_by: "run_ft", qty_per: 0.1, qty_min: 2, qty_round: "up" } };
  it("counts an item per a walk-through measurement by key", () => {
    const r = kitItemQuantity(strap, { byKey: { run_ft: 85 } });
    expect(r.parametric).toBe(true);
    expect(r.quantity).toBe(9); // 0.1 × 85 = 8.5 → up
    expect(r.basis).toContain("run ft");
  });
  it("keeps the kit quantity and says why when that measurement wasn't taken", () => {
    const r = kitItemQuantity(strap, { sqft: 400, byKey: {} });
    expect(r.parametric).toBe(false);
    expect(r.quantity).toBe(1);
    expect(r.basis).toContain("not measured");
  });
  it("honors the floor", () => {
    expect(kitItemQuantity(strap, { byKey: { run_ft: 5 } }).quantity).toBe(2);
  });
  it("maps the built-ins to the deck dimensions", () => {
    expect(measurementValue({ sqft: 320, linearFt: 72 }, "area_sqft")).toBe(320);
    expect(measurementValue({ sqft: 320, linearFt: 72 }, "length_lf")).toBe(72);
    expect(measurementValue({ byKey: { device_count: 12 } }, "device_count")).toBe(12);
  });
  it("still sizes a legacy per-sq-ft item when no generic pair is set", () => {
    const boards = { description: "Decking", quantity: 1, unit: "sq ft", unit_price: 12, qty_per_sqft: 1, qty_round: "up" };
    expect(kitItemQuantity(boards, { sqft: 250 }).quantity).toBe(250);
  });
});
