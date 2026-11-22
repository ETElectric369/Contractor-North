/**
 * THE DEPOSIT AN ESTIMATE STORES (cn-v1177). lib/deposit-rule turns a total into the company's deposit;
 * this file decides what ONE estimate's `deposit_amount` (0414) holds after a save, and what the editor
 * shows for it, so the server's write and the editor's figure are one rule in one function.
 *
 *   An estimate still on offer (draft or sent) follows its total: the company's rule (depositFor), or,
 *   when a person typed a figure (deposit_by_hand), that figure, never above the total.
 *   An estimate no longer on offer (accepted, declined, expired, superseded) keeps what it stated: the
 *   deposit is a term of the offer the customer saw. It is only ever lowered to the total, so the
 *   paper never asks for more than the work. One saved before 0414 (null) stays null: nothing is
 *   stated for it and nothing is offered.
 *   A company rule that could not be read (null) changes nothing it would have computed: the stored
 *   figure stands (lowered to the total if it is above it).
 *
 * Pure: no catalog, no database, no clock. Client-safe (the editor imports it).
 */
import { depositFor, type DepositRule } from "@/lib/deposit-rule";

const cents = (n: number): number => Math.round(n * 100) / 100;

/** A number somebody meant (a finite number, or a string that is one); anything else is null. */
function meant(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Draft and sent are the two states in which the offer can still change. */
export function depositFollowsTotal(status: unknown): boolean {
  return status === "draft" || status === "sent";
}

export type EstimateDepositFacts = {
  /** The estimate's total, as the save just computed it. */
  total: unknown;
  status: unknown;
  /** The two 0414 columns as they stand. */
  stored: unknown;
  byHand: unknown;
  /** The company's rule (getOrgSettings: deposit_percent / deposit_cap_amount); null = could not be read. */
  rule: DepositRule | null;
};

/**
 * What `deposit_amount` becomes after a save. `undefined` = leave the column exactly as it is.
 */
export function storedDepositAfterSave(f: EstimateDepositFacts): number | undefined {
  const total = Math.max(0, cents(meant(f.total) ?? 0));
  const stored = meant(f.stored);
  const lowered = (): number | undefined => (stored !== null && stored > total ? total : undefined);
  if (!depositFollowsTotal(f.status)) return lowered();
  if (f.byHand === true && stored !== null) return Math.min(Math.max(0, cents(stored)), total);
  if (!f.rule) return lowered();
  return depositFor(total, f.rule);
}

export type DepositShown = {
  amount: number;
  /** Where the figure comes from: the company's rule, a person's typing, or nothing stated. */
  from: "default" | "typed" | "none";
  /** On offer, but the row has no figure yet (saved before 0414): the next save states it. */
  notStatedYet: boolean;
};

/**
 * What the editor's Deposit field shows: on offer, the figure the next save stores (the same rule as
 * storedDepositAfterSave over the live total); no longer on offer, the stored figure.
 */
export function depositShown(f: EstimateDepositFacts): DepositShown {
  const total = Math.max(0, cents(meant(f.total) ?? 0));
  const stored = meant(f.stored);
  const typed = f.byHand === true && stored !== null;
  if (!depositFollowsTotal(f.status)) {
    const amount = stored === null ? 0 : Math.min(Math.max(0, cents(stored)), total);
    return { amount, from: amount > 0 ? (typed ? "typed" : "default") : "none", notStatedYet: false };
  }
  if (typed) return { amount: Math.min(Math.max(0, cents(stored)), total), from: "typed", notStatedYet: false };
  const amount = f.rule ? depositFor(total, f.rule) : Math.min(Math.max(0, cents(stored ?? 0)), total);
  return { amount, from: amount > 0 ? "default" : "none", notStatedYet: stored === null };
}
