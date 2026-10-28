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

import { fillText, translator, type Lang } from "@/lib/i18n";

/** The invoice that holds a claim on a source row. */
export type ClaimHolder = { id: string; invoice_number: string | null };

/** source row id (a time_entry id) → the non-void invoice that bills it. */
export type ClaimIndex = ReadonlyMap<string, ClaimHolder>;

const invoiceLabel = (h: ClaimHolder | undefined, lang?: Lang | null): string => h?.invoice_number ?? translator(lang)("cs_anInvoice");
const fmtHours = (h: number | null | undefined): string => `${(Math.round((Number(h) || 0) * 100) / 100).toFixed(2)} h`;

/**
 * BILLED HOURS MAY CHANGE, BUT NEVER SILENTLY.
 *
 * A claim says "these rows are billed", not "at this many hours", so correcting a billed shift is
 * allowed (a typo is a typo, and refusing would block every honest correction). What is not allowed
 * is saying nothing: the invoice goes on billing the old figure, and the office has to be told.
 *
 * Every sentence takes the reader's `lang` (cn-v1138, lib/words/clockserver); omitted, it is English.
 */
export function billedPartMoved(holder: ClaimHolder | undefined, before: number, after: number, lang?: Lang | null): string {
  return fillText(translator(lang)("cs_billedPartMoved"), { invoice: invoiceLabel(holder, lang), before: fmtHours(before), after: fmtHours(after) });
}

/** The sentence for a job move on a claimed shift: one place, so every door says the same thing. */
export function claimedMoveRefusal(holder: ClaimHolder, lang?: Lang | null): string {
  return fillText(translator(lang)("cs_claimedMoveRefusal"), { invoice: invoiceLabel(holder, lang) });
}

/**
 * The sentence for handing a claimed shift to someone else (0361's time_entries_billed_person_stays
 * refuses the same thing underneath). The invoice billed these hours as `name`'s, on that person's
 * labor line; moved, that line would claim another person's hours.
 */
export function claimedPersonRefusal(holder: ClaimHolder, name?: string | null, lang?: Lang | null): string {
  const t = translator(lang);
  const whose = name?.trim() ? fillText(t("cs_asPersonsHours"), { name: name.trim() }) : "";
  return fillText(t("cs_claimedPersonRefusal"), { invoice: invoiceLabel(holder, lang), whose });
}
