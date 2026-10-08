/**
 * ONE PERSON, ONE ROW on Needs You (Erik, 2026-09-26: "the same fact never shows as two rows").
 *
 * A lead gets a Call Back row while its follow-up day is today or past. When that lead's visit has
 * already HAPPENED and is waiting to be written up, Needs You drew two rows for one person (Macey
 * Dade, 2026-10-08: "Macey Dade · Call Back · 7d overdue" and "Inspection · Macey Dade · Write It
 * Up"). The call-back was for booking the visit; the visit is done, so the write-up IS the next
 * step. The lead rides its write-up row: its own row (Now or the Waiting fold) stays out until the
 * write-up is settled, and the pile counts only what is drawn.
 */
import type { PileCount } from "./piles";

/** True when this lead's visit is on the write-up list: the lead's own row stays out. */
export function leadRidesItsWriteUp(inquiryId: unknown, writeUpLeadIds: ReadonlySet<string>): boolean {
  return inquiryId != null && writeUpLeadIds.has(String(inquiryId));
}

/** A read's exact count, less the rows the code kept out, never below zero or dressed as a pile. */
export function lessRidden(count: PileCount, ridden: number): PileCount {
  if (typeof count.total !== "number") return count;
  const total = count.total - ridden;
  return total > 0 ? { ...count, total } : {};
}
