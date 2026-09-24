/**
 * THE WORDS FOR A BILLED SHIFT THAT IS BEING EDITED (0255, the claims model).
 *
 * A labor line on an invoice claims the time_entry ids it billed (invoice_items.source_ids), and the
 * importers skip a claimed id, so the same hour can never land on two invoices. Two things can still
 * happen to a billed shift, and each has one sentence, said the same way by every door:
 *
 *   * its hours change (a typo fixed, a lunch confirmed, a split moved): allowed, and the answer
 *     says which invoice and both figures, because the invoice keeps the figure it went out with;
 *   * it is moved to another job: refused (updateTimeEntry here, and 0288's
 *     time_entries_billed_job_stays under it), because its hours went out on THIS job's invoice.
 *
 * This file used to be allocation-claims.ts, which also planned edits to the old second ledger of
 * split hours. A split is a cut into ordinary entries now (0288), so the planning went with it and
 * only the words are left.
 */

/** The invoice that holds a claim on a source row. */
export type ClaimHolder = { id: string; invoice_number: string | null };

/** source row id (a time_entry id) → the non-void invoice that bills it. */
export type ClaimIndex = ReadonlyMap<string, ClaimHolder>;

const invoiceLabel = (h: ClaimHolder | undefined): string => h?.invoice_number ?? "an invoice";
const fmtHours = (h: number | null | undefined): string => `${(Math.round((Number(h) || 0) * 100) / 100).toFixed(2)} h`;

/**
 * BILLED HOURS MAY CHANGE, BUT NEVER SILENTLY.
 *
 * A claim says "these rows are billed", not "at this many hours", so correcting a billed shift is
 * allowed (a typo is a typo, and refusing would block every honest correction). What is not allowed
 * is saying nothing: the invoice goes on billing the old figure, and the office has to be told.
 */
export function billedPartMoved(holder: ClaimHolder | undefined, before: number, after: number): string {
  return `${invoiceLabel(holder)} bills ${fmtHours(before)} of this shift and that part now reads ${fmtHours(after)}. The invoice keeps its figure; adjust it by hand if the customer should pay for the difference.`;
}

/** The sentence for a job move on a claimed shift: one place, so every door says the same thing. */
export function claimedMoveRefusal(holder: ClaimHolder): string {
  return `${invoiceLabel(holder)} already bills this shift — void or adjust that invoice before moving its hours to another job. Nothing was changed.`;
}
