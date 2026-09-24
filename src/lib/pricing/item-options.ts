import { effectiveMarkupPct, sellPrice } from "@/lib/pricing/markup";

/**
 * ONE CODE, SEVERAL MAKERS — THE POINT OF USE.
 *
 * Andrew, for Justin Vivian (2026-09-20): "pricelist / increase drop down options for each item
 * code / multiple vendors / multiple items / ie. windows - mfg Andersen - mfg Milgard - mfg
 * Marvin."
 *
 * Migration 0282 gave a price-list item a list of things that can FILL it, and kept the code
 * meaning one line on an estimate. This file is the other half: when a code with makers reaches a
 * quote line, WHICH maker was picked, what the line then says, and what it then costs.
 *
 * It is pure on purpose. The money in it is the difference between a $830 allowance and a $1,610
 * Marvin window, and the only way to keep that honest is to be able to test it without a database,
 * a browser or a customer standing there. Every screen that offers the choice (the composer's
 * picker, the saved-estimate picker, the invoice picker) resolves through here so they can never
 * disagree about the same pick.
 *
 * THREE RULES IT ENFORCES
 *
 *  1. AN ITEM WITH NO OPTIONS BEHAVES EXACTLY AS IT DID BEFORE. itemOptionChoices returns one
 *     choice, the item's own, whose description / unit / price are byte-identical to what the
 *     pickers already produce. No option data, no change.
 *  2. THE ITEM'S OWN PRICE STAYS A CHOICE. An option is an answer to "instead of the allowance,
 *     use this one" (0282's own words), so "No Vendor Picked" is always the first row, and it is
 *     the default until somebody flags one.
 *  3. THE MONEY GOES THROUGH THE ONE MARKUP RULE. Never a hand-rolled buy * (1 + pct/100) here:
 *     effectiveMarkupPct decides the percentage and sellPrice does the arithmetic, exactly as
 *     they do for an item with no options.
 */

/** The embed every read of a price-list item adds, so no select list can drift from another
 *  (THE PROJECTION LAW). Filter it with `.eq("price_list_item_options.archived", false)` at the
 *  call site: an archived maker is one the org stopped carrying, and it must not be offered. */
export const ITEM_OPTIONS_EMBED =
  "price_list_item_options(id, vendor, label, part_number, unit, buy_price, markup_pct, is_default, sort_order)";

/** What the pages say out loud when the read above fails. ONE sentence, shared, because two
 *  screens describing the same failure two ways is two chances to describe it wrongly.
 *
 *  Why it names the consequence rather than the error: an item that quietly renders as if it had
 *  no makers quotes the ALLOWANCE for a job somebody would have picked Marvin for, and that is a
 *  wrong number on a customer's paper, not an inconvenience. */
export const ITEM_OPTIONS_UNAVAILABLE =
  "Your price list did not load, so the vendors that sit under each code are not here either. " +
  "A code with vendors would quote at its own price instead of the one you picked. Reload the page, or type these lines by hand.";

/** One row of price_list_item_options as the embed projects it. Numerics arrive from PostgREST as
 *  strings, so every number is read through Number() rather than trusted. */
export type PriceItemOptionRow = {
  id: string;
  vendor: string;
  label?: string | null;
  part_number?: string | null;
  unit?: string | null;
  buy_price: number | string | null;
  markup_pct?: number | string | null;
  is_default?: boolean | null;
  sort_order?: number | null;
};

/** The price-list item the options hang under — the fields the line takes from it. */
export type OptionedPriceItem = {
  code?: string | null;
  description: string;
  unit?: string | null;
  buy_price: number | string | null;
  markup_pct?: number | string | null;
  /** The embed. PostgREST hands back an array; a one-row shape can arrive as an object. */
  price_list_item_options?: PriceItemOptionRow[] | PriceItemOptionRow | null;
};

/** Who owns the markup for this document: the customer's pricing level (null when they have none)
 *  and the org-wide default. Passed in because only the page knows which customer is selected. */
export type OptionPricing = { levelPct?: number | null; orgDefaultPct?: number | null };

/** The id that means "the item's own price" — not a row in the table, so not a uuid. An empty
 *  string is what an unselected <select> hands back, which keeps the UI side free of special cases. */
export const ITEM_OWN_OPTION_ID = "";

/** What the "no maker" row reads. Title Case, like every other clickable (Erik's law). */
export const ITEM_OWN_OPTION_LABEL = "No Vendor Picked";

/** One row of the maker dropdown, fully resolved: what it reads, and what the line becomes if it
 *  is picked. Nothing here needs recomputing downstream. */
export type ItemOptionChoice = {
  /** "" for the item's own price, otherwise the option row's id. */
  id: string;
  /** True for the item's own price (the allowance) — the row that always exists. */
  isItemOwn: boolean;
  /** True when the org flagged this maker as the one to use when nobody picks. */
  isDefault: boolean;
  /** The dropdown's own wording: "No Vendor Picked", "Andersen 400 Series". */
  makerLabel: string;
  /** What the quote line's description becomes. The customer reads it and the crew orders from it. */
  description: string;
  unit: string;
  /** Sell price per unit, through THE one markup rule. */
  unitPrice: number;
  /** The cost this sell was built from, so a screen can show its work without re-deriving it. */
  buyPrice: number;
  /** The markup actually applied, for the same reason. */
  markupPct: number;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The embed, as a plain sorted array. Supabase hands an array back for a to-many embed, but a
 *  hand-written select or a single-row read can arrive as a bare object or null — read all three
 *  rather than letting one shape drop every maker on the floor (THE PROJECTION LAW). */
export function normalizeItemOptions(raw: OptionedPriceItem["price_list_item_options"]): PriceItemOptionRow[] {
  const rows = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return rows
    .filter((o): o is PriceItemOptionRow => !!o && typeof o === "object" && typeof o.id === "string" && !!o.id)
    // `archived` is filtered in the query (the embed carries no archived column), but a caller that
    // passes rows from elsewhere must not be able to offer a maker the org stopped carrying.
    .filter((o) => (o as { archived?: boolean | null }).archived !== true)
    .filter((o) => String(o.vendor ?? "").trim() !== "")
    .slice()
    // THE SAME ORDER THE PRICE LIST SHOWS (price-list/item-options-math.ts → sortItemOptions):
    // the flagged maker first, then the hand-set order, then the maker's name. Two screens listing
    // one item's makers in two orders is how somebody picks the second row on one screen and the
    // second row on the other and gets a different window. Keep these two functions in step.
    .sort(
      (a, b) =>
        (a.is_default === true ? 0 : 1) - (b.is_default === true ? 0 : 1) ||
        num(a.sort_order) - num(b.sort_order) ||
        makerName(a).localeCompare(makerName(b)),
    );
}

/** How a maker reads on a row: "Andersen", or "Andersen 400 Series". */
function makerName(o: Pick<PriceItemOptionRow, "vendor" | "label">): string {
  return [String(o.vendor ?? "").trim(), String(o.label ?? "").trim()].filter(Boolean).join(" ");
}

/** Does this code have makers to choose between? The pickers show a dropdown only when it does —
 *  an item with none stays exactly the one-tap add it has always been. */
export function hasItemOptions(item: OptionedPriceItem | null | undefined): boolean {
  return !!item && normalizeItemOptions(item.price_list_item_options).length > 0;
}

/** The line description for the item as it stands — the SAME string the pickers already write, so
 *  an item with no options is untouched by any of this. */
export function baseLineDescription(item: OptionedPriceItem): string {
  const code = String(item.code ?? "").trim();
  const desc = String(item.description ?? "").trim();
  return code ? `${code} — ${desc}` : desc;
}

/**
 * THE MAKER ENDS UP IN THE DESCRIPTION, because that is what the customer reads on the estimate and
 * what the crew orders from in the yard. "830 — Windows (Materials) (Allowance)" priced at Marvin
 * money, with the word Marvin nowhere on the page, is how the wrong window gets delivered.
 *
 * The part number rides along when the org typed one, for the same reason: it is the single most
 * orderable fact about the thing. The result is a plain editable description, never a lock — the
 * app SUGGESTS, a person DECIDES, and they can rewrite it on the line.
 */
export function describeWithMaker(base: string, option: PriceItemOptionRow): string {
  const maker = [String(option.vendor ?? "").trim(), String(option.label ?? "").trim()].filter(Boolean).join(" ");
  const part = String(option.part_number ?? "").trim();
  const inside = part ? `${maker}, #${part}` : maker;
  return inside ? `${base} (${inside})` : base;
}

/** The item's own price as a choice: the allowance, always offered, always first. */
export function itemOwnChoice(item: OptionedPriceItem, pricing: OptionPricing = {}): ItemOptionChoice {
  const buy = num(item.buy_price);
  const pct = effectiveMarkupPct({
    levelPct: pricing.levelPct,
    itemPct: num(item.markup_pct),
    orgDefaultPct: pricing.orgDefaultPct,
  });
  return {
    id: ITEM_OWN_OPTION_ID,
    isItemOwn: true,
    isDefault: false,
    makerLabel: ITEM_OWN_OPTION_LABEL,
    description: baseLineDescription(item),
    unit: String(item.unit ?? "").trim() || "ea",
    unitPrice: sellPrice(buy, pct),
    buyPrice: buy,
    markupPct: pct,
  };
}

/**
 * THE MARKUP ONE MAKER SELLS AT. Two questions, both put to THE one rule (effectiveMarkupPct) so
 * nothing in here re-implements the ladder:
 *
 *  1. Option → item → org default. An option that STATES a markup answers for the item, and that
 *     includes a stated 0: typing 0.00 on one maker is a decision ("sell this one at cost"), where
 *     leaving the box empty is an absence. This is the reading the price-list screen already shows
 *     the number under (price-list/item-options-math.ts → optionView), and the screen that SETS a
 *     price and the screen that QUOTES it must never print two different numbers for one option.
 *  2. Then the customer's pricing level, which outranks every rung above it, even at 0% — that is
 *     what a pricing level IS, and the price-list screen has no customer so it never asks this.
 *
 * `book` rides into the second call in BOTH fall-through slots on purpose: the rule reads an
 * itemPct of 0 as "not set", and passing the same resolved number twice is what keeps a genuine 0
 * at 0 without restating the "is there a level" test by hand here.
 */
export function optionMarkupPct(
  item: OptionedPriceItem,
  option: Pick<PriceItemOptionRow, "markup_pct">,
  pricing: OptionPricing = {},
): number {
  const raw = option.markup_pct;
  const stated = raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw);
  const book =
    stated != null
      ? stated
      : effectiveMarkupPct({ itemPct: num(item.markup_pct), orgDefaultPct: pricing.orgDefaultPct });
  return effectiveMarkupPct({ levelPct: pricing.levelPct, itemPct: book, orgDefaultPct: book });
}

/** One option as a choice: what the dropdown row reads, and the line it makes if it is picked. */
export function optionChoice(
  item: OptionedPriceItem,
  option: PriceItemOptionRow,
  pricing: OptionPricing = {},
): ItemOptionChoice {
  const buy = num(option.buy_price);
  const pct = optionMarkupPct(item, option, pricing);
  const maker = makerName(option);
  return {
    id: option.id,
    isItemOwn: false,
    isDefault: option.is_default === true,
    makerLabel: maker,
    description: describeWithMaker(baseLineDescription(item), option),
    // An option can carry its own unit (Andersen sells the same opening by the each; a supplier
    // may quote a pair). Silence falls back to the item's, then to "ea" — never to nothing, which
    // multiplies into a quantity nobody can read.
    unit: String(option.unit ?? "").trim() || String(item.unit ?? "").trim() || "ea",
    unitPrice: sellPrice(buy, pct),
    buyPrice: buy,
    markupPct: pct,
  };
}

/** Every row of the dropdown for this code: the item's own price first, then each maker in the
 *  org's own order. An item with no options gets a one-row list, which is why the pickers can ask
 *  `hasItemOptions` and otherwise carry on exactly as before. */
export function itemOptionChoices(item: OptionedPriceItem, pricing: OptionPricing = {}): ItemOptionChoice[] {
  const opts = normalizeItemOptions(item.price_list_item_options);
  return [itemOwnChoice(item, pricing), ...opts.map((o) => optionChoice(item, o, pricing))];
}

/**
 * THE PICKER'S ORDER: the DEFAULT VENDOR FIRST, then the item's own price, then the rest.
 *
 * A vendor made the default is the org's answer to "which one when nobody picks" (0282), and the
 * server (addQuoteItemFromPriceItem) already resolves an unpicked line to it. The dropdown puts
 * that same answer on top so the first row a thumb lands on is the one the org chose, and the
 * allowance stays one row down, still pickable. With no default, the item's own price is the
 * answer and stays first, exactly as before.
 */
export function pickerChoices(item: OptionedPriceItem, pricing: OptionPricing = {}): ItemOptionChoice[] {
  const all = itemOptionChoices(item, pricing);
  const def = all.find((c) => c.isDefault);
  if (!def) return all;
  return [def, ...all.filter((c) => c !== def)];
}

/** What the picker's collapsed row says for a code with vendors: how many, and the default's
 *  name and sell (null when no vendor is the default, and the row shows the item's own price). */
export function pickerSummary(
  item: OptionedPriceItem,
  pricing: OptionPricing = {},
): { count: number; defaultChoice: ItemOptionChoice | null; ownChoice: ItemOptionChoice } {
  const all = itemOptionChoices(item, pricing);
  return {
    count: all.length - 1,
    defaultChoice: all.find((c) => c.isDefault) ?? null,
    ownChoice: all[0],
  };
}

/** Which row opens selected: the maker the org flagged, else the item's own price. 0282 keeps at
 *  most one default per item in a unique index, so "the first flagged one" is the only one. */
export function defaultItemOptionId(item: OptionedPriceItem): string {
  const flagged = normalizeItemOptions(item.price_list_item_options).find((o) => o.is_default === true);
  return flagged ? flagged.id : ITEM_OWN_OPTION_ID;
}

/**
 * Resolve a picked id into the line it makes.
 *
 * Returns null when an id was given and no such maker is on this code — archived since the page
 * rendered, deleted, or belonging to a different item. NOT the allowance as a consolation: falling
 * back silently is how a Marvin pick gets billed at $830, so the caller says it out loud instead.
 */
export function chooseItemOption(
  item: OptionedPriceItem,
  optionId: string | null | undefined,
  pricing: OptionPricing = {},
): ItemOptionChoice | null {
  if (!optionId) return itemOwnChoice(item, pricing);
  const found = normalizeItemOptions(item.price_list_item_options).find((o) => o.id === optionId);
  return found ? optionChoice(item, found, pricing) : null;
}

/** The refusal sentence for a pick that is no longer on the code. Named here so the server action
 *  and any screen that resolves a stale pick refuse with the same words. */
export function missingOptionMessage(item: OptionedPriceItem): string {
  const code = String(item.code ?? "").trim();
  return `That vendor is no longer listed under ${code ? code : String(item.description ?? "this item").trim()}. Pick one again, or add the line at its own price.`;
}
