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
import { optionMarkupPct } from "@/lib/pricing/item-options";
import { marginFromMarkup, sellPrice } from "@/lib/pricing/markup";
import { normalizeUnit } from "@/lib/pricing/units";
import { formatCurrency } from "@/lib/utils";
import { parseCellNumber, type PriceItem } from "./price-list-math";

/** One row of 0282's price_list_item_options, as the page selects it. */
export interface ItemOption {
  id: string;
  item_id: string;
  /** THE VENDOR, which is the brand (Erik for Justin, 2026-09-24: "vendor means what brand with
   *  its own cost and sell price"): Andersen, Milgard, Marvin. Not the supplier column on the item,
   *  which is where he buys it; the same Andersen window comes from three lumber yards. */
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
  return label ? `${vendor} ${label}` : vendor || "This vendor";
}

/** WHICH RUNG of the one markup rule answered. Shown next to the number so a fall-through is
 *  never mistaken for a markup somebody set on this option. */
export type MarkupSource = "option" | "item" | "org" | "none";

/**
 * What one option row shows.
 *
 * THE MARKUP FALL-THROUGH, run through the estimate's own optionMarkupPct rather than re-written here:
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
  // THE ESTIMATE'S OWN FUNCTION, not a copy of its ladder: a copy honoured a stated negative markup
  // that the estimate reads as "not set", so this sheet showed $900 while the quote charged $1,000.
  // New writes refuse a sell below cost (optionSellPatch / cleanOptionFields), and anything older
  // still reads here exactly as the estimate prices it.
  const pct = optionMarkupPct(
    { description: "", buy_price: null, markup_pct: item.markup_pct },
    { markup_pct: hasStated ? stated : null },
    { orgDefaultPct: orgPct },
  );
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
      return "this vendor";
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
      return "Markup set on this vendor.";
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
    if (!v) return { error: "Name the vendor: the brand, e.g. Andersen, Milgard or Marvin." };
    if (v.length > 120) return { error: "That vendor's name is too long. Keep it under 120 characters." };
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
    if (n === null) return { error: "Type what this vendor's one costs you. A vendor with no price of its own has nothing to say." };
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
      // BELOW COST IS REFUSED, not stored: the estimate reads a negative markup as "not set" and
      // prices at cost or above, so a stored -10% would show one sell here and charge another.
      if (n < 0) return { error: "A markup below 0 sells under this vendor's cost. Use 0 to sell at cost." };
      // Up to the column's six decimals (0296), not two: this is also the door Undo writes a
      // sell-derived markup back through, and rounding it to two would move the sell it restores.
      clean.markup_pct = roundTo(n, OPTION_MARKUP_DECIMALS);
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
    const name = what?.vendor ? optionName(what) : "That vendor";
    return `${name} is already a vendor on this item. Edit the one that's there, or add a product line so the two read differently.`;
  }
  if (raw.includes("price_list_item_options_one_default")) {
    return "Another vendor is already the default on this item. Reload the page and pick the default again.";
  }
  return dbError(err);
}

/* ── TYPING A SELL PRICE ────────────────────────────────────────────────────────────────────────
   "Editable either way: typing a Sell price sets the markup." The markup is what is stored (the
   book holds cost + markup and every surface derives sell through sellPrice), so a typed sell has
   to become a markup that, run back through sellPrice, lands on EXACTLY the cents typed. With two
   decimals of percent that is impossible above a few hundred dollars: 0.01% of a $12,000 window
   is $1.20. So the markup gets the FEWEST decimals that reproduce the sell (a typed $1,500 on a
   $1,200 cost is still a clean 25), up to the six migration 0296 gave the column. */

/** How many decimals the option's markup column holds (0296: numeric(12,6)). */
export const OPTION_MARKUP_DECIMALS = 6;

function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * The markup % that sells `cost` at exactly `sell` (to the cent), with as few decimals as that
 * takes. Returns null when no markup can: a cost of zero (sell is cost plus markup, and there is
 * no cost to mark up) or a negative sell.
 */
export function markupForSell(cost: number, sell: number, maxDecimals = OPTION_MARKUP_DECIMALS): number | null {
  const c = Number(cost);
  const s = Number(sell);
  if (!Number.isFinite(c) || !Number.isFinite(s) || c <= 0 || s < 0) return null;
  const target = roundTo(s, 2);
  const exact = (target / c - 1) * 100;
  for (let d = 0; d <= maxDecimals; d += 1) {
    const m = roundTo(exact, d);
    if (sellPrice(c, m) === target) return m;
  }
  return roundTo(exact, maxDecimals);
}

/**
 * A typed Sell on one vendor's row → the patch it writes, or the sentence saying why not.
 * The patch is always the option's OWN markup: typing a sell on a vendor that was falling
 * through to the item's markup is a decision about this vendor, so it stops falling through.
 */
export function optionSellPatch(
  option: Pick<ItemOption, "buy_price">,
  raw: string | number,
): { patch: { markup_pct: number }; sell: number } | { error: string } {
  const n = typeof raw === "number" ? (Number.isFinite(raw) ? raw : null) : parseCellNumber(raw);
  if (n === null) return { error: "That sell price isn't a number." };
  if (n < 0) return { error: "Sell can't be negative." };
  const cost = Number(option.buy_price) || 0;
  if (cost <= 0) return { error: "Type this vendor's cost first. Sell is cost plus markup." };
  const m = markupForSell(cost, n);
  if (m === null) return { error: "That sell price can't be reached from this cost." };
  if (m <= -100) return { error: "A sell of nothing would be a markup of -100%. Archive the vendor instead." };
  if (m < 0) return { error: `Sell is below this vendor's cost of ${formatCurrency(cost)}. Set it at cost or above.` };
  return { patch: { markup_pct: m }, sell: roundTo(n, 2) };
}

/** A markup for the screen: at most two decimals, so a stored 23.456789 reads "23.46". The
 *  stored number is what prices; this is only how it is written down. */
export function showPct(pct: number): string {
  const n = Number(pct) || 0;
  return String(roundTo(n, 2));
}

/* ── VENDORS ACROSS ITEMS ──────────────────────────────────────────────────────────────────────
   A vendor is a NAME: the same name on price_list_item_options.vendor (0282) and, optionally, a
   card on price_list_vendors (0296) with the phone number. Compared case-insensitively and with
   the edges trimmed, exactly as 0282's one-per-maker index and 0296's one-per-name index compare
   them. Nothing fuzzier: "Andersen Windows" is not "Andersen" until a person says so. */

/** The key two spellings of one vendor share. Mirrors lower(btrim(name)) in both indexes. */
export function vendorKey(name: string | null | undefined): string {
  return String(name ?? "").trim().toLowerCase();
}

/** One vendor card (0296), as the page reads it. */
export interface VendorCard {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  notes: string | null;
  archived: boolean;
}

export type VendorCardField = "name" | "contact_name" | "phone" | "email" | "website" | "address" | "notes";

export const VENDOR_CARD_FIELDS: VendorCardField[] = ["name", "contact_name", "phone", "email", "website", "address", "notes"];

/** One item a vendor is on, with the numbers the row shows. */
export interface VendorItemRow {
  item: PriceItem;
  option: ItemOption;
  cost: number;
  sell: number;
  pct: number;
  source: MarkupSource;
  unit: string;
}

/** A vendor as the Vendors tab lists it: its card (when it has one) and every item it is on. */
export interface VendorSummary {
  key: string;
  /** The card's spelling when there is a card, else the most common spelling on the items. */
  name: string;
  card: VendorCard | null;
  /** Live (non-archived) options on live items, sorted by the item's code then description. */
  items: VendorItemRow[];
  /** How many of those items price at this vendor when nobody picks. */
  defaults: number;
  /** Archived options of this vendor, so "Show Archived" can bring one back. */
  archivedItems: VendorItemRow[];
}

/**
 * Every vendor in the org: one per name, whether it came from a card, from items, or both.
 * Pure, so the grouping (the one place two spellings could split a vendor in two) is tested.
 * A vendor on no live item is left out unless it has a live card; one still on items stays
 * listed (even with its card archived), because its prices still quote.
 */
export function summarizeVendors(
  options: ItemOption[],
  items: PriceItem[],
  cards: VendorCard[],
  orgDefaultPct: number,
): VendorSummary[] {
  const itemById = new Map(items.map((i) => [i.id, i]));
  type Acc = VendorSummary & { spellings: Map<string, number> };
  const byKey = new Map<string, Acc>();
  const get = (name: string): Acc => {
    const key = vendorKey(name);
    let s = byKey.get(key);
    if (!s) {
      s = { key, name: name.trim(), card: null, items: [], defaults: 0, archivedItems: [], spellings: new Map() };
      byKey.set(key, s);
    }
    return s;
  };
  for (const c of cards) {
    if (!vendorKey(c.name)) continue;
    const s = get(c.name);
    s.card = c;
    s.name = c.name.trim();
  }
  for (const o of options) {
    if (!vendorKey(o.vendor)) continue;
    const item = itemById.get(o.item_id);
    if (!item || item.archived) continue;
    const s = get(o.vendor);
    const v = optionView(o, item, orgDefaultPct);
    const row: VendorItemRow = { item, option: o, cost: v.cost, sell: v.sell, pct: v.pct, source: v.source, unit: v.unit };
    if (o.archived) {
      s.archivedItems.push(row);
      continue;
    }
    s.items.push(row);
    if (o.is_default) s.defaults += 1;
    const sp = o.vendor.trim();
    s.spellings.set(sp, (s.spellings.get(sp) ?? 0) + 1);
  }
  const byItem = (a: VendorItemRow, b: VendorItemRow) =>
    String(a.item.code ?? "").localeCompare(String(b.item.code ?? ""), undefined, { numeric: true }) ||
    a.item.description.localeCompare(b.item.description) ||
    optionName(a.option).localeCompare(optionName(b.option));
  return [...byKey.values()]
    .map(({ spellings, ...s }) => {
      if (!s.card && spellings.size) {
        // No card: the spelling most items use is the one the list reads; on a tie, the one that
        // starts with a capital (a brand is a proper name), then alphabetical so it is stable.
        const capital = (x: string) => (/^[A-Z]/.test(x) ? 0 : 1);
        s.name = [...spellings.entries()].sort(
          (a, b) => b[1] - a[1] || capital(a[0]) - capital(b[0]) || a[0].localeCompare(b[0]),
        )[0][0];
      }
      s.items.sort(byItem);
      s.archivedItems.sort(byItem);
      return s;
    })
    // Listed while it prices an item or has a live card. A vendor whose rows are all archived and
    // has no card is gone from here (a second Archive on it could only refuse); its archived rows
    // come back from each item's Show Archived Vendors, and the archive toast carries Undo.
    .filter((s) => s.items.length > 0 || (s.card !== null && !s.card.archived))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every vendor name the org already spells one way, for the vendor box's suggestions, so the
 *  next item gets "Andersen" and not "Anderson". Cards first (a person chose that spelling). */
export function knownVendorNames(options: Pick<ItemOption, "vendor">[], cards: Pick<VendorCard, "name" | "archived">[]): string[] {
  const seen = new Map<string, string>();
  for (const c of cards) {
    const k = vendorKey(c.name);
    if (!c.archived && k && !seen.has(k)) seen.set(k, c.name.trim());
  }
  for (const o of options) {
    const k = vendorKey(o.vendor);
    if (k && !seen.has(k)) seen.set(k, o.vendor.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** The spelling the org already uses for this vendor, when it has one; else the typed one,
 *  trimmed. "andersen" typed on a new item becomes "Andersen" when Andersen is already a vendor,
 *  so one brand never becomes two spellings (the CED lesson: five spellings, one supplier). */
export function canonicalVendorName(typed: string, known: string[]): string {
  const k = vendorKey(typed);
  return known.find((n) => vendorKey(n) === k) ?? typed.trim();
}

/** The vendor-card fields a person typed → the columns, or the sentence saying why not. Only the
 *  fields passed are touched (a phone edit never blanks the email). Blank is null. */
export function cleanVendorCard(
  input: Partial<Record<VendorCardField, string | null | undefined>>,
  mode: "create" | "update",
): { clean: Partial<Record<VendorCardField, string | null>> } | { error: string } {
  const clean: Partial<Record<VendorCardField, string | null>> = {};
  const limits: Record<VendorCardField, number> = {
    name: 120,
    contact_name: 120,
    phone: 40,
    email: 200,
    website: 300,
    address: 300,
    notes: 2000,
  };
  const words: Record<VendorCardField, string> = {
    name: "name",
    contact_name: "contact person",
    phone: "phone number",
    email: "email",
    website: "website",
    address: "address",
    notes: "note",
  };
  for (const f of VENDOR_CARD_FIELDS) {
    if (input[f] === undefined && !(f === "name" && mode === "create")) continue;
    const v = String(input[f] ?? "").trim();
    if (f === "name" && !v) return { error: "Name the vendor: the brand, e.g. Andersen." };
    if (v.length > limits[f]) return { error: `That ${words[f]} is too long. Keep it under ${limits[f]} characters.` };
    if (f === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      return { error: "That email doesn't look right. It needs an @ and a domain." };
    }
    clean[f] = v || null;
  }
  return { clean };
}

/** A website as a link: "andersenwindows.com" opens as https://andersenwindows.com. Anything that
 *  isn't a plain web address comes back null, so a typed note never becomes a link. */
export function websiteHref(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A 0296 unique-name refusal, said in English with the way out. */
export function vendorCardRefusal(err: unknown, name?: string | null): string {
  const raw = typeof err === "string" ? err : String((err as { message?: unknown } | null)?.message ?? "");
  if (raw.includes("price_list_vendors_one_per_name")) {
    return `${name?.trim() || "That vendor"} is already on your Vendors list. Open it there instead of adding it again.`;
  }
  return dbError(err);
}
