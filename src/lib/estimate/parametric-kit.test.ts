import { describe, it, expect } from "vitest";
import { kitItemQuantity, kitQuantities, kitIsParametric, sizingOf, type ParametricKitItem } from "./parametric-kit";

const item = (over: Partial<ParametricKitItem> = {}): ParametricKitItem => ({
  description: "Item",
  quantity: 1,
  ...over,
});

describe("existing kits are untouched", () => {
  it("a line with no coefficients returns its flat quantity", () => {
    const r = kitItemQuantity(item({ quantity: 12 }), { sqft: 300 });
    expect(r.quantity).toBe(12);
    expect(r.parametric).toBe(false);
  });

  it("a missing quantity still defaults to 1, exactly as the picker did", () => {
    expect(kitItemQuantity(item({ quantity: null }), {}).quantity).toBe(1);
  });

  it("an explicit 0 stays 0 — the kit author zeroed it on purpose", () => {
    expect(kitItemQuantity(item({ quantity: 0 }), { sqft: 300 }).quantity).toBe(0);
  });
});

describe("coefficients express a trade rule as data", () => {
  it("area-driven: deck footings at 1 per 60 sq ft, minimum 4, rounded up", () => {
    // This is deck.ts's `max(4, ceil(area/60))` written as three numbers instead of a function.
    const footing = item({ qty_per_sqft: 1 / 60, qty_min: 4, qty_round: "up" });
    expect(kitItemQuantity(footing, { sqft: 300 }).quantity).toBe(5); // 300/60 = 5
    expect(kitItemQuantity(footing, { sqft: 100 }).quantity).toBe(4); // 1.67 → floored to the minimum
    expect(kitItemQuantity(footing, { sqft: 305 }).quantity).toBe(6); // 5.08 → rounded up
  });

  it("length-driven: railing pickets per linear foot", () => {
    const r = kitItemQuantity(item({ qty_per_lf: 3, qty_round: "up" }), { linearFt: 46 });
    expect(r.quantity).toBe(138);
    expect(r.parametric).toBe(true);
  });

  it("both contribute — a deck needs decking by AREA and railing by PERIMETER", () => {
    const r = kitItemQuantity(item({ qty_per_sqft: 1, qty_per_lf: 2 }), { sqft: 100, linearFt: 10 });
    expect(r.quantity).toBe(120);
  });

  it("rounding is honoured: up (default), nearest, none", () => {
    const d = { sqft: 100 };
    expect(kitItemQuantity(item({ qty_per_sqft: 0.014 }), d).quantity).toBe(2); // 1.4 → up
    expect(kitItemQuantity(item({ qty_per_sqft: 0.014, qty_round: "nearest" }), d).quantity).toBe(1);
    expect(kitItemQuantity(item({ qty_per_sqft: 0.014, qty_round: "none" }), d).quantity).toBe(1.4);
  });

  it("rounds UP by default, because under-ordering sends someone back to the supply house", () => {
    expect(kitItemQuantity(item({ qty_per_sqft: 0.011 }), { sqft: 100 }).quantity).toBe(2);
  });
});

describe("an unmeasured dimension is a question, not a zero", () => {
  it("a coefficient with nothing to multiply falls back to the flat quantity", () => {
    // Treating "not measured" as 0 would silently delete the line from the estimate.
    const r = kitItemQuantity(item({ quantity: 6, qty_per_sqft: 0.5 }), { sqft: null });
    expect(r.quantity).toBe(6);
    expect(r.parametric).toBe(false);
    expect(r.basis).toMatch(/not measured/i);
  });

  it("zero square feet is treated the same as unmeasured, not as a zero-material job", () => {
    expect(kitItemQuantity(item({ quantity: 6, qty_per_sqft: 0.5 }), { sqft: 0 }).quantity).toBe(6);
  });

  it("the half that WAS measured still drives its own contribution", () => {
    const r = kitItemQuantity(item({ qty_per_sqft: 1, qty_per_lf: 2 }), { sqft: 100, linearFt: null });
    expect(r.quantity).toBe(100);
  });
});

describe("the number can always be explained", () => {
  it("the basis names the coefficients, the minimum, and the rounding", () => {
    const r = kitItemQuantity(item({ qty_per_sqft: 1 / 60, qty_min: 4, qty_round: "up" }), { sqft: 100 });
    expect(r.basis).toMatch(/sq ft/);
    expect(r.basis).toMatch(/minimum of 4/);
    expect(r.basis).toMatch(/rounded up/);
  });
  it("a flat line says so plainly", () => {
    expect(kitItemQuantity(item({ quantity: 3 }), {}).basis).toBe("kit quantity");
  });
});

describe("whole-kit helpers", () => {
  it("keeps the kit's authored order", () => {
    const rows = kitQuantities(
      [item({ description: "B", sort_order: 2 }), item({ description: "A", sort_order: 1 })],
      { sqft: 100 },
    );
    expect(rows.map((r) => r.description)).toEqual(["A", "B"]);
  });

  it("detects whether a kit needs measurements at all", () => {
    expect(kitIsParametric([item({ quantity: 2 })])).toBe(false);
    expect(kitIsParametric([item({ quantity: 2 }), item({ qty_per_lf: 3 })])).toBe(true);
    // A zero coefficient is not a coefficient.
    expect(kitIsParametric([item({ qty_per_sqft: 0 })])).toBe(false);
  });

  it("PostgREST numeric-as-string values are handled", () => {
    const r = kitItemQuantity(item({ quantity: "4", qty_per_sqft: "0.5", qty_min: "2" }), { sqft: 10 });
    expect(r.quantity).toBe(5);
  });
});

describe("a LINKED line sizes from its ITEM (0240)", () => {
  const linkedTo = (itemSizing: Record<string, unknown>, lineOver: Partial<ParametricKitItem> = {}): ParametricKitItem =>
    item({
      quantity: 6,
      price_list_item_id: "pli",
      price_list_items: { id: "pli", description: "Footing", unit: "ea", buy_price: 30, markup_pct: 0, ...itemSizing },
      ...lineOver,
    });

  it("sizingOf reads the item's coefficients when linked, the line's when not", () => {
    expect(sizingOf(linkedTo({ qty_per_sqft: 1 / 60, qty_min: 4, qty_round: "up" }))).toEqual({
      qty_per_sqft: 1 / 60, qty_per_lf: null, qty_min: 4, qty_round: "up",
    });
    expect(sizingOf(item({ qty_per_lf: 3 }))).toEqual({ qty_per_sqft: null, qty_per_lf: 3, qty_min: null, qty_round: null });
  });

  it("the item's rule drives the quantity; the line's stale coefficients are ignored", () => {
    // The line still carries a pre-0240 rule that would give 300 × 1 = 300; the item says
    // footings: 1 per 60 sq ft, min 4 — the item wins, because the rule belongs to the footing.
    const r = kitItemQuantity(linkedTo({ qty_per_sqft: 1 / 60, qty_min: 4, qty_round: "up" }, { qty_per_sqft: 1 }), { sqft: 300 });
    expect(r.quantity).toBe(5);
    expect(r.parametric).toBe(true);
  });

  it("a linked item with NO rule is a flat line — the line's stale coefficients do not resurrect it", () => {
    const r = kitItemQuantity(linkedTo({}, { qty_per_sqft: 1 }), { sqft: 300 });
    expect(r.quantity).toBe(6);
    expect(r.parametric).toBe(false);
  });

  it("quantity stays the LINE's when the item's rule can't size (dimension unmeasured)", () => {
    const r = kitItemQuantity(linkedTo({ qty_per_sqft: 0.5 }), { sqft: null });
    expect(r.quantity).toBe(6);
    expect(r.basis).toMatch(/not measured/i);
  });

  it("kitIsParametric and kitQuantities see through the link", () => {
    expect(kitIsParametric([linkedTo({ qty_per_lf: 3 })])).toBe(true);
    expect(kitIsParametric([linkedTo({})])).toBe(false);
    const rows = kitQuantities([linkedTo({ qty_per_lf: 3 }, { sort_order: 1 }), item({ description: "flat", sort_order: 0 })], { linearFt: 10 });
    expect(rows.map((r) => r.quantity)).toEqual([1, 30]);
  });
});
