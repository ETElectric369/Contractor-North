import { describe, it, expect } from "vitest";
import { kitsWithoutMoney, taskKitSelectRungs, taskKitsFrom, TASK_KIT_COLS } from "./task-kits";
import { expandTaskKit, type TaskKit } from "./task-lines";

/**
 * TASK KITS, READ (W4): only a kit with minutes is a task kit; one select shape with a fallback
 * for a database before 0386; and the Inspector's copy carries no money at all.
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
  it("drops every price field and keeps the names, counts and sizing", () => {
    const stripped = kitsWithoutMoney([FULL]);
    const json = JSON.stringify(stripped);
    for (const money of ["unit_price", "buy_price", "markup_pct", "price_list_item_options", "9.5", "1.25"]) expect(json).not.toContain(money);
    expect(stripped[0].items[0]).toMatchObject({ description: "Concrete (snapshot)", quantity: 4, price_list_items: { code: "C80", description: "Concrete, 80 lb", qty_round: "up" } });
    expect(stripped[0].items[1]).toEqual({ id: "i2", description: "Rebar stake", quantity: 2, unit: "ea", sort_order: 1 });
  });

  it("expands to the same names and counts as the full kit, with no price in sight", () => {
    const task = { id: "t1", name: "Footings", hours: null, units: 7, kit_id: "k1", materials: [] };
    const full = expandTaskKit(task, FULL, { orgDefaultPct: 0 });
    const bare = expandTaskKit(task, kitsWithoutMoney([FULL])[0], { orgDefaultPct: 0 });
    expect(bare.hours).toBe(14);
    expect(bare.materials.map((m) => [m.name, m.qty])).toEqual(full.materials.map((m) => [m.name, m.qty]));
    // No sell at all, and no cost above nothing: a linked line without its buy price prices at 0.
    expect(bare.materials.every((m) => m.sell === null && !(Number(m.cost) > 0))).toBe(true);
  });
});
