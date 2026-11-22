/**
 * THE DEPOSIT RULE (cn-v1177): a percent of the estimate's total, held under a dollar cap.
 *
 * Erik, 2026-11-21: "california has a 10% or $1000 cap so that should be the default". The percent was
 * already a company setting (deposit_percent); the cap is its own setting (deposit_cap_amount), because
 * other states and other trades differ. ONE function turns a total into a deposit, and every reader comes
 * through it: the estimate's save (which stores the figure on the estimate), the job's payment schedule
 * and the New Invoice sheet. Nothing recomputes it by hand, and no SQL carries a twin of it: the
 * customer's link reads the figure the estimate stored.
 *
 * Pure: no catalog, no database, no clock.
 */

/** What a company that never chose gets. A stored 0 percent is a choice: no deposit. */
export const DEFAULT_DEPOSIT_PERCENT = 10;
export const DEFAULT_DEPOSIT_CAP = 1000;

export type DepositRule = {
  /** 0 to 100. 0 = this company asks for no deposit. */
  percent: number;
  /** Dollars. 0 = no cap. */
  cap: number;
};

const cents = (n: number): number => Math.round(n * 100) / 100;

/** A number somebody meant: a finite number, or a string that is one. Never a boolean, never null. */
function meant(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * SANITIZE ON READ. The settings are jsonb with no validation in front of the write, so the reader
 * clamps: a percent outside 0..100 or a negative cap never reaches a customer's estimate. A value that
 * is not a number at all reads as the default, the way a missing key does.
 */
export function clampDepositRule(raw: { percent?: unknown; cap?: unknown } | null | undefined): DepositRule {
  const p = meant(raw?.percent);
  const c = meant(raw?.cap);
  return {
    percent: p === null ? DEFAULT_DEPOSIT_PERCENT : cents(Math.min(100, Math.max(0, p))),
    cap: c === null ? DEFAULT_DEPOSIT_CAP : cents(Math.max(0, c)),
  };
}

/**
 * The deposit for one total: the percent of it, never more than the cap (when there is one), never more
 * than the total itself, never negative. A total of nothing, or a percent of nothing, is no deposit.
 */
export function depositFor(total: unknown, rule: DepositRule): number {
  const t = meant(total) ?? 0;
  if (t <= 0.005) return 0;
  const pct = Math.min(100, Math.max(0, meant(rule?.percent) ?? 0));
  if (pct <= 0) return 0;
  let deposit = cents((t * pct) / 100);
  const cap = Math.max(0, meant(rule?.cap) ?? 0);
  if (cap > 0.005) deposit = Math.min(deposit, cents(cap));
  return Math.max(0, Math.min(deposit, cents(t)));
}
