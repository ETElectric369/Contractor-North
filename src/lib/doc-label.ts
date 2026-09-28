/** THE one derivation of the customer-facing document word for a priced document.
 *  quotes.doc_type is the SSOT — 'estimate' (T&M, the default) or 'quote' (fixed
 *  price) — and drives the print/PDF title, the public /q heading + accept copy,
 *  and email/SMS subject + body lines. Internal app nav stays "Estimates".
 *  A missing/unknown value falls back to "Quote", byte-identical to the historical
 *  inline `(doc_type ?? "quote") === "estimate"` expression on every surface. */

export type QuoteDocType = "estimate" | "quote";

export function docLabel(
  q: { doc_type?: string | null } | null | undefined,
): "Estimate" | "Quote" {
  return (q?.doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";
}

/** THE FIXED CHIP (W1-25): the office's lists mark a FIXED-PRICE row with a small "Fixed" pill and
 *  leave a Time & Material row bare (the old "Est" / "Quote" pill told them apart with two words
 *  where one mark does). STRICT, on purpose, unlike docLabel's customer-facing fallback: only a row
 *  that says doc_type = 'quote' wears the pill, so a row read without the column (or with an
 *  unknown value) is never called fixed-price on a guess. Office words only; docLabel keeps every
 *  customer-facing word. */
export function isFixedPrice(q: { doc_type?: string | null } | null | undefined): boolean {
  return q?.doc_type === "quote";
}

/** The pill's one look, shared by every list that draws it. */
export const FIXED_PILL_CLASS =
  "ml-2 align-middle rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500";
