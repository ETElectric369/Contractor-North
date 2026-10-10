import { describe, it, expect } from "vitest";
import { kitFromTaskDetail, kitNameFromLine, rememberKit } from "./kit-from-task";
import { fakeDb } from "@/test/fake-supabase";
import type { TaskDetail } from "./line-map";

/**
 * REMEMBER A PRICED TASK AS A KIT (W4). A task line carries TOTAL hours and TOTAL counts for ×N
 * units; the kit is PER UNIT (0386). A kit that would have to guess is refused with the one action
 * that would let it be made. The database rule reads back every id, links codes to the book, keeps
 * one kit per name, and takes a kit away again when its parts fail.
 */
const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  task_id: "t1",
  hours: 14,
  rate: 145,
  units: 7,
  kit_id: null,
  materials: [
    { code: "C80", name: "Concrete, 80 lb", qty: 28, cost: 6, sell: 7.5 },
    { code: null, name: "Rebar stake", qty: 14, cost: null, sell: null },
  ],
  ...over,
});

describe("kitNameFromLine", () => {
  it("drops the units the line's name carries", () => {
    expect(kitNameFromLine("Footings ×7")).toBe("Footings");
    expect(kitNameFromLine("Footings × 7.5")).toBe("Footings");
    expect(kitNameFromLine("  Footings ")).toBe("Footings");
    expect(kitNameFromLine("Run 7 circuits")).toBe("Run 7 circuits");
  });
});

describe("kitFromTaskDetail: per unit, from his totals", () => {
  it("divides his hours and counts by the units; a part's sell rides, a missing sell is 0 (asks)", () => {
    const r = kitFromTaskDetail(detail(), { name: " Footing ", unit: " footing " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kit).toEqual({ name: "Footing", unit: "footing", labor_minutes: 120 });
    expect(r.value.items).toEqual([
      { code: "C80", description: "Concrete, 80 lb", quantity: 4, unit: "ea", unit_price: 7.5, sort_order: 0 },
      { code: null, description: "Rebar stake", quantity: 2, unit: "ea", unit_price: 0, sort_order: 1 },
    ]);
  });

  it("a task without units is one unit of itself, and the unit word defaults to ea", () => {
    const r = kitFromTaskDetail(detail({ units: null, hours: 1.5, materials: [{ code: null, name: "Breaker", qty: 3, cost: null, sell: 40 }] }), { name: "Breaker swap", unit: "" });
    expect(r).toEqual({
      ok: true,
      value: { kit: { name: "Breaker swap", unit: "ea", labor_minutes: 90 }, items: [{ code: null, description: "Breaker", quantity: 3, unit: "ea", unit_price: 40, sort_order: 0 }] },
    });
  });

  it("a labor-only task is a kit with no lines", () => {
    const r = kitFromTaskDetail(detail({ materials: [] }), { name: "Footing", unit: "footing" });
    expect(r.ok && r.value.items).toEqual([]);
  });

  it("refuses without a name", () => {
    expect(kitFromTaskDetail(detail(), { name: "  ", unit: "footing" })).toEqual({ ok: false, error: "Give the kit a name." });
  });

  it("refuses a task without hours — a kit never remembers a typical figure", () => {
    const r = kitFromTaskDetail(detail({ hours: null }), { name: "Footing", unit: "footing" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Give the task its hours first");
  });

  it("refuses a part without a count, naming it — a missing count is never a silent 1 per unit", () => {
    const r = kitFromTaskDetail(
      detail({ materials: [...detail().materials, { code: null, name: "Gravel", qty: null, cost: null, sell: null }] }),
      { name: "Footing", unit: "footing" },
    );
    expect(r).toEqual({ ok: false, error: "Give every part a count first: Gravel." });
  });

  it("a nameless part is not a part (it prices nothing today either)", () => {
    const r = kitFromTaskDetail(detail({ materials: [{ code: null, name: "  ", qty: null, cost: null, sell: null }] }), { name: "Footing", unit: "footing" });
    expect(r.ok && r.value.items).toEqual([]);
  });

  it("refuses hours that round to no minutes per unit", () => {
    const r = kitFromTaskDetail(detail({ hours: 0.001 }), { name: "Footing", unit: "footing" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("less than a minute per unit");
  });
});

describe("rememberKit: one name, one kit; codes link to the book; no half a kit", () => {
  const made = kitFromTaskDetail(detail(), { name: "Footing", unit: "footing" });
  const value = made.ok ? made.value : (() => { throw new Error("fixture"); })();

  it("writes the kit and its lines, reading the ids back; the coded part links to the book's live item", async () => {
    const { sb, inserted } = fakeDb({
      kits: [],
      price_list_items: [
        { id: "pli-old", code: "C80", archived: true },
        { id: "pli-1", code: "C80", archived: false },
      ],
    });
    const r = await rememberKit(sb, value);
    expect(r).toEqual({ ok: true, id: "kits-1", name: "Footing" });
    expect(inserted.kits).toEqual([{ name: "Footing", unit: "footing", labor_minutes: 120, id: "kits-1" }]);
    expect(inserted.kit_items).toEqual([
      { kit_id: "kits-1", description: "Concrete, 80 lb", quantity: 4, unit: "ea", unit_price: 7.5, sort_order: 0, price_list_item_id: "pli-1", id: "kit_items-2" },
      { kit_id: "kits-1", description: "Rebar stake", quantity: 2, unit: "ea", unit_price: 0, sort_order: 1, id: "kit_items-3" },
    ]);
  });

  it("a code the book no longer carries stays a frozen line at the sell the task had", async () => {
    const { sb, inserted } = fakeDb({ kits: [], price_list_items: [] });
    const r = await rememberKit(sb, value);
    expect(r.ok).toBe(true);
    expect(inserted.kit_items?.[0]).not.toHaveProperty("price_list_item_id");
    expect(inserted.kit_items?.[0].unit_price).toBe(7.5);
  });

  it("refuses a second kit by the same name, case blind, writing nothing", async () => {
    const { sb, inserted } = fakeDb({ kits: [{ id: "k0", name: "footing" }], price_list_items: [] });
    const r = await rememberKit(sb, value);
    expect(r).toEqual({ ok: false, error: "A kit named Footing already exists — pick another name." });
    expect(inserted.kits).toBeUndefined();
    expect(inserted.kit_items).toBeUndefined();
  });

  it("takes the kit away again when its parts fail — half a kit would price every future task short", async () => {
    const { sb, tables } = fakeDb(
      { kits: [], price_list_items: [] },
      { onInsert: (table) => (table === "kit_items" ? { code: "23514", message: "check constraint" } : undefined) },
    );
    const r = await rememberKit(sb, value);
    expect(r.ok).toBe(false);
    expect(tables.kits).toEqual([]);
  });

  it("a labor-only kit writes no lines and is kept", async () => {
    const { sb, inserted } = fakeDb({ kits: [], price_list_items: [] });
    const r = await rememberKit(sb, { ...value, items: [] });
    expect(r).toEqual({ ok: true, id: "kits-1", name: "Footing" });
    expect(inserted.kit_items).toBeUndefined();
  });
});
