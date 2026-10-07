import { formatCurrency } from "@/lib/utils";

/**
 * A RECEIPT AN INVOICE BILLS MAY NOT CHANGE JOBS, AND MAY NOT CHANGE PRICE.
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
 * leaves the invoice and the receipt describing the same purchase at two different prices, and the
 * difference reaches no invoice ever: the claimed id is skipped by every later import. A finished
 * job's claimed CED bill was edited in place on 10-04 and the paid invoice that bills it never heard.
 *
 * THE SHAPE (Erik, 2026-10-07, the correction door's question 4): both are refused.
 *
 *   - a claimed receipt may NOT move to another job (those materials were billed to THIS job's
 *     customer, and the claim follows the id, not the job) - refused, nothing written;
 *   - a claimed receipt's AMOUNT may NOT change either. It used to save with a warning ("the invoice
 *     keeps its figure, edit it by hand"); now the supplier's later paper goes on a CORRECTION
 *     (Correct This Bill, 0381): its own bill under the original, with its own lines and its own
 *     claimable id, which the next invoice picks up like any bill on the job. The refusal names
 *     that door, in the database's own words.
 *
 * Pure on purpose: the arithmetic and the sentences are pinned by unit tests with no database,
 * and the door in actions.ts does the two reads and nothing else.
 *
 * THE DURABLE VERSION OF BOTH RULES IS A TRIGGER, and both triggers are live: guard_bill_claim
 * (0280) refuses the job move, guard_claimed_bill_amount (0381) refuses the re-price, and each
 * raises the same sentence this file builds. The door says it first so nothing is sent to the
 * database that it would only refuse; the trigger is the boundary.
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

export type BillEditPlan = { ok: true } | { ok: false; error: string };

/** Cents, as an integer. Money is numeric(12,2) in the database and a cent is a real edit, but
 *  `Math.abs(456.03 - 456.02) >= 0.01` is a coin flip in binary floating point - it can land on
 *  0.00999999999999090 and swallow the very change the refusal exists to catch. Compare the
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
 * THE RE-PRICE REFUSAL, word for word what 0381's guard_claimed_bill_amount raises, so the door and
 * the database teach Erik one way out. It names the door that moves the figure (Correct This Bill:
 * the difference becomes its own bill under this one, and the NEXT invoice carries it) - never
 * Import Costs, which skips a claimed bill by design, so pointing at it would be a dead end dressed
 * as an instruction. `before` is the figure the bill holds now, the one the invoice bills.
 */
export function billRepricedRefusal(holder: BillClaimHolder, before: number): string {
  return (
    `${claimantLabel(holder)} already bills this receipt at ${formatCurrency(before)}. Its figure stays. ` +
    `Put the difference on a correction (Correct This Bill) and the next invoice carries it. Nothing was changed.`
  );
}

/**
 * Decide, before a single column is written, what this edit is allowed to do. `holder` is only
 * consulted when a guarded field actually moved, so an unclaimed receipt and an ordinary edit
 * (supplier spelling, a date, marking it paid) both plan to a bare `{ ok: true }`. A claimed
 * receipt that moves OR re-prices writes nothing.
 */
export function planBillEdit(edit: BillEdit, holder: BillClaimHolder): BillEditPlan {
  const { movingJob, repricing } = guardedFieldsMoved(edit);
  if (!holder || (!movingJob && !repricing)) return { ok: true };
  // The move is said first when a save does both: it is the one the receipt's job hangs on, and
  // neither half is written either way.
  if (movingJob) return { ok: false, error: billMoveRefusal(holder) };
  return { ok: false, error: billRepricedRefusal(holder, edit.storedAmount) };
}
