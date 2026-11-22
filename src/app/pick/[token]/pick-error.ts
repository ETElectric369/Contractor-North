/**
 * WHAT THE CUSTOMER READS WHEN A TAP ON A TIME IS REFUSED (cn-v1180).
 *
 * The database answers a tap on a link that is no longer pending with "This link was already used".
 * That is true of a link somebody already picked from, and UNTRUE of one the office withdrew (the lead
 * was booked another way, or ended) after this page was opened: the customer used nothing. A page
 * opened AFTER the withdrawal already says it was withdrawn; this is the page opened before. One
 * sentence that is true of both, and that names the one thing to do. English literal: a customer
 * reads it, and no public entry reads the catalogs.
 */
export const PICK_LINK_CLOSED = "This link is no longer open \u2014 give us a call.";

export function pickErrorSaid(message: string | null | undefined): string {
  const said = String(message ?? "").trim();
  if (!said) return "Something went wrong \u2014 try again.";
  if (/already used/i.test(said)) return PICK_LINK_CLOSED;
  return said;
}
