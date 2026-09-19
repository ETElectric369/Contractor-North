/**
 * WHAT A SETTLED CARD PAYMENT DOES TO A DRAFT — the pure half of the INV-069 fix (2026-09-18).
 *
 * ── THE INCIDENT ─────────────────────────────────────────────────────────────────────────────
 * Pay Now used to promote a draft invoice to 'sent' the instant it built the card door, inside
 * createTapPaymentIntent, before any card was tapped. Erik pressed it on INV-069 ($6,412.64, 46
 * lines) while he was still building the bill. No card was ever presented, and the invoice was
 * promoted for good:
 *
 *     "its not sent its in draft mode thats partially why this is confusing"
 *
 * The write called neither recalcInvoice nor a revalidate, so the row landed on 'sent' with a $200
 * cash deposit on it — the one row in the whole invoices table whose stored status disagreed with
 * paidStatus(), which calls that shape 'partial' — while his open page kept its draft props and
 * went on showing a Draft badge and live draft controls over a database that had locked the lines.
 * Then the trap closed: setInvoiceStatus refuses a return to Draft on an invoice carrying money,
 * so his own deposit became the lock on his own work.
 *
 * ── THE RULE THAT REPLACED IT ────────────────────────────────────────────────────────────────
 * A Tap to Pay charge is a card_present PaymentIntent taken across the counter on the tenant's own
 * connected account. It hands the customer no link, no email and no bill — nothing about opening
 * that door puts anything in front of anybody — so a draft is a perfectly payable thing over it,
 * and the door opening changes nothing on the row.
 *
 * The status moves when the MONEY LANDS, and it has to move then, because paidStatus()
 * deliberately never advances a draft (invoice-math.ts, Erik 7/24: a deposit recorded on a draft
 * must not silently lock its lines). A paid draft left on 'draft' would sit with money on it
 * forever — the same screen-versus-database disagreement as the incident, pointing the other way.
 *
 * WHAT IT MUST NOT DO: stamp sent_at (migration 0267). 'sent' here is the pay door's deed, not a
 * delivery — nothing left the building — and sent_at is precisely what the demotion guard reads to
 * decide whether the way back to Draft is barred. Stamping it on a counter payment would re-forge
 * the lock this whole wave exists to break.
 */

/**
 * The status a settled payment must write on the invoice BEFORE the recalc, or null when the row
 * is already where it belongs and nothing should be written.
 *
 * `doorPromotesDraft` is the paying door's own answer to "is this door allowed to move a draft?".
 * Only a door that collects money without delivering a bill says yes — today that is Tap to Pay on
 * iPhone. The public link door (a QR scanned, a pay URL texted) has already put the bill in front
 * of the customer when it was built, and its promotion belongs there, at the delivery, not here.
 *
 * 'void' falls through to null with everything else that is not a draft: money arriving on a
 * voided invoice is a thing for a person to look at, never a thing to quietly un-void — that is
 * the 0259 boundary, and a webhook must not walk around it.
 */
export function draftPromotionOnPayment(
  currentStatus: string | null | undefined,
  doorPromotesDraft: boolean,
): "sent" | null {
  if (!doorPromotesDraft) return null;
  return String(currentStatus ?? "") === "draft" ? "sent" : null;
}
