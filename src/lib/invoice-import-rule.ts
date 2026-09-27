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

/**
 * ON A TIME & MATERIAL JOB THE ESTIMATE IS A GUIDE, NEVER THE CONTRACT (Erik, 2026-09-26, Tao
 * Zhu J-002: "i dont see a running total anywhere on tao's job page"). Tao's job is T&M with an
 * accepted $17,325 estimate, a deposit and progress draws; his bills are the hours and receipts,
 * and the estimate is only what he was told to expect. A fixed-price job's live estimate IS the
 * contract (a declined or expired one is not). Every door that asks "is the quote the bill?" asks
 * here: createInvoiceForJob (copy the quote or pull the actuals), the Overview card and the portal.
 */
export function estimateIsTheContract(
  billingType: string | null | undefined,
  hasLiveQuote: boolean,
): boolean {
  return hasLiveQuote && billingType !== "tm";
}

/**
 * DOES THIS JOB BILL ITS ACTUALS? The rule behind the job page's UnbilledCard, shared so the
 * customer portal shows "work not on a bill yet" on exactly the jobs the office sees it on.
 *
 * EVERY Time & Material job does, estimate or not (estimateIsTheContract): its next bill is the
 * hours and receipts no bill holds yet, priced the way that bill will price them. A job on a
 * payment schedule is billed by its milestones, and a fixed-price job by its contract; there "not
 * billed yet" would be every hour ever worked, which nobody will be billed for.
 */
export function jobBillsItsActuals(
  billingType: string | null | undefined,
  milestoneCount: number,
): boolean {
  return billingType === "tm" && milestoneCount === 0;
}

/** A quote that still stands: not declined, not expired (the customer said no, or it lapsed).
 *  createInvoiceForJob's own test for which quote could be the contract. */
export function isLiveQuote(status: string | null | undefined): boolean {
  return status !== "declined" && status !== "expired";
}

/**
 * DOES THE NEXT NEW INVOICE PULL THE JOB'S HOURS AND RECEIPTS? createInvoiceForJob's own rule: no
 * payment schedule, and no estimate that is the contract. Wider than jobBillsItsActuals: a
 * fixed-price job with no live estimate (J-010 Purple Sage, INV-00023) is billed from its actuals
 * too, so a charge made there by hand has to be recordable, or New Invoice bills it again.
 */
export function nextInvoiceImportsActuals(
  billingType: string | null | undefined,
  milestoneCount: number,
  hasLiveQuote: boolean,
): boolean {
  return milestoneCount === 0 && !estimateIsTheContract(billingType, hasLiveQuote);
}
