/**
 * WHAT A SETTLED CARD PAYMENT DOES TO THE INVOICE: IT SETTLES. NOTHING ELSE.
 *
 * ── THE HISTORY ──────────────────────────────────────────────────────────────────────────────
 * INV-069 (2026-09-18): Pay Now promoted a draft to 'sent' the instant it built the card door,
 * before any card was tapped. Erik opened the sheet on a $6,412.64 invoice he was still building
 * and the bill was sent for good: "its not sent its in draft mode thats partially why this is
 * confusing". cn-v961 moved that promotion here, to the webhook, "at the money" - which was the
 * same silent send one step later: a tap on Andrew's INV-078 would have charged its whole balance
 * and flipped the running draft to 'sent', with no send date, by nobody.
 *
 * ── THE RULE NOW (Connected North Phase 1, "Stop the silent money") ──────────────────────────
 * A draft becomes a bill when a PERSON sends it. Every pay door asks first ("Send INV-078 as the
 * bill first?") and sends it properly on the yes, before any money can move (lib/pay-door-send).
 * So the webhook and the settlement never write a status and never stamp sent_at: they record the
 * payment and recalc. A draft that still reaches them - a PaymentIntent minted before this rule
 * shipped, a bill put back to Draft under an open sheet - is settled exactly like a cash deposit
 * recorded on a draft (the money lands, the draft stays a draft: paidStatus never advances one,
 * Erik 7/24) and logged as an error_events row, so a person looks at it.
 */

/** True when card money landed on a DRAFT - settled, never promoted, and logged for a person. */
export function paymentReachedDraft(currentStatus: string | null | undefined): boolean {
  return String(currentStatus ?? "") === "draft";
}
