/**
 * PRICE-LIST CSV HEADER MAPPING — pure, so it can be tested.
 *
 * The lesson it encodes (Vivian Builders, 2026-09-03): their sheet's "Cost Code" column matched
 * BOTH the code pattern (/code/) and the cost pattern (/cost/), so every row imported with
 * buy_price = its own code number (code 010 → $10.00). Two rules fix the class, not the instance:
 *   1. ONE COLUMN NEVER FEEDS TWO FIELDS — a header claimed by an earlier field is off the table.
 *   2. Fields are tried in the order that disambiguates: code before cost, so "Cost Code" is a code.
 * Plus the field the importer never had: unit.
 */
export type PriceCsvField = "code" | "description" | "category" | "supplier" | "unit" | "buy_price" | "markup_pct";

export const PRICE_CSV_FIELDS: { key: PriceCsvField; label: string; match: RegExp }[] = [
  { key: "code", label: "Item code", match: /code|item|part|sku|catalog|number|#/i },
  { key: "description", label: "Description", match: /desc|name|product|detail/i },
  { key: "category", label: "Category", match: /categ|group|class|type|division/i },
  { key: "supplier", label: "Supplier", match: /supplier|vendor|manufactur|brand|mfg/i },
  // A header that also says price/cost/rate/amount is a PRICE column ("Unit Price", "Cost per unit"),
  // never the unit — the negative lookahead keeps it for buy_price below.
  { key: "unit", label: "Unit", match: /^(?!.*\b(price|cost|rate|amount)\b).*(\bunit\b|\buom\b|\bum\b|\bper\b|measure)/i },
  { key: "buy_price", label: "Buy price", match: /price|cost|buy|net|amount|each|rate/i },
  { key: "markup_pct", label: "Markup %", match: /markup|margin/i },
];

/** Header → column index for each field it can confidently claim. Never maps one column twice. */
export function autoMapPriceHeaders(headers: string[]): Partial<Record<PriceCsvField, number>> {
  const map: Partial<Record<PriceCsvField, number>> = {};
  const claimed = new Set<number>();
  for (const f of PRICE_CSV_FIELDS) {
    const idx = headers.findIndex((h, i) => !claimed.has(i) && f.match.test(h.trim()));
    if (idx >= 0) {
      map[f.key] = idx;
      claimed.add(idx);
    }
  }
  return map;
}
