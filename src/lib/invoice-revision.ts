import "server-only";
import { reportError } from "@/lib/observe";
import { invoiceBalance, invoiceOverpayment } from "@/lib/invoice-math";

/**
 * A BILL GETS REVISED. THAT IS THE JOB — the lock comes off and the record goes on
 * (Erik, 2026-09-18, the night after INV-069; migration 0269).
 *
 * ── WHAT WE REFUSED, AND WHY IT WAS WRONG ────────────────────────────────────────────────────
 * cn-v961 taught the row what "sent" means (0267: `sent_at`, stamped only by a real delivery and
 * never by a pay door). It still refused to let a delivered invoice be edited at all — every line
 * mutation in billing/actions.ts ran through a draft-only gate. Erik answered that directly:
 *
 *   "even if i did sent it ill always need to be able to go back and make changes as per a
 *    client's request or my own review catches errors"
 *
 * The same night proved it twice. A client emailed asking that a PAID invoice be in the property
 * owner's name rather than the agent's, months after the money landed - an ordinary request that
 * costs nobody anything. And the invoice that started the whole wave had Erik's own Smartwater
 * billed to the customer, which he caught on his own review. Contractors revise bills. An app
 * that forbids it is not protecting the customer, it is just making the contractor fight it -
 * and a refusal with no way through is a dead end wearing a helpful voice.
 *
 * ── WHAT THE REFUSAL WAS REALLY GUARDING ─────────────────────────────────────────────────────
 * Something narrower than it was written: a bill changing without the customer ever learning it
 * changed. That does not need a lock. It needs a RECORD. So:
 *
 *     revised_at > sent_at   ->   the customer is holding an older bill than this one.
 *
 * NULL is the normal state. A draft is never stamped - editing a draft is building it, which is
 * what a draft is for. Re-sending does not clear the stamp; `sent_at` moves forward instead
 * (invoice-sent-stamp.ts), which makes the comparison false again while keeping the fact that a
 * revision happened.
 *
 * ── WHY THE DECISION LIVES HERE AND NOT AT NINE CALL SITES ───────────────────────────────────
 * Nine line-level writes can change the money on an invoice (add, edit, delete, reorder, the tax
 * rate, and the four importers). A rule copied into nine places is a rule that will be right in
 * eight of them by Christmas - which is exactly what happened to the draft gate it replaces (the
 * tax dropdown was missed for months, audit 8; addInvoiceItem still carried its own inline copy).
 * markInvoiceSent made the send stamp one write path for the same reason. This is its twin.
 *
 * ── THE NOTICE NARROWS TO THE MONEY (Erik, 2026-11-07; migration 0405) ─────────────────────────
 * Since 0269 the record said "the customer is holding an older bill" whenever revised_at passed
 * sent_at. Erik had been reading that for weeks before he said why it was mostly wrong:
 *
 *   "ive noticed this for a while now and think we should remove this notification to 'send again'
 *    becuase and i actually like this feature a lot, any change i make after its been sent reflects
 *    on the link already sent so its mostly unnecessary to send it again unless they've paid and
 *    something changes and a difference remains"
 *
 * He is right about the link: the /i page and its PDF render the bill as it is NOW, so nobody is
 * ever reading an older DOCUMENT. What can go stale is the FIGURE the customer acted on. So the
 * record splits into two questions, each with one home here:
 *   - changedSinceSent: did the bill change after it last went out? The RECORD question, asked by
 *     the doors that re-stamp a delivery (hasUnsentRevision: the share sheet, the hand "Sent").
 *   - customerHoldsOlderCopy: should the office be TOLD to send it again? Only when the customer
 *     has paid something, the money on the bill moved since the send (0405's sent_total, which a
 *     trigger records on every write of sent_at, is the figure the send carried), and a difference
 *     remains. A wording change, an unpaid bill, a squared-up bill: nothing to say.
 *     THE ORDER OF EVENTS COUNTS (skeptic #56, 2026-11-07): "unless they've PAID and something
 *     changes" - paid first. A payment that landed AFTER the change was made against the live link,
 *     which already showed the new figure, so it is not a payment on an older one; the payments' own
 *     dates, against revised_at, say which came first.
 */

/** The statuses whose lines may still be edited. Everything except the one ending. */
export function invoiceLineEditRefusal(status: string | null | undefined): string | null {
  // VOID IS AN ENDING, NOT A BILL. Voiding releases every claim the invoice's lines hold (0255:
  // the claim dies with the invoice), so editing a void invoice's lines would move hours and
  // materials that another live invoice may already bill - the double this app exists to prevent.
  // Draft, sent, partial, paid and overdue are all LIVE bills and all editable: paid is not a
  // special case, it is the exact case Erik's client wrote in about.
  //
  // The sentence names the two doors that actually exist, both one tap from where it appears:
  // the status picker on this page brings it back, and New Invoice bills the work fresh.
  if (String(status ?? "") === "void") {
    return "This invoice is void, so it isn't a bill any more and its lines can't change. If you voided it by mistake, set its status back from the picker above; to bill this work, start a new invoice.";
  }
  return null;
}

/**
 * Does a money change on this invoice need to go on the record?
 *
 * READ DELIVERY, NEVER STATUS. `status = 'sent'` can be manufactured - a pay door promoted
 * INV-069 to 'sent' before a card was ever tapped, which is the whole reason 0267 exists. An
 * invoice promoted that way never reached anybody, so editing it is still just building it and
 * a "the customer holds an older copy" banner over it would be a lie the office cannot clear.
 * `sent_at` is only ever written where a bill actually left the building.
 */
export function shouldStampRevision(sentAt: string | null | undefined): boolean {
  return typeof sentAt === "string" && sentAt.trim() !== "";
}

/** The money facts the notice rule reads. Off the invoice's own row: its total, what has been paid
 *  on it, and 0405's `sent_total` (the total at the last send; null = sent before 0405, or never
 *  sent: a figure nobody recorded). Off its payments: WHEN each landed (`paid_at`, every payment on
 *  the bill; a voided payment is deleted, not flagged, so the rows that exist are the money that
 *  stands). PostgREST may hand any figure over as a string. The projection law: a page that asks this
 *  question selects payments(paid_at) too (billing/page.tsx, billing/[id]/page.tsx). */
export type MoneyFacts = {
  total: number | null | undefined;
  amountPaid: number | null | undefined;
  sentTotal?: number | null | undefined;
  paidAt: readonly (string | null | undefined)[];
};

/**
 * THE RECORD QUESTION: did the bill change after it last went out? `revised_at` strictly after
 * `sent_at`, and nothing else.
 *
 * Equal instants are NOT a change. A re-send stamps `sent_at` at the instant the office is looking
 * at, and a comparison of `>=` would nag forever about the copy it had just sent. A missing or
 * unparseable stamp is not a change either: never delivered (a draft, or INV-069's promotion by a
 * pay door) means there is no copy out there to be older, and an alarm has to be earned by two
 * real dates, not by garbage sorting oddly as a string.
 */
export function changedSinceSent(sentAt: string | null | undefined, revisedAt: string | null | undefined): boolean {
  if (!sentAt || !revisedAt) return false;
  const sent = Date.parse(sentAt);
  const revised = Date.parse(revisedAt);
  if (Number.isNaN(sent) || Number.isNaN(revised)) return false;
  return revised > sent;
}

/** A money figure in whole cents, or NaN when nothing finite was recorded. */
function cents(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/**
 * THE QUESTION THE PAGE ASKS OUT LOUD: should the office be told to send this bill again?
 *
 * Until 2026-11-07 this was the record question with one exception (a bill paid in full after the
 * change: the customer paid the live figure, so they had the current one). Erik narrowed it to
 * the money: the link they hold is live, so what they are reading is never stale; only the figure
 * they paid against can be. Every step below is a reason NOT to interrupt him, in order:
 *
 *   (a) not changed since it went out: never delivered, or the copy they hold is the current one
 *       (a re-send moves sent_at forward, which is how doing what the notice asks clears it);
 *   (b) nothing paid BEFORE the change: "any change i make after its been sent reflects on the link
 *       already sent so its mostly unnecessary to send it again unless they've paid and something
 *       changes" (Erik, 2026-11-07) - paid, THEN changed. A figure nobody has acted on cannot be
 *       stale for anybody, and a payment that landed AFTER the change was made against the live
 *       link, which already showed the new figure (skeptic #56: the money changes on an unpaid
 *       bill, the customer then pays part of it through the link - no notice). The payments' dates
 *       against revised_at decide (paidBefore below); a date that cannot be read counts as before;
 *   (c) squared up, to the cent: no balance and no overpayment, so no difference remains. This
 *       subsumes the old paid-in-full-AFTER-the-change clause, and drops its "after" half on
 *       purpose: a bill paid in full BEFORE a later change leaves no money difference either, and
 *       Erik does not want to be asked to re-send it (the live link already says what it says);
 *   (d) the money did not move since the send: 0405's sent_total, the total the send carried,
 *       equals the total now, so the change was wording (a title, the scope, a due date: cn-v967
 *       stamps those too) and the figure they paid against still stands. A payment never changes
 *       total, so a payment alone never fails this step;
 *   (e) otherwise: they paid against a figure that has since moved, and money is still owed one
 *       way or the other. Say so, and offer Send Again.
 *
 * WHEN sent_total IS NULL the bill went out before 0405 (or the figure was never recorded), so (d)
 * cannot be answered and is skipped: the notice stands on (a)-(c) alone. The app does not pretend
 * to know a figure nobody wrote down; a notice too many beats a guess (the no-speculation law).
 */
export function customerHoldsOlderCopy(
  sentAt: string | null | undefined,
  revisedAt: string | null | undefined,
  facts: MoneyFacts,
): boolean {
  // (a) the record question first: nothing changed since the send, nothing to say.
  if (!changedSinceSent(sentAt, revisedAt)) return false;
  // (b) nothing paid (or nothing recorded as paid): the live link says it all...
  if (!(cents(facts.amountPaid) > 0)) return false;
  //     ...and paid BEFORE the change, by the payments' own dates ((a) proved revisedAt parses).
  if (!paidBefore(facts.paidAt, Date.parse(String(revisedAt)))) return false;
  // (c) squared up to the cent: no difference remains, whichever way it once leaned.
  if (invoiceBalance(facts.total, facts.amountPaid) === 0 && invoiceOverpayment(facts.total, facts.amountPaid) === 0) return false;
  // (d) the figure the send carried is the figure now: a wording change, not a money change.
  const sentCents = cents(facts.sentTotal);
  if (facts.sentTotal != null && Number.isFinite(sentCents) && sentCents === cents(facts.total)) return false;
  // (e) paid against a figure that has since moved, with a difference still standing.
  return true;
}

/**
 * Did at least one payment land BEFORE the change - strictly before revised_at? A payment at the same
 * instant is not before it (the change is what it saw). A payment with no readable date counts as
 * before, and so does money paid with NO payment dates handed over at all: both mean "we cannot tell",
 * and on a bill the customer paid against, not knowing resolves towards saying so - a notice too many
 * beats a guess (the no-speculation law). payments.paid_at is NOT NULL (0003), so either is a
 * projection miss (a caller that did not select payments(paid_at)), never a real row.
 */
function paidBefore(paidAt: readonly (string | null | undefined)[], revised: number): boolean {
  if (paidAt.length === 0) return true;
  return paidAt.some((p) => {
    const t = Date.parse(String(p ?? ""));
    return Number.isNaN(t) || t < revised;
  });
}

/**
 * Put a money change on the record, after the write that made it has already landed.
 *
 * THE EDIT STANDS EVEN IF THIS DOESN'T. The caller has already changed the invoice and is about
 * to tell the user so. Rolling that back because a second write missed would be the worse
 * failure by far - it would take away a change the user made and watched succeed. So this never
 * returns an error to the caller and never throws: a failure goes to the ops log, where the daily
 * triage reads it, rather than into the user's face on an edit that worked.
 *
 * Silent-write law all the same: a zero-row UPDATE is a 204, not a success, so the write is
 * checked and a miss is reported as a miss.
 */
export async function stampInvoiceRevised(
  supabase: { from: (t: string) => any },
  invoiceId: string,
  where: string,
): Promise<void> {
  try {
    const { data: inv, error: readErr } = await supabase
      .from("invoices")
      .select("sent_at")
      .eq("id", invoiceId)
      .maybeSingle();
    if (readErr) {
      // A push deploys before its migration runs (cn-v576): a select naming a column that isn't
      // there yet fails the whole read. 0267 is applied, so this is belt and braces - and an
      // un-recorded revision for those few minutes beats a failed edit.
      if (!isMissingDeliveryColumn(readErr)) reportError(`${where}.revisionStamp.read`, readErr, { invoiceId });
      return;
    }
    if (!inv) return; // the edit landed but the row isn't readable here - the caller already said so
    if (!shouldStampRevision((inv as { sent_at?: string | null }).sent_at)) return; // never delivered: nothing to record

    const { data: wrote, error } = await supabase
      .from("invoices")
      .update({ revised_at: new Date().toISOString() })
      .eq("id", invoiceId)
      .select("id");
    if (error) {
      if (!isMissingDeliveryColumn(error)) reportError(`${where}.revisionStamp`, error, { invoiceId });
      return;
    }
    if (!wrote?.length) {
      reportError(`${where}.revisionStamp`, new Error("the revision stamp did not land on any row"), { invoiceId });
    }
  } catch (e) {
    reportError(`${where}.revisionStamp`, e, { invoiceId });
  }
}

/**
 * Has this invoice changed since the customer last got it? THE RECORD QUESTION (changedSinceSent)
 * read off the row, for the doors that re-stamp a delivery: the share sheet (which asks before it
 * records a re-send) and the hand "Sent - I Sent It Myself" (which moves sent_at only for one).
 *
 * Until 2026-11-07 this gave the NOTICE's answer, so that Share never asked to re-send a bill the
 * page no longer flagged. The notice is narrower now (money only, customerHoldsOlderCopy) and these
 * two doors want the record instead: re-sharing or re-handing a changed bill IS a delivery of the
 * current one, whatever the notice says, so sent_at should move and 0405's trigger should record
 * the figure it carried. After that re-stamp revised_at <= sent_at and this reads false again.
 *
 * False on anything it cannot read. A false negative costs one more tap; a false positive asks the
 * office to re-send a bill that never changed, which is how a nag becomes noise nobody reads.
 */
export async function hasUnsentRevision(
  supabase: { from: (t: string) => any },
  invoiceId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("invoices")
      .select("status, sent_at, revised_at")
      .eq("id", invoiceId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { status?: string | null; sent_at?: string | null; revised_at?: string | null };
    // A VOID invoice is never "waiting to be re-sent". Its lines are refused, so its stamp can
    // only be older than the void itself, and its customer link does not even open - asking the
    // office to re-send a cancelled bill would be a nag with nothing behind it.
    if (String(row.status ?? "") === "void") return false;
    return changedSinceSent(row.sent_at, row.revised_at);
  } catch {
    return false;
  }
}

/** Postgres 42703 and PostgREST's schema-cache miss for 0267/0269's columns - the one error shape
 *  a not-yet-applied migration produces, and nothing else, so a real failure still logs as itself. */
function isMissingDeliveryColumn(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return (
    code === "42703" ||
    code === "PGRST204" ||
    ((msg.includes("revised_at") || msg.includes("sent_at")) && /does not exist|could not find/i.test(msg))
  );
}
