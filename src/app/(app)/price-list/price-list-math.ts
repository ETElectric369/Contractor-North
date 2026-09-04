/**
 * THE PRICE LIST'S PURE ARITHMETIC — everything the table computes that isn't a render, so it
 * can be tested without a browser. The four sell functions live in lib/pricing/markup.ts (the
 * one place cost turns into sell); this file only decides WHICH of them an edit calls and what
 * the row shows. Nothing here writes a computed sell: the book stores cost + markup, full stop.
 */
import { effectiveMarkupPct, marginFromMarkup, markupFromMargin, markupFromSell, sellPrice } from "@/lib/pricing/markup";
import { normalizeUnit } from "@/lib/pricing/units";

export interface PriceItem {
  id: string;
  code: string | null;
  description: string;
  category: string | null;
  supplier: string | null;
  unit: string;
  buy_price: number;
  markup_pct: number;
  updated_at?: string | null;
  archived?: boolean;
  // 0240 sizing — present once the migration has run, absent (undefined) on an older deploy.
  qty_per_sqft?: number | null;
  qty_per_lf?: number | null;
  qty_min?: number | null;
  qty_round?: string | null;
  sized_by?: string | null;
  qty_per?: number | null;
}

/** What one row shows. `usesDefault` = the item's own pct is 0 and the org default is filling
 *  in — the faint "default" tag next to MU%, so a net-cost import never looks hand-marked-up. */
export function rowView(item: Pick<PriceItem, "buy_price" | "markup_pct">, orgDefaultPct: number) {
  const cost = Number(item.buy_price) || 0;
  const itemPct = Number(item.markup_pct) || 0;
  const pct = effectiveMarkupPct({ itemPct, orgDefaultPct });
  return {
    cost,
    pct,
    usesDefault: itemPct <= 0 && pct > 0,
    sell: sellPrice(cost, pct),
    margin: marginFromMarkup(pct),
  };
}

export type InlineField = "unit" | "cost" | "markup" | "margin" | "sell";

export type InlinePatch = { unit?: string; buy_price?: number; markup_pct?: number };

/**
 * An inline edit → the columns it actually writes. Editing sell or margin back-solves a markup;
 * editing cost writes cost alone (sell follows at the current effective pct on the next render).
 * Returns { error } when the edit can't mean anything — a sell with no cost, a margin of 100%.
 */
export function patchForEdit(
  field: InlineField,
  raw: string,
  item: Pick<PriceItem, "buy_price" | "markup_pct" | "unit">,
): { patch: InlinePatch } | { error: string } {
  if (field === "unit") {
    return { patch: { unit: normalizeUnit(raw) } };
  }
  const n = parseCellNumber(raw);
  if (n === null) return { error: "That isn't a number." };
  const cost = Number(item.buy_price) || 0;
  switch (field) {
    case "cost":
      if (n < 0) return { error: "Cost can't be negative." };
      return { patch: { buy_price: Math.round(n * 100) / 100 } };
    case "markup":
      if (n <= -100) return { error: "A markup below -100% would sell for less than nothing." };
      return { patch: { markup_pct: Math.round(n * 100) / 100 } };
    case "margin":
      if (n >= 100) return { error: "Margin has to be under 100% — nothing sells for infinite money." };
      return { patch: { markup_pct: markupFromMargin(n) } };
    case "sell":
      if (cost <= 0) return { error: "Set a cost first — sell is cost plus markup." };
      if (n < 0) return { error: "Sell can't be negative." };
      return { patch: { markup_pct: markupFromSell(cost, n) } };
  }
}

/** "$1,234.50" → 1234.5 · "35%" → 35 · "" → null · "abc" → null. Accepts a leading minus. */
export function parseCellNumber(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const cleaned = s.replace(/[$,%\s]/g, "");
  if (!/^-?\d*\.?\d+$|^-?\d+\.?\d*$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** The values a patch overwrote — what the toast's Undo writes back. */
export function undoPatch(patch: InlinePatch, before: Pick<PriceItem, "buy_price" | "markup_pct" | "unit">): InlinePatch {
  const back: InlinePatch = {};
  if (patch.unit !== undefined) back.unit = before.unit;
  if (patch.buy_price !== undefined) back.buy_price = Number(before.buy_price) || 0;
  if (patch.markup_pct !== undefined) back.markup_pct = Number(before.markup_pct) || 0;
  return back;
}

/* ── CSV → rows ─────────────────────────────────────────────────────────────────────────────── */

export type CsvField = "code" | "description" | "category" | "supplier" | "unit" | "buy_price" | "markup_pct" | "kit" | "quantity";
export type CsvMapping = Partial<Record<CsvField, number>>;

/** The two fields the shared csv-map doesn't know: kit grouping and a kit quantity. Matched
 *  against headers no earlier field claimed (same one-column-one-field rule). */
export const EXTRA_CSV_FIELDS: { key: CsvField; label: string; match: RegExp }[] = [
  { key: "kit", label: "Kit", match: /\bkit\b|assembly|bundle|package/i },
  { key: "quantity", label: "Qty in Kit", match: /\bqty\b|quantity/i },
];

export function mapExtraHeaders(headers: string[], base: CsvMapping): CsvMapping {
  const map: CsvMapping = { ...base };
  const claimed = new Set<number>(Object.values(base).filter((v): v is number => typeof v === "number"));
  for (const f of EXTRA_CSV_FIELDS) {
    if (map[f.key] !== undefined) continue;
    const idx = headers.findIndex((h, i) => !claimed.has(i) && f.match.test(h.trim()));
    if (idx >= 0) {
      map[f.key] = idx;
      claimed.add(idx);
    }
  }
  return map;
}

export interface MappedRow {
  code: string;
  description: string;
  category: string;
  supplier: string;
  unit: string;
  /** null = the cell was blank (or the column unmapped) — never 0, which on an existing row
   *  would overwrite a real price. The server treats null as "no news". */
  buy_price: number | null;
  markup_pct: number | null;
  kit: string;
  quantity: number | null;
}

/** "$1,234.50" → 1234.5; a blank or unreadable cell → null (never 0: on an existing row a 0 would
 *  overwrite a real price, and "blank" has to be able to mean "no news"). */
const csvNum = (v: string | undefined): number | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** One CSV row through the mapping. Unmapped fields come back empty/null — the server treats an
 *  unmapped field as "don't touch" on an existing row via the `mapped` list, and a blank cell in
 *  a mapped column the same way via the null. */
export function rowThroughMapping(r: string[], m: CsvMapping): MappedRow {
  const cell = (f: CsvField) => (m[f] !== undefined ? String(r[m[f]!] ?? "").trim() : "");
  return {
    code: cell("code"),
    description: cell("description"),
    category: cell("category"),
    supplier: cell("supplier"),
    unit: cell("unit"),
    buy_price: csvNum(cell("buy_price")),
    markup_pct: csvNum(cell("markup_pct")),
    kit: cell("kit"),
    quantity: csvNum(cell("quantity")),
  };
}

/** The fields the sheet actually carried — what the server is allowed to refresh on a match. */
export function mappedFields(m: CsvMapping): Exclude<CsvField, "kit" | "quantity">[] {
  return (["code", "description", "category", "supplier", "unit", "buy_price", "markup_pct"] as const).filter((f) => m[f] !== undefined);
}

/** THE FORMULA, IN WORDS. The four sizing numbers were unreadable as a form ("Per square foot: 1,
 *  Never fewer than: 4, Rounding: up" — Erik: "hard to understand what's going on from a human
 *  perspective"). One sentence says what the item will do on an estimate. */
export function formulaSentence(f: {
  perSqft: number | "" | null | undefined;
  perLf: number | "" | null | undefined;
  qtyMin: number | "" | null | undefined;
  rounding: string | null | undefined;
  /** 0241: counted per ONE measurement — wins over the legacy pair when set. */
  sizedBy?: string | null;
  qtyPer?: number | "" | null;
  /** What to call that measurement (from measurementLabel); falls back to the key. */
  measurementLabel?: string | null;
}): string {
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 10000) / 10000));
  const sq = n(f.perSqft);
  const lf = n(f.perLf);
  const min = n(f.qtyMin);
  const parts: string[] = [];
  const per = n(f.qtyPer);
  if (f.sizedBy && per > 0) parts.push(`${fmt(per)} per ${f.measurementLabel || f.sizedBy.replace(/_/g, " ")}`);
  else {
    if (sq > 0) parts.push(`${fmt(sq)} per sq ft of the job`);
    if (lf > 0) parts.push(`${fmt(lf)} per linear ft of the job`);
  }
  if (!parts.length) return "Fixed quantity — you type the number on the estimate.";
  let s = `Counts ${parts.join(" plus ")}`;
  if (min > 0) s += `, never fewer than ${fmt(min)}`;
  s += f.rounding === "nearest" ? ", rounded to the nearest whole one." : f.rounding === "none" ? ", exact." : ", rounded up to whole units.";
  return s;
}
