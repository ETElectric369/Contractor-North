/**
 * THE ONE LABOR-RATE RULE for pricing an estimate's hours.
 *
 *   the customer's pricing-level labor rate, when the level has one (> 0)
 *     → else the org's default_labor_rate (Settings)
 *     → else 0, which every caller reads as "no rate set — say so, never guess one".
 *
 * It lived inline in runEstimator (`laborRate > 0 ? laborRate : orgS.default_labor_rate`) and
 * nowhere else, so the estimate seed had no rate at all and the builder never learned the org
 * default. One function, used by the server seed, the estimator and the builder, so a task's hours
 * price the same on every door ([[two-doors-one-thing]]).
 *
 * Billing CLOSED time is a different rule (labor-billing.ts: a person's bill_rate, capped at the
 * level rate) and stays there — this is the rate for hours he is QUOTING, not hours somebody worked.
 */
export function laborRateFor(levelRate: number | string | null | undefined, orgDefault: number | string | null | undefined): number {
  const level = Number(levelRate);
  if (levelRate != null && levelRate !== "" && Number.isFinite(level) && level > 0) return level;
  const def = Number(orgDefault);
  return Number.isFinite(def) && def > 0 ? def : 0;
}
