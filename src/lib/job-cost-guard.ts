/**
 * THE RULE EVERY DOOR THAT PUTS A COST ON A JOB IS HELD TO (item C2; audit v994's DB4 finished).
 *
 * A negative bill on a job is a supplier return, and the importer credits it to the customer. What
 * holds that credit to what the customer was actually billed is its LINES: each returned part is
 * matched to the purchase it reverses and credited at most what that purchase billed
 * (returnLinesAgainstPurchases), and a line can be switched off like any other. With no lines there
 * is nothing to match and nothing to switch off, so the whole return is credited at markup - the
 * INV-078 housings, credited to Andrew when he was never charged for them.
 *
 * DB4 put that rule on the PAPER door: the receipt reader and the tray's File It asked first, and
 * insertItemizedBill refused behind them. Typing the cost in, Nort and the Edit Bill box never
 * asked - and the Edit Bill box is the shortest road to it, because a bank credit lands as a
 * business cost with no lines at all and one dropdown re-points it onto a job.
 *
 * So the rule lives HERE, at the write, and all FOUR doors ask this one function:
 *   · insertItemizedBill         (a paper filed from Organize, a receipt read on the job page, shop stock)
 *   · createBill                 (Type It In, Add By Hand, Nort's bill.create)
 *   · updateBill                 (the Edit Bill box, Nort's bill.update: a re-point or a re-price)
 *   · recordSupplierInvoiceAsBill (Record It As A Bill on the supplier's card)
 * A business cost is the company's own book and never reaches a customer, so it is not held to it.
 *
 * TEETH: bills-write-guard.test.ts fails if a file that inserts or updates `bills` does not come
 * through here, and no door may write the predicate itself.
 */

/** A negative total with no described line under it. */
export function isLinelessReturn(total: number | null | undefined, lines: unknown): boolean {
  if (total === null || total === undefined || !(Math.round(Number(total) * 100) < 0)) return false;
  const list = Array.isArray(lines) ? lines : [];
  return !list.some((l) => l && typeof l === "object" && String((l as { description?: unknown }).description ?? "").trim());
}

/** WHY it is refused, in the words a person reads. Every door's sentence starts with this one, so
 *  the reason cannot drift from door to door; each door adds its own next step after it. */
export const RETURN_ON_JOB_WHY =
  "This is a return with no lines on it, so on a job it would credit the customer the whole amount, even for parts they were never charged for.";

/** What a job cost is about to be, as the write will store it. */
export type JobCostWrite = {
  /** null = a business cost or a shop-stock ticket: the company's own book. */
  jobId: string | null;
  amount: number | null | undefined;
  /** The lines that will sit under it (a bill's own rows, or the paper's as read). */
  lines: unknown;
};

/**
 * The refusal this write earns, or null when it may go through. `next` is the door's own next step
 * ("Press Read Again so its lines come with it"), appended to the one reason.
 */
export function jobCostRefusal(write: JobCostWrite, next?: string): string | null {
  if (!write.jobId) return null;
  if (!isLinelessReturn(write.amount, write.lines)) return null;
  return next ? `${RETURN_ON_JOB_WHY} ${next}` : RETURN_ON_JOB_WHY;
}
