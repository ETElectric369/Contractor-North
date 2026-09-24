import { formatCurrency } from "@/lib/utils";

/**
 * A RECEIPT AN INVOICE BILLS MAY NOT CHANGE JOBS, AND MAY NOT CHANGE PRICE IN SILENCE.
 *
 * This is the materials twin of timeclock/claim-words.ts, and it exists for the same reason that one
 * does. An invoice line claims the bill it billed (invoice_items.source_ids, 0255), the importer
 * skips a claimed id forever after, and the claim is BY ID: it does not care which job the bill
 * sits on. So re-pointing a claimed receipt at the right job used to save clean and cost money at
 * both ends at once. INV-063 went on charging the old customer for $456.02 of CED, and the job the
 * receipt had just moved to could never be billed for it, because importCostsIntoInvoice looks at
 * that same claimed id and skips it. Neither screen said a word.
 *
 * Re-pricing is the quieter half. A receipt's lines are trued up to the bill's amount (the anchor
 * invariant: the rows sum to mark(bill.amount - excluded)), so editing `amount` on a claimed bill
 * leaves the invoice and the receipt describing the same purchase at two different prices, with
 * nothing on either screen saying they disagree.
 *
 * THE SHAPE, and why it is not the obvious one. The obvious shape refuses both. The time side
 * already worked out that refusing both is wrong: a typo is a typo, and a door that will not let
 * Erik fix a figure is a door he fights instead of uses. So the rule splits, exactly as it splits
 * for hours:
 *
 *   • a claimed receipt may NOT move to another job (those materials were billed to THIS job's
 *     customer, and the claim follows the id, not the job) - refused, nothing written;
 *   • a claimed receipt's AMOUNT may change, and the answer says so out loud, naming the invoice
 *     and both figures, because the invoice keeps the number it went out with.
 *
 * Pure on purpose: the arithmetic and the sentences are pinned by unit tests with no database,
 * and the door in actions.ts does the two reads and nothing else.
 *
 * THE DURABLE VERSION OF THE FIRST RULE IS A TRIGGER, not this file. 0278 gave DELETE its ceiling
 * (guard_billed_bill); a job move still has no `guard_bill_claim` BEFORE UPDATE behind it, so this
 * is a door-side refusal until that migration is written. Said plainly here so nobody reads it as
 * a boundary it is not.
 */

/** The invoice holding the claim, as the door read it. `null` = nothing bills this receipt. */
export type BillClaimHolder = { invoice_number: string | null } | null;

/** What the office submitted against what the row stores. An absent `next*` = the patch does not
 *  touch that field at all (PATCH semantics: bills-receipts sends job_id every save, job-bills
 *  never sends it, so "did it actually move" can only be answered against the stored row). */
export type BillEdit = {
  storedJobId: string | null;
  storedAmount: number;
  /** undefined = untouched. null = company overhead (no job). */
  nextJobId?: string | null;
  /** undefined = untouched. */
  nextAmount?: number;
};

export type BillEditPlan = { ok: true; warning?: string } | { ok: false; error: string };

/** Cents, as an integer. Money is numeric(12,2) in the database and a cent is a real edit, but
 *  `Math.abs(456.03 - 456.02) >= 0.01` is a coin flip in binary floating point - it can land on
 *  0.00999999999999090 and swallow the very change the warning exists to announce. Compare the
 *  cents themselves and the question has one answer. */
const cents = (n: number | null | undefined): number => Math.round((Number(n) || 0) * 100);

/** The label that leads the sentence. A draft carries no number yet, and "An invoice already
 *  bills this receipt" still reads as a sentence and still tells the truth. */
export function claimantLabel(holder: BillClaimHolder): string {
  return holder?.invoice_number || "An invoice";
}

/**
 * Which guarded fields this edit actually moves. Supplier, bill number, date, status, notes,
 * category and the PO link move nothing an invoice claims, so they never pay for the claim read:
 * an edit that touches none of these two fields skips it entirely.
 */
export function guardedFieldsMoved(edit: BillEdit): { movingJob: boolean; repricing: boolean } {
  return {
    movingJob: edit.nextJobId !== undefined && (edit.nextJobId || null) !== (edit.storedJobId || null),
    repricing: edit.nextAmount !== undefined && cents(edit.nextAmount) !== cents(edit.storedAmount),
  };
}

/** The refusal. The escape hatch is 0278's guard_billed_bill sentence, word for word, so the two
 *  doors that stand between Erik and a claimed receipt do not teach him two different ways out. */
export function billMoveRefusal(holder: BillClaimHolder): string {
  return (
    `${claimantLabel(holder)} already bills this receipt on the job it is on now. ` +
    `Void that invoice, or take its materials lines off, then move the receipt. Nothing was changed.`
  );
}

/**
 * The warning. It says "open that invoice and edit it" rather than "re-import costs" on purpose:
 * re-importing SKIPS a claimed bill by design, so pointing at that button would be a dead end
 * dressed as an instruction. By hand is the door that actually moves the figure.
 */
export function billRepricedWarning(holder: BillClaimHolder, before: number, after: number): string {
  return (
    `${claimantLabel(holder)} bills this receipt at ${formatCurrency(before)} and it now reads ` +
    `${formatCurrency(after)}. The invoice keeps its figure. Open that invoice and edit its ` +
    `materials lines by hand if the customer should pay the difference.`
  );
}

/**
 * Decide, before a single column is written, what this edit is allowed to do. `holder` is only
 * consulted when a guarded field actually moved, so an unclaimed receipt and an ordinary edit
 * (supplier spelling, a date, marking it paid) both plan to a bare `{ ok: true }`.
 */
export function planBillEdit(edit: BillEdit, holder: BillClaimHolder): BillEditPlan {
  const { movingJob, repricing } = guardedFieldsMoved(edit);
  if (!holder || (!movingJob && !repricing)) return { ok: true };
  // The move is refused first and on its own: a save that both moves and re-prices writes
  // nothing, so the warning would be describing an edit that never happened.
  if (movingJob) return { ok: false, error: billMoveRefusal(holder) };
  return { ok: true, warning: billRepricedWarning(holder, edit.storedAmount, edit.nextAmount ?? 0) };
}
