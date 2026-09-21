import { describe, it, expect } from "vitest";
import { hasItemOptions, itemOptionChoices, normalizeItemOptions } from "@/lib/pricing/item-options";

/**
 * THE DOOR, PINNED. The wave that built price_list_item_options wrote the table, a server action
 * and a pure resolver, and wired none of them to a screen - every quote still priced at the
 * allowance while the price-list tab said the item now priced at Marvin. AddLineItems is the one
 * component both quote screens and the PO screen add a price-list line through, so these assert
 * the shape that component now renders from.
 *
 * The fixture is Vivian Builders' real item: code 830, "Windows (Materials) (Allowance)", $830.00,
 * markup 0, unit ea - read from the live database on 2026-09-20.
 */
const item830 = {
  id: "vb-830",
  code: "830",
  description: "Windows (Materials) (Allowance)",
  unit: "ea",
  buy_price: 830,
  markup_pct: 0,
  price_list_item_options: [
    { id: "o-and", vendor: "Andersen", label: "400 Series", part_number: null, unit: null, buy_price: 1240, markup_pct: null, is_default: true, sort_order: 0 },
    { id: "o-mil", vendor: "Milgard", label: "Tuscany", part_number: null, unit: null, buy_price: 910, markup_pct: null, is_default: false, sort_order: 1 },
    { id: "o-mar", vendor: "Marvin", label: null, part_number: null, unit: null, buy_price: 1615, markup_pct: null, is_default: false, sort_order: 2 },
  ],
};

describe("the maker rows AddLineItems renders", () => {
  it("offers the allowance first, then every maker in the org's order", () => {
    const rows = itemOptionChoices(item830 as never, { orgDefaultPct: 20 });
    expect(rows.map((r) => r.makerLabel)).toEqual([
      "No Maker Picked",
      "Andersen 400 Series",
      "Milgard Tuscany",
      "Marvin",
    ]);
  });

  it("puts the maker in the description, because that is what the customer reads", () => {
    const rows = itemOptionChoices(item830 as never, { orgDefaultPct: 20 });
    expect(rows[1].description).toContain("Andersen 400 Series");
    expect(rows[0].description).not.toContain("Andersen");
  });

  it("prices each maker off its OWN cost through the org markup, not the allowance", () => {
    const rows = itemOptionChoices(item830 as never, { orgDefaultPct: 20 });
    expect(rows[0].unitPrice).toBe(996); // 830 allowance + 20%
    expect(rows[1].unitPrice).toBe(1488); // 1240 Andersen + 20%
    expect(rows[3].unitPrice).toBe(1938); // 1615 Marvin + 20%
  });

  it("lets the customer's pricing level outrank the org default, as it does everywhere else", () => {
    const rows = itemOptionChoices(item830 as never, { levelPct: 10, orgDefaultPct: 20 });
    expect(rows[1].unitPrice).toBe(1364); // 1240 + 10%, the level wins
  });

  it("marks the one the office flagged, so the list opens on an answer", () => {
    const rows = itemOptionChoices(item830 as never, {});
    expect(rows.filter((r) => r.isDefault).map((r) => r.makerLabel)).toEqual(["Andersen 400 Series"]);
  });

  it("leaves an item with no makers exactly as it was", () => {
    const plain = { id: "x", code: "835", description: "Windows (Installation)", unit: "ea", buy_price: 835, markup_pct: 0 };
    expect(hasItemOptions(plain as never)).toBe(false);
    expect(normalizeItemOptions(undefined)).toEqual([]);
    // One row, the item's own, which is why the picker can add it on the first tap as before.
    expect(itemOptionChoices(plain as never, { orgDefaultPct: 20 })).toHaveLength(1);
  });

  it("does not offer a maker that was archived since the page rendered", () => {
    // The embed filters archived rows, but a stale page is the real case: normalizeItemOptions is
    // what both the picker and the server action read, so it has to agree with the database.
    const withArchived = {
      ...item830,
      price_list_item_options: [...item830.price_list_item_options, { id: "o-old", vendor: "Pella", label: null, part_number: null, unit: null, buy_price: 700, markup_pct: null, is_default: false, sort_order: 3, archived: true }],
    };
    expect(itemOptionChoices(withArchived as never, {}).map((r) => r.makerLabel)).not.toContain("Pella");
  });
});
