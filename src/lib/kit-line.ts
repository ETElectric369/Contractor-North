/**
 * ONE VIEW OF A KIT LINE — linked or frozen (0240, "kits join the price list").
 *
 * Erik: "merge the kits and price list because that's where all the kit magic should probably
 * happen anyway." Before 0240 a kit line was a COPY: the description with the code glued in, a
 * sell price frozen at the moment it was added, no pointer back to the item. So a kit never
 * re-priced when the book changed, never re-marked-up for a customer's level (kit-picker emitted
 * the frozen price), and the order sheet couldn't find its cost — the same missing wire, four
 * symptoms.
 *
 * Now a line MAY point at an item (kit_items.price_list_item_id). This file is the one place that
 * decides what a line looks like:
 *   LINKED   → everything but quantity/sort comes from the item, LIVE: name ("CODE — description"),
 *              unit, cost, sell through THE markup rule (effectiveMarkupPct), category, supplier,
 *              and the sizing rule (0166) that now lives on the item.
 *   UNLINKED → the line's own frozen values, byte-for-byte as before. Nothing is lost, nothing is
 *              invented: an older row, a hand-typed line, or a link whose item has gone all render
 *              from their snapshot.
 * Every consumer (kits manager, kit picker, parametric sizing, order-sheet seed, Nort) reads
 * through here so they can never disagree about what a line is worth.
 */
import { effectiveMarkupPct, sellPrice } from "@/lib/pricing/markup";
import { normalizeUnit } from "@/lib/pricing/units";

/** The 0166 sizing rule — on the item when linked, on the line when not. */
export type KitSizing = {
  qty_per_sqft: number | null;
  qty_per_lf: number | null;
  qty_min: number | null;
  qty_round: string | null;
};

/** The price_list_items embed as THE SHARED SELECT SHAPE projects it (numerics may arrive as
 *  strings from PostgREST). Sizing columns are optional: absent until 0240 has run. */
export type KitLinkedItem = {
  id: string;
  code?: string | null;
  description: string;
  category?: string | null;
  supplier?: string | null;
  unit?: string | null;
  buy_price?: number | string | null;
  markup_pct?: number | string | null;
  qty_per_sqft?: number | string | null;
  qty_per_lf?: number | string | null;
  qty_min?: number | string | null;
  qty_round?: string | null;
};

/** A kit_items row as the pages select it. Every 0166/0240 column is optional because the query
 *  is retried without them when the migration hasn't landed (see kitsSelectRungs). */
export type KitLineRaw = {
  id?: string;
  description: string;
  quantity: number | string | null;
  unit?: string | null;
  unit_price?: number | string | null;
  sort_order?: number | string | null;
  qty_per_sqft?: number | string | null;
  qty_per_lf?: number | string | null;
  qty_min?: number | string | null;
  qty_round?: string | null;
  price_list_item_id?: string | null;
  /** PostgREST returns a many-to-one embed as an object; tolerate an array in case a typed client
   *  ever hands one back. */
  price_list_items?: KitLinkedItem | KitLinkedItem[] | null;
};

/** What the reader knows about markup: the org default always, the customer's level when there
 *  is one (null = no level; a level ALWAYS wins, even at 0% — see effectiveMarkupPct). */
export type KitPricing = {
  orgDefaultPct: number;
  levelPct?: number | null;
};

export type KitLineView = {
  description: string;
  unit: string;
  /** SELL — through THE rule. For a frozen line this is the snapshot it carries. */
  unit_price: number;
  /** The item's buy price when linked; null when frozen (a frozen line never knew its cost). */
  cost: number | null;
  code: string | null;
  category: string | null;
  supplier: string | null;
  linked: boolean;
  sizing: KitSizing;
};

const num = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** The embedded item, or null. A line whose id points at a vanished item (FK is ON DELETE SET
 *  NULL, but RLS or a stale page can still hand us an id with no embed) is treated as frozen. */
export function linkedItemOf(line: KitLineRaw | null | undefined): KitLinkedItem | null {
  if (!line) return null;
  const raw = line.price_list_items;
  const item = Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
  if (!item || !item.id) return null;
  return item;
}

/** "CODE — description" when the item has a code, else the description. The naming convention
 *  the pre-0240 copy used, kept so a linked line reads the same as the frozen one beside it. */
export function lineDisplayName(item: { code?: string | null; description: string }): string {
  const code = String(item.code ?? "").trim();
  const desc = String(item.description ?? "").trim();
  return code ? `${code} — ${desc}` : desc;
}

/** The item's buy price when linked, else null — the order sheet's question. */
export function kitLineCost(line: KitLineRaw | null | undefined): number | null {
  const item = linkedItemOf(line);
  if (!item) return null;
  return num(item.buy_price) ?? 0;
}

/** The sizing rule this line sizes by: the item's when linked, the line's when not. */
export function kitLineSizing(line: KitLineRaw | null | undefined): KitSizing {
  const src: Partial<KitLinkedItem & KitLineRaw> = linkedItemOf(line) ?? line ?? {};
  return {
    qty_per_sqft: num(src.qty_per_sqft),
    qty_per_lf: num(src.qty_per_lf),
    qty_min: num(src.qty_min),
    qty_round: src.qty_round ?? null,
  };
}

/** THE view. Linked lines take everything but quantity/sort from the item; unlinked lines return
 *  their own frozen values. */
export function kitLineView(line: KitLineRaw, pricing: KitPricing): KitLineView {
  const item = linkedItemOf(line);
  if (item) {
    const cost = num(item.buy_price) ?? 0;
    const pct = effectiveMarkupPct({
      levelPct: pricing.levelPct,
      itemPct: num(item.markup_pct),
      orgDefaultPct: pricing.orgDefaultPct,
    });
    return {
      description: lineDisplayName(item),
      unit: normalizeUnit(item.unit),
      unit_price: sellPrice(cost, pct),
      cost,
      code: String(item.code ?? "").trim() || null,
      category: item.category ?? null,
      supplier: item.supplier ?? null,
      linked: true,
      sizing: kitLineSizing(line),
    };
  }
  return {
    description: line.description ?? "",
    unit: line.unit || "ea",
    unit_price: num(line.unit_price) ?? 0,
    cost: null,
    code: null,
    category: null,
    supplier: null,
    linked: false,
    sizing: kitLineSizing(line),
  };
}

/* ── THE SHARED SELECT SHAPE ──────────────────────────────────────────────────────────────────
   Every kits query in the app selects the same columns in the same three tolerant rungs, because
   a deploy lands before its migration and naming an absent column fails the WHOLE query rather
   than degrading — which would empty every kit picker until the migration ran.
     1. full  — 0166 sizing + 0240 link + the item embed
     2. sized — 0166 sizing only (0240 not applied yet)
     3. base  — pre-0166
   Pages run `firstThatWorks(kitsSelectRungs(...).map(...))`. */
export const KIT_ITEM_BASE_COLS = "id, description, quantity, unit, unit_price, sort_order";
export const KIT_ITEM_SIZING_COLS = "qty_per_sqft, qty_per_lf, qty_min, qty_round";
export const KIT_ITEM_LINK_COLS =
  "price_list_item_id, price_list_items(id, code, description, category, supplier, unit, buy_price, markup_pct, qty_per_sqft, qty_per_lf, qty_min, qty_round)";

/** The kit_items(...) column lists, most capable first. */
export const KIT_ITEM_SELECT_RUNGS = [
  `${KIT_ITEM_BASE_COLS}, ${KIT_ITEM_SIZING_COLS}, ${KIT_ITEM_LINK_COLS}`,
  `${KIT_ITEM_BASE_COLS}, ${KIT_ITEM_SIZING_COLS}`,
  KIT_ITEM_BASE_COLS,
] as const;

/** Full kits select strings, most capable first: `<kitCols>, kit_items(<rung>)`. */
export function kitsSelectRungs(kitCols = "id, name"): string[] {
  return KIT_ITEM_SELECT_RUNGS.map((cols) => `${kitCols}, kit_items(${cols})`);
}

/** Run the attempts in order and return the first result without an error — or the LAST result,
 *  so a genuine failure still surfaces as one rather than as an empty list. Pure: takes thunks,
 *  so it works with any thenable query builder and is testable without a database. */
export async function firstThatWorks<T extends { error: unknown }>(attempts: Array<() => PromiseLike<T>>): Promise<T> {
  let last: T | undefined;
  for (const attempt of attempts) {
    last = await attempt();
    if (!last.error) return last;
  }
  if (!last) throw new Error("firstThatWorks: no attempts given");
  return last;
}
