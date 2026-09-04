/**
 * THE one markup rule for pricing a price-book item — every sell-price consumer (quote
 * builder hand-picker, AI estimator, Nort's search_price_list, the public site-chat)
 * resolves markup through here so they can never disagree:
 *
 *   customer pricing-level markup (when the customer HAS a level — even 0%)
 *     → else the item's own markup_pct when it's > 0
 *     → else the org's default_markup_pct (Settings; 0 = disabled)
 *     → else 0.
 *
 * The org default exists for net-cost imports (e.g. a CED price feed lands with every
 * markup_pct at 0) — without it, a 0-markup item quotes at the company's real net cost.
 * An item's explicit markup (> 0) still wins over the org default, so a book with real
 * per-item markups is unaffected by setting one.
 */
export function effectiveMarkupPct({
  levelPct,
  itemPct,
  orgDefaultPct,
}: {
  /** The customer's pricing-level markup — null/undefined when the customer has no level. */
  levelPct?: number | null;
  /** The price-book item's own markup_pct (0 = "no markup set"). */
  itemPct?: number | null;
  /** The org-wide Settings default (default_markup_pct); 0 = disabled. */
  orgDefaultPct?: number | null;
}): number {
  const level = Number(levelPct);
  if (levelPct != null && Number.isFinite(level)) return level; // a level ALWAYS wins, even at 0%
  const item = Number(itemPct);
  if (Number.isFinite(item) && item > 0) return item;
  const def = Number(orgDefaultPct);
  if (Number.isFinite(def) && def > 0) return def;
  return 0;
}

/* ── THE SELL ARITHMETIC, ONCE. Ten call sites each carried their own `buy * (1 + pct/100)` with
   different rounding (none / toFixed(2) / Math.round). These are the only four functions that
   should ever turn cost into sell and back. Cents everywhere; markup to the column's two
   decimals (markup_pct is numeric(7,2)) so a typed sell comes back as typed; margin — display
   only — to one. ── */

/** Sell price from cost and markup %, rounded to cents. */
export function sellPrice(buy: number, markupPct: number): number {
  const b = Number(buy) || 0;
  const p = Number(markupPct) || 0;
  return Math.round(b * (1 + p / 100) * 100) / 100;
}

/** Markup % implied by a cost and a sell price (the back-solve when someone types the sell). */
export function markupFromSell(buy: number, sell: number): number {
  const b = Number(buy) || 0;
  const s = Number(sell) || 0;
  if (b <= 0) return 0;
  return Math.round(((s / b) - 1) * 10000) / 100;
}

/** Margin % (profit over SELL) for a given markup % — a 25% markup is a 20% margin. */
export function marginFromMarkup(markupPct: number): number {
  const p = Number(markupPct) || 0;
  if (p <= -100) return 0;
  return Math.round((p / (100 + p)) * 1000) / 10;
}

/** Markup % for a target margin % — the other direction of the same identity. */
export function markupFromMargin(marginPct: number): number {
  const m = Number(marginPct) || 0;
  if (m >= 100) return 0;
  return Math.round((m / (100 - m)) * 10000) / 100;
}
