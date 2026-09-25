import { describe, expect, it } from "vitest";
import {
  firstThatWorks,
  kitLineCost,
  kitLineSizing,
  kitLineView,
  kitsSelectRungs,
  lineDisplayName,
  linkedItemOf,
  type KitLineRaw,
  type KitLinkedItem,
} from "./kit-line";

const item = (over: Partial<KitLinkedItem> = {}): KitLinkedItem => ({
  id: "pli-1",
  code: "RACO 936",
  description: "4-inch square box",
  category: "Boxes",
  supplier: "CED",
  unit: "EA",
  buy_price: 2.5,
  markup_pct: 0,
  ...over,
});

const frozen = (over: Partial<KitLineRaw> = {}): KitLineRaw => ({
  id: "ki-1",
  description: "OLD — a snapshot",
  quantity: 3,
  unit: "each",
  unit_price: 9.99,
  sort_order: 2,
  ...over,
});

const linked = (itemOver: Partial<KitLinkedItem> = {}, lineOver: Partial<KitLineRaw> = {}): KitLineRaw =>
  frozen({ price_list_item_id: "pli-1", price_list_items: item(itemOver), ...lineOver });

describe("kitLineView — a frozen line is untouched", () => {
  it("returns the line's own values, byte-for-byte", () => {
    const v = kitLineView(frozen(), { orgDefaultPct: 40, levelPct: 10 });
    expect(v.linked).toBe(false);
    expect(v.description).toBe("OLD — a snapshot");
    expect(v.unit).toBe("each"); // frozen unit is NOT normalized — it is what the author typed
    expect(v.unit_price).toBe(9.99); // the org default and the level do NOT touch a frozen price
    expect(v.cost).toBeNull();
    expect(v.code).toBeNull();
    expect(v.sizing).toEqual({ sized_by: null, qty_per: null, qty_per_sqft: null, qty_per_lf: null, qty_min: null, qty_round: null });
  });

  it("a stale price_list_item_id with no embed is frozen, not broken", () => {
    const v = kitLineView(frozen({ price_list_item_id: "gone", price_list_items: null }), { orgDefaultPct: 40 });
    expect(v.linked).toBe(false);
    expect(v.unit_price).toBe(9.99);
  });

  it("stringy PostgREST numerics coerce; a blank price is 0", () => {
    expect(kitLineView(frozen({ unit_price: "12.5" }), { orgDefaultPct: 0 }).unit_price).toBe(12.5);
    expect(kitLineView(frozen({ unit_price: "" }), { orgDefaultPct: 0 }).unit_price).toBe(0);
  });
});

describe("kitLineView — a linked line is LIVE from the item", () => {
  it("takes name (with code), unit, category, supplier and cost from the item", () => {
    const v = kitLineView(linked(), { orgDefaultPct: 0 });
    expect(v.linked).toBe(true);
    expect(v.description).toBe("RACO 936 — 4-inch square box");
    expect(v.unit).toBe("ea"); // normalized: "EA" → "ea"
    expect(v.code).toBe("RACO 936");
    expect(v.category).toBe("Boxes");
    expect(v.supplier).toBe("CED");
    expect(v.cost).toBe(2.5);
  });

  it("sells through THE rule: item markup 0 → the org default applies", () => {
    const v = kitLineView(linked({ markup_pct: 0 }), { orgDefaultPct: 40 });
    expect(v.unit_price).toBe(3.5); // 2.50 × 1.40
  });

  it("an item's own markup (> 0) beats the org default", () => {
    const v = kitLineView(linked({ markup_pct: 20 }), { orgDefaultPct: 40 });
    expect(v.unit_price).toBe(3); // 2.50 × 1.20
  });

  it("a customer level ALWAYS wins — even at 0% (the gap: kits ignored the level)", () => {
    expect(kitLineView(linked({ markup_pct: 20 }), { orgDefaultPct: 40, levelPct: 10 }).unit_price).toBe(2.75);
    expect(kitLineView(linked({ markup_pct: 20 }), { orgDefaultPct: 40, levelPct: 0 }).unit_price).toBe(2.5);
  });

  it("no level (null/undefined) falls through to item → org default", () => {
    expect(kitLineView(linked({ markup_pct: 0 }), { orgDefaultPct: 40, levelPct: null }).unit_price).toBe(3.5);
    expect(kitLineView(linked({ markup_pct: 0 }), { orgDefaultPct: 40, levelPct: undefined }).unit_price).toBe(3.5);
  });

  it("the frozen snapshot on the line is IGNORED once linked", () => {
    const v = kitLineView(linked({}, { description: "stale", unit: "box", unit_price: 999 }), { orgDefaultPct: 0 });
    expect(v.description).toBe("RACO 936 — 4-inch square box");
    expect(v.unit).toBe("ea");
    expect(v.unit_price).toBe(2.5);
  });

  it("tolerates the embed arriving as a one-element array", () => {
    const line = frozen({ price_list_item_id: "pli-1", price_list_items: [item()] });
    expect(linkedItemOf(line)?.id).toBe("pli-1");
    expect(kitLineView(line, { orgDefaultPct: 0 }).linked).toBe(true);
  });

  it("rounds the sell to cents", () => {
    expect(kitLineView(linked({ buy_price: 1.005, markup_pct: 33 }), { orgDefaultPct: 0 }).unit_price).toBe(1.34);
  });
});

describe("kitLineView — a code with a default vendor quotes at that vendor (audit v994 VP2)", () => {
  const vendor = (over: Record<string, unknown> = {}) => ({
    id: "opt-marvin",
    vendor: "Marvin",
    label: null,
    part_number: null,
    unit: null,
    buy_price: "1610",
    markup_pct: null,
    is_default: true,
    sort_order: 1,
    archived: false,
    ...over,
  });
  const windows = (opts: unknown[]) =>
    linked({ code: "830", description: "Windows (Materials) (Allowance)", unit: "ea", buy_price: 830, markup_pct: 0, price_list_item_options: opts as never });

  it("prices, costs and names the default vendor, through the org default and the customer level", () => {
    const line = windows([vendor(), vendor({ id: "opt-andersen", vendor: "Andersen", buy_price: 900, is_default: false })]);
    const v = kitLineView(line, { orgDefaultPct: 25 });
    expect(v.description).toBe("830 — Windows (Materials) (Allowance) (Marvin)");
    expect(v.cost).toBe(1610);
    expect(v.unit_price).toBe(2012.5); // 1610 × 1.25, the price the typeahead quotes
    expect(v.vendor).toBe("Marvin");
    expect(kitLineView(line, { orgDefaultPct: 25, levelPct: 10 }).unit_price).toBe(1771);
    expect(kitLineCost(line)).toBe(1610);
  });

  it("no default, an archived default, or no vendors at all: the item's own number, as before", () => {
    for (const opts of [[vendor({ is_default: false })], [vendor({ archived: true })], []]) {
      const v = kitLineView(windows(opts), { orgDefaultPct: 25 });
      expect(v.description).toBe("830 — Windows (Materials) (Allowance)");
      expect(v.cost).toBe(830);
      expect(v.unit_price).toBe(1037.5);
      expect(v.vendor).toBeNull();
    }
  });
});

describe("sizing lives with the line's source of truth", () => {
  it("a frozen line sizes from its own coefficients", () => {
    const s = kitLineSizing(frozen({ qty_per_sqft: "0.5", qty_min: 4, qty_round: "up" }));
    expect(s).toEqual({ sized_by: null, qty_per: null, qty_per_sqft: 0.5, qty_per_lf: null, qty_min: 4, qty_round: "up" });
  });

  it("a linked line sizes from the ITEM, and the line's stale coefficients are ignored", () => {
    const line = linked({ qty_per_lf: 3, qty_round: "nearest" }, { qty_per_sqft: 99, qty_min: 99 });
    expect(kitLineSizing(line)).toEqual({ sized_by: null, qty_per: null, qty_per_sqft: null, qty_per_lf: 3, qty_min: null, qty_round: "nearest" });
    expect(kitLineView(line, { orgDefaultPct: 0 }).sizing.qty_per_lf).toBe(3);
  });
});

describe("helpers", () => {
  it("lineDisplayName glues the code on only when there is one", () => {
    expect(lineDisplayName({ code: "A1", description: "Thing" })).toBe("A1 — Thing");
    expect(lineDisplayName({ code: "  ", description: "Thing" })).toBe("Thing");
    expect(lineDisplayName({ code: null, description: " Thing " })).toBe("Thing");
  });

  it("kitLineCost is the item's buy price when linked, null when frozen", () => {
    expect(kitLineCost(linked({ buy_price: "7.25" }))).toBe(7.25);
    expect(kitLineCost(linked({ buy_price: null }))).toBe(0);
    expect(kitLineCost(frozen())).toBeNull();
    expect(kitLineCost(null)).toBeNull();
  });

  it("kitsSelectRungs: five rungs, most capable first, all carrying the kit columns", () => {
    const rungs = kitsSelectRungs("id, name, category");
    expect(rungs).toHaveLength(5);
    // 0282: the vendors under each code, archived carried so the reader can drop them (VP2).
    expect(rungs[0]).toContain("price_list_item_options(");
    expect(rungs[0]).toMatch(/price_list_item_options\([^)]*is_default[^)]*archived\)/);
    expect(rungs[1]).toContain("price_list_items(");
    expect(rungs[1]).not.toContain("price_list_item_options");
    expect(rungs[1]).toContain("sized_by"); // 0241 generic pair
    expect(rungs[2]).toContain("price_list_items(");
    expect(rungs[2]).not.toContain("sized_by"); // 0240 link, pre-0241
    expect(rungs[3]).not.toContain("price_list_item");
    expect(rungs[3]).toContain("qty_per_sqft");
    expect(rungs[4]).not.toContain("qty_per_sqft");
    expect(rungs.every((r) => r.startsWith("id, name, category, kit_items("))).toBe(true);
  });

  it("firstThatWorks returns the first error-free result and never runs later rungs", async () => {
    const calls: number[] = [];
    type R = { data: number[] | null; error: { message: string } | null };
    const r = await firstThatWorks<R>([
      async () => { calls.push(1); return { data: null, error: { message: "column does not exist" } }; },
      async () => { calls.push(2); return { data: [1], error: null }; },
      async () => { calls.push(3); return { data: [2], error: null }; },
    ]);
    expect(r.data).toEqual([1]);
    expect(calls).toEqual([1, 2]);
  });

  it("firstThatWorks hands back the LAST failure when every rung fails — a real error stays an error", async () => {
    const r = await firstThatWorks<{ data: null; error: { message: string } | null }>([
      async () => ({ data: null, error: { message: "first" } }),
      async () => ({ data: null, error: { message: "last" } }),
    ]);
    expect((r.error as { message: string }).message).toBe("last");
  });
});
