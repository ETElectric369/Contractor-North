/**
 * WHICH OF A CUSTOMER'S OWN PAPERS THEY ARE ALLOWED TO OPEN. ONE RULE, ONE PLACE (W3).
 *
 * A customer holds a link, and the link is the credential. What the link may open is this list and
 * nothing else: a bill that was SENT, and from then on whatever it became (part-paid, paid, past
 * due). A draft, a held bill or a voided one never opens — not on their job page, not through /i,
 * not as a stored PDF. Quotes the same way, from the day one was sent.
 *
 * The app wrote this list three times: the /i door's own gate, the stored-PDF door's, and the
 * portal job page's Pay-button set. All three agreed, and all three failed closed, so the
 * duplication was never a leak — the damage was a DEAD DOOR. Add a status to one of them and the
 * customer gets a Pay button, or a Download button, that the other two refuse: a tap that lands on
 * "Not found." Take one away and a bill the database still hands over arrives with its document
 * unreadable, which the page can only show as "couldn't load", forever.
 *
 * THE DATABASE KEEPS ITS OWN COPIES AND MUST. public_invoice, public_quote, customer_portal and
 * portal_job_view are security-definer functions reached by an anonymous caller with a token; the
 * gate has to be inside them, where no app code sits in front of it. They are not merged with this
 * file — they are PINNED to it by src/lib/customer-visible-docs.test.ts, which reads the live
 * migration bodies and fails the moment either side moves alone.
 *
 * Contracts have a customer-visible gate too ('sent', 'signed'), but it lives only in the database:
 * no app read narrows contracts by status, so there is no app-side copy to collapse. When one is
 * written it belongs here, as another key of CUSTOMER_VISIBLE_STATUSES.
 */

/**
 * A kind of paper a customer can be handed a link to. Adding a kind does not compile until
 * CUSTOMER_VISIBLE_STATUSES says which of its statuses a customer may open — the list cannot be
 * forgotten at one door, because there is only one door.
 */
export type CustomerDoc = "invoice" | "quote";

/** The only statuses a customer may open, per kind of paper. Exhaustive by type. */
export const CUSTOMER_VISIBLE_STATUSES: Record<CustomerDoc, readonly string[]> = {
  invoice: ["sent", "partial", "paid", "overdue"],
  quote: ["sent", "accepted", "declined", "expired"],
};

/**
 * May a customer open this paper? Fails closed: a missing status, a null, or anything that is not
 * one of the words above is a no. Every door asks this rather than keeping a set of its own.
 */
export function customerMayOpen(doc: CustomerDoc, status: unknown): boolean {
  return typeof status === "string" && CUSTOMER_VISIBLE_STATUSES[doc].includes(status);
}
