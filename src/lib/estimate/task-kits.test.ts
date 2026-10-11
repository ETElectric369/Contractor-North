import { describe, it, expect } from "vitest";
import { kitsWithoutMoney, partsKitsOnly, taskKitSelectRungs, taskKitsFrom, TASK_KIT_COLS } from "./task-kits";
import { expandTaskKit, type TaskKit } from "./task-lines";

/**
 * TASK KITS, READ (W4): only a kit with minutes is a task kit; one select shape with a fallback
 * for a database before 0386; and the Inspector's copy carries no money at all — but it carries the
 * vendors' NAMES, so a part previews under the same words the estimate will write (item 2, 2026-10-10).
 */
const FULL: TaskKit = {
  id: "k1",
  name: "Footing",
  labor_minutes: 120,
  unit: "footing",
  items: [
    { id: "i1", description: "Concrete (snapshot)", quantity: 4, unit: "ea", unit_price: 9.5, sort_order: 0, price_list_item_id: "pli-1",
      price_list_items: { id: "pli-1", code: "C80", description: "Concrete, 80 lb", unit: "ea", buy_price: 6, markup_pct: 25, qty_min: null, qty_round: "up", price_list_item_options: [] } },
    { id: "i2", description: "Rebar stake", quantity: 2, unit: "ea", unit_price: 1.25, sort_order: 1 },
    // A code with vendors (0282): the org's DEFAULT vendor names the line — "830 — Windows (Allowance) (Marvin, #M-1)".
    { id: "i3", description: "Window (snapshot)", quantity: 1, unit: "ea", unit_price: 1200, sort_order: 2, price_list_item_id: "pli-830",
      price_list_items: { id: "pli-830", code: "830", description: "Windows (Allowance)", unit: "ea", buy_price: 830, markup_pct: 20, qty_min: null, qty_round: null,
        price_list_item_options: [
          { id: "o-and", vendor: "Andersen", label: "400 Series", part_number: null, unit: "ea", buy_price: 640, markup_pct: 20, is_default: false, sort_order: 1, archived: false },
          { id: "o-mar", vendor: "Marvin", label: null, part_number: "M-1", unit: "ea", buy_price: 910.5, markup_pct: 22, is_default: true, sort_order: 0, archived: false },
        ] } },
  ],
};

describe("taskKitsFrom", () => {
  it("keeps only kits with minutes, coerced; an ordinary kit or a pre-0386 row is not a task kit", () => {
    const got = taskKitsFrom([
      { id: "k1", name: " Footing ", labor_minutes: "120", unit: " footing ", kit_items: [{ description: "x", quantity: 1 }] },
      { id: "k2", name: "Decks", kit_items: [] },
      { id: "k3", name: "Zero", labor_minutes: 0 },
      { id: "", name: "Nameless id", labor_minutes: 30 },
      null,
    ]);
    expect(got).toEqual([{ id: "k1", name: "Footing", labor_minutes: 120, unit: "footing", items: [{ description: "x", quantity: 1 }] }]);
    expect(taskKitsFrom(null)).toEqual([]);
    expect(taskKitsFrom([{ id: "k4", name: "No unit", labor_minutes: 45.4 }])).toEqual([{ id: "k4", name: "No unit", labor_minutes: 45, unit: null, items: [] }]);
  });
});

describe("taskKitSelectRungs", () => {
  it("asks for 0386's columns first across every item rung, then without them", () => {
    const rungs = taskKitSelectRungs();
    expect(rungs[0].startsWith(`${TASK_KIT_COLS}, kit_items(`)).toBe(true);
    expect(rungs[rungs.length - 1].startsWith("id, name, kit_items(")).toBe(true);
    expect(rungs.filter((r) => r.includes("labor_minutes")).length).toBe(rungs.length / 2);
    const withCategory = taskKitSelectRungs("category");
    expect(withCategory[0].startsWith("id, name, labor_minutes, unit, category, kit_items(")).toBe(true);
    expect(withCategory[withCategory.length - 1].startsWith("id, name, category, kit_items(")).toBe(true);
  });
});

describe("kitsWithoutMoney", () => {
  it("drops every price field — the line's, the item's and each vendor's — and keeps the names, counts, sizing and the vendors' names", () => {
    const stripped = kitsWithoutMoney([FULL]);
    const json = JSON.stringify(stripped);
    for (const money of ["unit_price", "markup_pct", "9.5", "1.25", "1200", "830,", "640", "910.5"]) expect(json).not.toContain(money);
    expect(json).not.toMatch(/"buy_price":\s*[0-9]/); // the key may ride (the type names it); a figure never does
    expect(stripped[0].items[0]).toMatchObject({ description: "Concrete (snapshot)", quantity: 4, price_list_items: { code: "C80", description: "Concrete, 80 lb", qty_round: "up" } });
    // The vendors ride by NAME only: an allow-list of naming fields, buy_price null, no markup.
    const linked = (stripped[0].items[2] as { price_list_items: { price_list_item_options: unknown[] } }).price_list_items;
    expect(linked.price_list_item_options).toEqual([
      { id: "o-and", vendor: "Andersen", label: "400 Series", part_number: null, unit: "ea", buy_price: null, is_default: false, sort_order: 1, archived: false },
      { id: "o-mar", vendor: "Marvin", label: null, part_number: "M-1", unit: "ea", buy_price: null, is_default: true, sort_order: 0, archived: false },
    ]);
    expect(stripped[0].items[1]).toEqual({
      id: "i2", description: "Rebar stake", quantity: 2, unit: "ea", sort_order: 1,
      qty_per_sqft: null, qty_per_lf: null, qty_min: null, qty_round: null, price_list_item_id: null,
    });
    // An ALLOW-list: a money column nobody has thought of yet never rides through.
    const sneaky = kitsWithoutMoney([{ ...FULL, items: [{ ...FULL.items[1], cost: 5, markup: 30 } as never] }]);
    expect(JSON.stringify(sneaky)).not.toMatch(/cost|markup/);
    expect(Object.keys(stripped[0])).toEqual(["id", "name", "labor_minutes", "unit", "items"]);
  });

  it("partsKitsOnly keeps the ordinary kits out of a task kit's way, and task kits out of the plain pickers", () => {
    const rows = [{ id: "a", name: "Decks" }, { id: "b", name: "Footing", labor_minutes: 120 }, { id: "c", name: "Parts", labor_minutes: null }];
    expect(partsKitsOnly(rows).map((k) => k.id)).toEqual(["a", "c"]);
    expect(partsKitsOnly(null)).toEqual([]);
  });

  it("expands to the same names and counts as the full kit — the default vendor named in the words — with no price in sight", () => {
    const task = { id: "t1", name: "Footings", hours: null, units: 7, kit_id: "k1", materials: [] };
    const full = expandTaskKit(task, FULL, { orgDefaultPct: 0 });
    const bare = expandTaskKit(task, kitsWithoutMoney([FULL])[0], { orgDefaultPct: 0 });
    expect(bare.hours).toBe(14);
    expect(bare.materials.map((m) => [m.name, m.qty])).toEqual(full.materials.map((m) => [m.name, m.qty]));
    // The case that used to disagree: the estimate writes the default vendor into the part's words; so does the preview now.
    expect(full.materials[2].name).toBe("Windows (Allowance) (Marvin, #M-1)");
    expect(bare.materials[2].name).toBe("Windows (Allowance) (Marvin, #M-1)");
    expect(bare.materials[2].code).toBe("830");
    // No sell at all, and no cost above nothing: a linked line without its buy price prices at 0.
    expect(bare.materials.every((m) => m.sell === null && !(Number(m.cost) > 0))).toBe(true);
  });
});
