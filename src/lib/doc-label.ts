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
