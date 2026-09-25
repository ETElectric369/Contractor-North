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
import { priceBookLine, type PriceItemOptionRow } from "@/lib/pricing/item-options";
import { normalizeUnit } from "@/lib/pricing/units";

/** The sizing rule — on the item when linked, on the line when not. 0241 made it generic: an item
 *  is counted per ONE measurement (`sized_by` = a walk-through need key, or the built-ins area_sqft /
 *  length_lf), `qty_per` of it per unit; qty_per_sqft / qty_per_lf are the 0166 legacy pair. */
export type KitSizing = {
  sized_by: string | null;
  qty_per: number | null;
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
  /** Archived = the item left the book. The link survives archiving, so every reader must be able
   *  to SAY so — projecting it is what lets a surface classify on it (audit v921). */
  archived?: boolean | null;
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
  sized_by?: string | null;
  qty_per?: number | string | null;
  /** 0282: the vendors under this code, as KIT_ITEM_LINK_COLS_V3 embeds them (archived included,
   *  so normalizeItemOptions can drop them without a filter at every call site). Absent on the
   *  older rungs, and then the line prices at the item's own number exactly as before. */
  price_list_item_options?: PriceItemOptionRow[] | PriceItemOptionRow | null;
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
  /** The vendor a linked line priced at ("Marvin", "Andersen 400 Series") when the code has a
   *  default vendor; null for the item's own price and for a frozen line. */
  vendor: string | null;
  /** True when the linked item has been ARCHIVED out of the book. The line still prices from it —
   *  changing the money on an archive would be a second, silent way to compute a total — but the
   *  contract says an archived row leaves every picker, so the surfaces need to be able to mark it
   *  (audit v921: the embed never selected `archived`, so nothing could tell). */
  archived: boolean;
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

/** What a linked line COSTS: the org's default vendor when the code has one, else the item's own
 *  buy price, the same answer kitLineView prices from. Null when frozen — the order sheet's question. */
export function kitLineCost(line: KitLineRaw | null | undefined): number | null {
  const item = linkedItemOf(line);
  if (!item) return null;
  // Cost does not depend on markup, so any pricing will do here; the sell is not read.
  return priceBookLine(bookItemOf(item), { levelPct: null, orgDefaultPct: null }).buyPrice;
}

/** The linked item in the shape the one price-book function reads. */
function bookItemOf(item: KitLinkedItem) {
  return {
    code: item.code ?? null,
    description: item.description ?? "",
    unit: item.unit ?? null,
    buy_price: num(item.buy_price) ?? 0,
    markup_pct: num(item.markup_pct),
    price_list_item_options: item.price_list_item_options ?? null,
  };
}

/** The sizing rule this line sizes by: the item's when linked, the line's when not. */
export function kitLineSizing(line: KitLineRaw | null | undefined): KitSizing {
  const src: Partial<KitLinkedItem & KitLineRaw> = linkedItemOf(line) ?? line ?? {};
  const sizedBy = typeof (src as { sized_by?: unknown }).sized_by === "string" && (src as { sized_by?: string }).sized_by ? (src as { sized_by: string }).sized_by : null;
  return {
    sized_by: sizedBy,
    qty_per: num((src as { qty_per?: unknown }).qty_per),
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
    /* THE SAME PRICE EVERY OTHER DOOR QUOTES (audit v994 VP2, the kit piece). A linked line is a
       price-book item, so it resolves through priceBookLine exactly as the typeahead, the invoice
       picker, the estimator and Nort do: the org's DEFAULT VENDOR when the code has one (named in
       the words, "830 — Windows (Marvin)", so the crew orders the right one and the order sheet
       reads it back), else the item's own buy price, both through THE one markup rule. An item
       with no vendors comes out byte-identical to the old item-markup arithmetic. */
    const choice = priceBookLine(bookItemOf(item), {
      levelPct: pricing.levelPct ?? null,
      orgDefaultPct: pricing.orgDefaultPct,
    });
    return {
      description: choice.isItemOwn ? lineDisplayName(item) : choice.description,
      unit: normalizeUnit(choice.isItemOwn ? item.unit : choice.unit),
      unit_price: choice.unitPrice,
      cost: choice.buyPrice,
      vendor: choice.isItemOwn ? null : choice.makerLabel,
      code: String(item.code ?? "").trim() || null,
      category: item.category ?? null,
      supplier: item.supplier ?? null,
      linked: true,
      archived: item.archived === true,
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
    vendor: null,
    archived: false,
    sizing: kitLineSizing(line),
  };
}

/** THE SNAPSHOT a linked line carries (kit_items.description/unit/unit_price), for the day it is
 *  unlinked or its item vanishes. Built BY kitLineView, with the org default and no customer level
 *  (a kit is authored for nobody in particular), so the frozen line is exactly what the kits
 *  manager showed a second before: the default vendor's name, unit and sell when the code has one
 *  (audit v994 VP2 follow-through: a snapshot that re-derived the item's own allowance froze
 *  "830 — Windows (Marvin)" at $1,610 into "830 — Windows" at $830). The item must be read with
 *  KIT_BOOK_OPTIONS_EMBED for the vendor to be seen; without it the item's own price is the answer. */
export function kitLineSnapshot(item: KitLinkedItem, orgDefaultPct: number): { description: string; unit: string; unit_price: number } {
  const view = kitLineView({ description: "", quantity: null, price_list_items: item }, { orgDefaultPct, levelPct: null });
  return { description: view.description, unit: view.unit, unit_price: view.unit_price };
}

/* ── THE SHARED SELECT SHAPE ──────────────────────────────────────────────────────────────────
   Every kits query in the app selects the same columns in the same three tolerant rungs, because
   a deploy lands before its migration and naming an absent column fails the WHOLE query rather
   than degrading — which would empty every kit picker until the migration ran.
     1. vendors — the full embed plus 0282's vendors under each code
     2. full  — 0166 sizing + 0240/0241 link + the item embed
     3. link  — the 0240 embed without 0241's generic sizing pair
     4. sized — 0166 sizing only (0240 not applied yet)
     5. base  — pre-0166
   Pages run `firstThatWorks(kitsSelectRungs(...).map(...))`. */
export const KIT_ITEM_BASE_COLS = "id, description, quantity, unit, unit_price, sort_order";
export const KIT_ITEM_SIZING_COLS = "qty_per_sqft, qty_per_lf, qty_min, qty_round";
export const KIT_ITEM_LINK_COLS =
  "price_list_item_id, price_list_items(id, code, description, category, supplier, unit, buy_price, markup_pct, archived, qty_per_sqft, qty_per_lf, qty_min, qty_round)";
/** 0241: the item embed with the generic sizing pair. Tried FIRST; falls to KIT_ITEM_LINK_COLS pre-migration. */
export const KIT_ITEM_LINK_COLS_V2 =
  "price_list_item_id, price_list_items(id, code, description, category, supplier, unit, buy_price, markup_pct, archived, qty_per_sqft, qty_per_lf, qty_min, qty_round, sized_by, qty_per)";

/** 0282: the vendors under a code, as every kit read embeds them — `archived` carried rather than
 *  filtered, so normalizeItemOptions drops the ones the org stopped carrying without a nested
 *  filter restated at each call site. The kit WRITES (kit-actions' snapshot, the importer's kit
 *  step) read the item through this same embed so the frozen copy matches what the view shows. */
export const KIT_BOOK_OPTIONS_EMBED =
  "price_list_item_options(id, vendor, label, part_number, unit, buy_price, markup_pct, is_default, sort_order, archived)";

/** 0282: the V2 embed plus the vendors under each code, so a kit line quotes at the code's default
 *  vendor like every other door (audit v994 VP2). `archived` rides in the embed rather than as a
 *  filter, because a nested filter would have to be restated at all five call sites. */
export const KIT_ITEM_LINK_COLS_V3 = `price_list_item_id, price_list_items(id, code, description, category, supplier, unit, buy_price, markup_pct, archived, qty_per_sqft, qty_per_lf, qty_min, qty_round, sized_by, qty_per, ${KIT_BOOK_OPTIONS_EMBED})`;

/** The kit_items(...) column lists, most capable first. */
export const KIT_ITEM_SELECT_RUNGS = [
  `${KIT_ITEM_BASE_COLS}, ${KIT_ITEM_SIZING_COLS}, ${KIT_ITEM_LINK_COLS_V3}`,
  `${KIT_ITEM_BASE_COLS}, ${KIT_ITEM_SIZING_COLS}, ${KIT_ITEM_LINK_COLS_V2}`,
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
