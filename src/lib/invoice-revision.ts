import "server-only";
import { reportError } from "@/lib/observe";

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

/**
 * THE QUESTION THE PAGE ASKS OUT LOUD: is what the customer is holding older than this?
 *
 * Equal timestamps are NOT a revision. A re-send stamps `sent_at` at the same instant the office
 * is looking at, and a stamp that compared `>=` would nag forever about the copy it had just sent.
 */
export function customerHoldsOlderCopy(
  sentAt: string | null | undefined,
  revisedAt: string | null | undefined,
): boolean {
  if (!sentAt || !revisedAt) return false;
  const sent = Date.parse(sentAt);
  const revised = Date.parse(revisedAt);
  if (Number.isNaN(sent) || Number.isNaN(revised)) return false;
  return revised > sent;
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
 * Has this invoice changed since the customer last got it? Asked by the doors that can SETTLE it
 * - the share sheet (which asks before it re-sends) and the manual "Sent - I sent it myself".
 *
 * False on anything it cannot read. The consequence of a false negative is a banner that stays up
 * one more tap; the consequence of a false positive is telling the office to re-send a bill that
 * never changed, which is how a nag becomes noise nobody reads.
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
    return customerHoldsOlderCopy(row.sent_at, row.revised_at);
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
