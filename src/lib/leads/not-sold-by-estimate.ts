/**
 * NOT SOLD BY ITS ESTIMATE (cn-v1172). Erik, 2026-11-19: "if they are Not Sold then the data stays
 * with them in that file for further sales reach out". The Leads page keeps one fold of the people
 * who were not sold. Until now it listed only a lead marked Not Sold by hand, and a lead never is
 * once an estimate was written for it: saving the estimate converts the lead, so when the customer
 * said no to the price, that person was on no list at all.
 *
 * THIS IS A READ, NOT A STAMP. Nothing is written on the lead. The rule reads EVERY estimate of the
 * company, with or without a lead on it, because an estimate does not always carry its lead: a
 * duplicated estimate, or one started from the customer's page, carries none (cn-v1172 fixer).
 *
 *   - A superseded estimate is skipped entirely: the revision that replaced it speaks for it.
 *   - An ENDED estimate (declined, or marked expired) with a lead marks that lead ended.
 *   - Every other estimate is IN PLAY, in any status this rule knows or does not know (draft, sent,
 *     accepted, anything new): it puts its lead in play, if it has one, AND its customer in play, if it
 *     has one. A lead is never called Not Sold on a guess.
 *   - Every estimate that has both a lead and a customer ties that customer to that lead, ended or not.
 *
 * A lead is Not Sold by its estimate when it is ended, is not in play itself, and none of the
 * customers tied to it is in play. So a declined estimate whose customer accepted a copy (a cheaper
 * option duplicated for the same customer) leaves the lead out of the fold, and so does a new draft or
 * sent estimate for that customer. Another customer's estimate changes nothing, and a lead whose
 * estimates name no customer is decided by its own estimates alone.
 *
 * Pure. No catalog (a lib never imports one).
 */

/** An estimate status that is an ending without a sale. */
const ENDED_UNSOLD = new Set(["declined", "expired"]);
/** A status that says nothing about the outcome. */
const SAYS_NOTHING = new Set(["superseded"]);

/** The columns the rule reads of `quotes`: all of the company's estimates, not only those with a lead. */
export const NOT_SOLD_BY_ESTIMATE_COLUMNS = "inquiry_id, status, customer_id";

/** The lead ids that are Not Sold by their estimates, in the order first met. */
export function leadsNotSoldByEstimate(
  quotes: readonly { inquiry_id?: string | null; status?: string | null; customer_id?: string | null }[],
): string[] {
  const ended: string[] = [];
  const seenEnded = new Set<string>();
  const leadInPlay = new Set<string>();
  const customerInPlay = new Set<string>();
  const customersOf = new Map<string, Set<string>>();
  for (const q of quotes) {
    const status = String(q.status ?? "");
    if (SAYS_NOTHING.has(status)) continue;
    const lead = q.inquiry_id ? String(q.inquiry_id) : "";
    const customer = q.customer_id ? String(q.customer_id) : "";
    if (lead && customer) {
      const tied = customersOf.get(lead) ?? new Set<string>();
      tied.add(customer);
      customersOf.set(lead, tied);
    }
    if (ENDED_UNSOLD.has(status)) {
      if (lead && !seenEnded.has(lead)) {
        seenEnded.add(lead);
        ended.push(lead);
      }
    } else {
      if (lead) leadInPlay.add(lead);
      if (customer) customerInPlay.add(customer);
    }
  }
  return ended.filter((lead) => {
    if (leadInPlay.has(lead)) return false;
    for (const c of customersOf.get(lead) ?? []) if (customerInPlay.has(c)) return false;
    return true;
  });
}
