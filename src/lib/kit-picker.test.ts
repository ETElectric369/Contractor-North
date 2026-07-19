import { describe, expect, it } from "vitest";
import {
  kitItemsToPickerRows,
  kitSelectionToLines,
  kitSelectionSubtotal,
  type KitPickerRow,
} from "./kit-picker";

const row = (over: Partial<KitPickerRow> = {}): KitPickerRow => ({
  id: undefined,
  description: "Item",
  quantity: 1,
  unit: "ea",
  unit_price: 10,
  sort_order: 0,
  checked: true,
  ...over,
});

describe("kitItemsToPickerRows", () => {
  it("pre-checks every item (open → Add keeps the one-tap import)", () => {
    const rows = kitItemsToPickerRows([
      { id: "a", description: "Wire", quantity: 2, unit: "ft", unit_price: 1.5, sort_order: 0 },
      { id: "b", description: "Breaker", quantity: 1, unit: "ea", unit_price: 40, sort_order: 1 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.checked)).toBe(true);
  });

  it("orders by sort_order regardless of input order", () => {
    const rows = kitItemsToPickerRows([
      { id: "c", description: "Third", quantity: 1, unit: "ea", unit_price: 3, sort_order: 2 },
      { id: "a", description: "First", quantity: 1, unit: "ea", unit_price: 1, sort_order: 0 },
      { id: "b", description: "Second", quantity: 1, unit: "ea", unit_price: 2, sort_order: 1 },
    ]);
    expect(rows.map((r) => r.description)).toEqual(["First", "Second", "Third"]);
  });

  it("keeps input order for equal sort_order (legacy rows all default 0)", () => {
    const rows = kitItemsToPickerRows([
      { id: "a", description: "A", quantity: 1, unit: "ea", unit_price: 1, sort_order: 0 },
      { id: "b", description: "B", quantity: 1, unit: "ea", unit_price: 1, sort_order: 0 },
      { id: "c", description: "C", quantity: 1, unit: "ea", unit_price: 1, sort_order: 0 },
    ]);
    expect(rows.map((r) => r.description)).toEqual(["A", "B", "C"]);
  });

  it("coerces stringy/blank numerics the way the old instant-import did (missing qty → 1, price → 0)", () => {
    const [r] = kitItemsToPickerRows([
      { id: "a", description: "Odd", quantity: "2.5", unit: null, unit_price: "" as unknown as string, sort_order: null },
    ]);
    expect(r.quantity).toBe(2.5);
    expect(r.unit).toBe("ea");
    expect(r.unit_price).toBe(0);
    expect(r.sort_order).toBe(0);
    for (const missing of [null, undefined as unknown as null, "" as unknown as string, "x" as unknown as string]) {
      const [m] = kitItemsToPickerRows([
        { id: "m", description: "Missing qty", quantity: missing, unit: "ea", unit_price: 5, sort_order: 0 },
      ]);
      expect(m.quantity).toBe(1);
      expect(m.checked).toBe(true);
    }
  });

  it("keeps an explicit qty 0 at 0 and opens the row UNCHECKED (the author zeroed it on the kit)", () => {
    // The write path (kit-actions updateKitItems/addKitItem) persists 0 as a legal template
    // value; re-inflating it to 1 here silently re-billed the line on the next estimate.
    for (const zero of [0, "0" as unknown as string]) {
      const [z] = kitItemsToPickerRows([
        { id: "b", description: "Zero qty", quantity: zero, unit: "ea", unit_price: 5, sort_order: 0 },
      ]);
      expect(z.quantity).toBe(0);
      expect(z.checked).toBe(false);
    }
  });
});

describe("kitSelectionToLines", () => {
  it("maps only the checked rows", () => {
    const lines = kitSelectionToLines("Decks", [
      row({ description: "Keep", sort_order: 0 }),
      row({ description: "Skip", sort_order: 1, checked: false }),
      row({ description: "Keep too", sort_order: 2 }),
    ]);
    expect(lines.map((l) => l.description)).toEqual(["Keep", "Keep too"]);
  });

  it("carries the edited qty and price (the quote is the instance)", () => {
    const [l] = kitSelectionToLines("Kit", [
      row({ description: "Edited", quantity: 7, unit_price: 12.34 }),
    ]);
    expect(l.quantity).toBe(7);
    expect(l.unit_price).toBe(12.34);
    expect(l.unit).toBe("ea");
  });

  it("tags every line with the kit name as its group", () => {
    const lines = kitSelectionToLines("Stairs", [row(), row({ sort_order: 1 })]);
    expect(lines.every((l) => l.group === "Stairs")).toBe(true);
  });

  it("preserves kit order even when rows arrive shuffled", () => {
    const lines = kitSelectionToLines("Kit", [
      row({ description: "Last", sort_order: 9 }),
      row({ description: "First", sort_order: 1 }),
      row({ description: "Middle", sort_order: 5 }),
    ]);
    expect(lines.map((l) => l.description)).toEqual(["First", "Middle", "Last"]);
  });

  it("drops blank-description rows (the quote save filters them anyway)", () => {
    const lines = kitSelectionToLines("Kit", [row({ description: "  " }), row({ description: "Real" })]);
    expect(lines).toHaveLength(1);
    expect(lines[0].description).toBe("Real");
  });

  it("keeps a user-cleared qty at 0 — never re-inflated to 1 (the row's total reads $0.00)", () => {
    // A 0 is a deliberate value — an in-picker edit or a template 0 the kit author saved
    // (kitItemsToPickerRows keeps it); silently charging 1 × price for it would make the
    // footer disagree with the $0.00 the row itself shows.
    const [l] = kitSelectionToLines("Kit", [row({ quantity: 0, unit_price: 500 })]);
    expect(l.quantity).toBe(0);
  });

  it("includes an add-on row that has no id yet", () => {
    const lines = kitSelectionToLines("Kit", [
      row({ id: "a", description: "Persisted", sort_order: 0 }),
      row({ id: undefined, description: "Just added", sort_order: 1 }),
    ]);
    expect(lines.map((l) => l.description)).toEqual(["Persisted", "Just added"]);
  });
});

describe("kitSelectionSubtotal", () => {
  it("sums only the checked rows with THE shared cent rounding", () => {
    const sub = kitSelectionSubtotal([
      row({ quantity: 3, unit_price: 0.1, sort_order: 0 }), // 0.30000000000000004 raw
      row({ quantity: 1, unit_price: 19.99, sort_order: 1 }),
      row({ quantity: 100, unit_price: 100, sort_order: 2, checked: false }),
    ]);
    expect(sub).toBe(20.29);
  });

  it("is 0 for an empty/none-checked selection", () => {
    expect(kitSelectionSubtotal([])).toBe(0);
    expect(kitSelectionSubtotal([row({ checked: false })])).toBe(0);
  });

  it("a cleared-qty row contributes $0 — the footer matches the row's on-screen total", () => {
    expect(
      kitSelectionSubtotal([
        row({ quantity: 0, unit_price: 500, sort_order: 0 }),
        row({ quantity: 2, unit_price: 10, sort_order: 1 }),
      ]),
    ).toBe(20);
  });
});
