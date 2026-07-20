/**
 * THE contract-vs-actuals rule for pre-filling a job's invoice.
 *
 * A job with an accepted estimate is billed by its CONTRACT: createInvoiceFromQuote
 * copies every quote line onto the invoice. Importing the logged labor + materials on
 * top of that bills the same work TWICE — the audit case (2026-07-20) was a $20,000
 * quote + 64 logged hours + a $6,000 PO shipping a $35,500 draft on a signed $20k
 * contract, reachable from three no-opts entry points and Nort's finish verb.
 *
 * So: unspecified means "decide by the contract" (quote → no import, T&M → import),
 * while an EXPLICIT true still wins for the deliberate T&M-on-top-of-a-quote case
 * (FinishJobButton's toggles) and an explicit false always suppresses.
 */
export function shouldImportActuals(
  fromQuote: boolean,
  flag: boolean | undefined,
): boolean {
  if (flag === true) return true;   // caller deliberately asked for actuals
  if (flag === false) return false; // caller deliberately declined
  return !fromQuote;                // unspecified: the contract decides
}
