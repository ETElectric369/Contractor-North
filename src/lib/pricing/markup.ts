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
