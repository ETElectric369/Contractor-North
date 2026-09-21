/**
 * ONE CODE, SEVERAL MAKERS — the pure part of migration 0282's vendor options.
 *
 * Andrew, for Justin Vivian: "increase drop down options for each item code / multiple vendors /
 * multiple items / ie. windows - mfg Andersen - mfg Milgard - mfg Marvin". Vivian Builders' code
 * 830 is "Windows (Materials) (Allowance)" at $830.00 — a builder's placeholder for a decision
 * nobody has made yet, and the decision is WHOSE window.
 *
 * Erik chose the shape: the options live UNDER the code rather than the code appearing three
 * times. So 830 still means one line on an estimate, and it gains a list of things that can fill
 * it. The item's own price stays the allowance and stays the default.
 *
 * Everything in this file is arithmetic or a sentence — no database, no React — so the sell-price
 * fall-through and every refusal can be tested without a browser. The four sell functions live in
 * lib/pricing/markup.ts (the one place cost turns into sell); nothing here re-implements them.
 */
import { dbError } from "@/lib/db-error";
import { effectiveMarkupPct, marginFromMarkup, sellPrice } from "@/lib/pricing/markup";
import { normalizeUnit } from "@/lib/pricing/units";
import { parseCellNumber, type PriceItem } from "./price-list-math";

/** One row of 0282's price_list_item_options, as the page selects it. */
export interface ItemOption {
  id: string;
  item_id: string;
  /** Who MAKES it — Andersen, Milgard, Marvin. Not the supplier: the supplier is who he buys it
   *  from, and the same Andersen window comes from three lumber yards. */
  vendor: string;
  /** The product line when the maker alone isn't the answer: "400 Series", "Tuscany". */
  label: string | null;
  part_number: string | null;
  /** Null = this one is sold in the item's own unit. */
  unit: string | null;
  buy_price: number;
  /** Null = NOT STATED. Falls through to the item's markup, then the org default. Never a 0. */
  markup_pct: number | null;
  is_default: boolean;
  archived: boolean;
  sort_order?: number | null;
}

/** How this option reads on a row: "Andersen" or "Andersen 400 Series". */
export function optionName(o: { vendor?: string | null; label?: string | null }): string {
  const vendor = String(o.vendor ?? "").trim();
  const label = String(o.label ?? "").trim();
  return label ? `${vendor} ${label}` : vendor || "This option";
}

/** WHICH RUNG of the one markup rule answered. Shown next to the number so a fall-through is
 *  never mistaken for a markup somebody set on this option. */
export type MarkupSource = "option" | "item" | "org" | "none";

/**
 * What one option row shows.
 *
 * THE MARKUP FALL-THROUGH, run through lib/pricing/markup.ts rather than re-written here:
 * an option's OWN markup always wins when it states one — even 0, because a typed 0 means "sell
 * this one at cost" and that is a decision. When it states nothing, the item's own markup answers,
 * and then the org default. That is exactly `effectiveMarkupPct`'s level → item → org ladder, so
 * this screen and every quote surface can never disagree.
 */
export function optionView(
  option: Pick<ItemOption, "vendor" | "label" | "unit" | "buy_price" | "markup_pct">,
  item: Pick<PriceItem, "unit" | "markup_pct">,
  orgDefaultPct: number,
) {
  const cost = Number(option.buy_price) || 0;
  const statedRaw = option.markup_pct;
  const stated = statedRaw === null || statedRaw === undefined ? null : Number(statedRaw);
  const hasStated = stated !== null && Number.isFinite(stated);
  const itemPct = Number(item.markup_pct) || 0;
  const orgPct = Number(orgDefaultPct) || 0;
  const pct = effectiveMarkupPct({ levelPct: hasStated ? stated : null, itemPct, orgDefaultPct: orgPct });
  const source: MarkupSource = hasStated ? "option" : itemPct > 0 ? "item" : orgPct > 0 ? "org" : "none";
  return {
    name: optionName(option),
    cost,
    pct,
    source,
    sell: sellPrice(cost, pct),
    margin: marginFromMarkup(pct),
    /** Blank on the option means "the item's unit" — the option is not a different thing. */
    unit: (option.unit ?? "").trim() || item.unit || "ea",
  };
}

/** Two or three words for the end of a row's meta line: "25% markup (your default)". A percentage
 *  with no source reads as one somebody set on this option, and on 0282 that is usually a lie. */
export function markupSourceTag(source: MarkupSource): string {
  switch (source) {
    case "option":
      return "this option";
    case "item":
      return "the item";
    case "org":
      return "your default";
    case "none":
      return "none set";
  }
}

/** The whole sentence, for the one place with room for it: the add/edit form's live preview. */
export function markupSourceNote(source: MarkupSource): string {
  switch (source) {
    case "option":
      return "Markup set on this option.";
    case "item":
      return "Markup from the item itself.";
    case "org":
      return "Your default markup, because nobody set one here.";
    case "none":
      return "No markup anywhere, so this one sells at cost.";
  }
}

/** Default first, then the hand-set order, then the maker's name. The list reads the same on every
 *  device and after every save, which a database that only promises "some order" does not. */
export function sortItemOptions<T extends Pick<ItemOption, "is_default" | "sort_order" | "vendor" | "label">>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    const sa = Number(a.sort_order) || 0;
    const sb = Number(b.sort_order) || 0;
    if (sa !== sb) return sa - sb;
    return optionName(a).localeCompare(optionName(b));
  });
}

/* ── WHAT GETS WRITTEN ──────────────────────────────────────────────────────────────────────── */

export interface OptionFieldsInput {
  vendor?: string | null;
  label?: string | null;
  partNumber?: string | null;
  unit?: string | null;
  /** A string is allowed so the screen can hand over exactly what was typed, blank included. */
  buyPrice?: number | string | null;
  /** "" / null = NOT STATED (falls through). "0" = a deliberate zero. The difference is the
   *  whole reason 0282 made this column nullable, so it must survive the trip from the form. */
  markupPct?: number | string | null;
}

/** "$1,234.50" / 1234.5 / "" → a number or null. One reader so a typed price and a typed markup
 *  are parsed the same way the price list's own cells parse them. */
function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return parseCellNumber(v);
}

/**
 * The typed fields → the columns 0282 holds, or a sentence saying why not.
 *
 * `create` requires a maker and a cost; `update` touches only what the caller passed, so a patch
 * that changes the part number can never blank the price (the importer's "only mapped columns"
 * rule, applied to one row).
 */
export function cleanOptionFields(
  input: OptionFieldsInput,
  mode: "create" | "update",
): { clean: Record<string, unknown> } | { error: string } {
  const clean: Record<string, unknown> = {};

  if (input.vendor !== undefined || mode === "create") {
    const v = String(input.vendor ?? "").trim();
    if (!v) return { error: "Say who makes it. That is what an option answers: Andersen, Milgard, Marvin." };
    if (v.length > 120) return { error: "That maker's name is too long. Keep it under 120 characters." };
    clean.vendor = v;
  }
  if (input.label !== undefined) {
    const s = String(input.label ?? "").trim();
    if (s.length > 120) return { error: "That product line is too long. Keep it under 120 characters." };
    clean.label = s || null;
  }
  if (input.partNumber !== undefined) {
    const s = String(input.partNumber ?? "").trim();
    if (s.length > 80) return { error: "That part number is too long. Keep it under 80 characters." };
    clean.part_number = s || null;
  }
  if (input.unit !== undefined) {
    const s = String(input.unit ?? "").trim();
    // Blank stays NULL, and NULL means "the item's own unit". normalizeUnit("") answers "ea",
    // which would quietly turn "I didn't say" into "each" on an item priced per sq ft.
    clean.unit = s ? normalizeUnit(s) : null;
  }
  if (input.buyPrice !== undefined || mode === "create") {
    const n = toNumber(input.buyPrice);
    // NEVER PRINT A NUMBER NOBODY TYPED: a blank cost is refused, not saved as $0.00, because a
    // $0.00 Andersen window on an estimate is a worse answer than no option at all.
    if (n === null) return { error: "Type what this one costs you. An option with no price of its own has nothing to say." };
    if (n < 0) return { error: "Cost can't be negative." };
    // numeric(12,4) — a CED net price really does carry four decimals.
    clean.buy_price = Math.round(n * 10000) / 10000;
  }
  if (input.markupPct !== undefined) {
    const raw = typeof input.markupPct === "string" ? input.markupPct.trim() : input.markupPct;
    if (raw === "" || raw === null) {
      // NULL, not 0. 0282 made this column nullable on purpose: "not stated" falls through to the
      // item and then the org default, and a 0 written here would silently sell at cost forever.
      clean.markup_pct = null;
    } else {
      const n = toNumber(raw);
      if (n === null) return { error: "That markup isn't a number. Leave it blank to use the item's own." };
      if (n <= -100) return { error: "A markup below -100% would sell for less than nothing." };
      clean.markup_pct = Math.round(n * 100) / 100;
    }
  }
  return { clean };
}

/**
 * A FAILED OPTION WRITE, SAID IN ENGLISH.
 *
 * 0282's two unique indexes are the two ways this can legitimately refuse, and neither has a
 * sentence in lib/db-error.ts (that file is the shared translator; these constraints are this
 * screen's own). Andersen entered twice is a typo with an obvious fix, not a 500 — so it gets the
 * fix in the sentence. Anything we do not recognise keeps its exact text through dbError, which is
 * how Erik files a bug report.
 */
export function optionWriteRefusal(err: unknown, what?: { vendor?: string | null; label?: string | null }): string {
  const raw = typeof err === "string" ? err : String((err as { message?: unknown } | null)?.message ?? "");
  if (raw.includes("price_list_item_options_one_per_maker")) {
    const name = what?.vendor ? optionName(what) : "That maker";
    return `${name} is already an option on this item. Edit the one that's there, or add a product line so the two read differently.`;
  }
  if (raw.includes("price_list_item_options_one_default")) {
    return "Something else is already the default under this item. Reload the page and pick the default again.";
  }
  return dbError(err);
}
