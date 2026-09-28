import "server-only";
import { dbError } from "@/lib/db-error";
import { defaultDueDateIsoForOrg } from "@/lib/invoice-due";
import { reportError } from "@/lib/observe";

/**
 * THE SEND STAMP — ONE WRITE PATH, BECAUSE "SENT" HAS TO MEAN THE DEED (INV-069, 2026-09-18).
 *
 * `invoices.status = 'sent'` was carrying two different meanings at once. One is true: the bill
 * went to the customer by email, by text, or by the share link being handed over. The other was
 * an accident of plumbing — Pay Now promoted a DRAFT to 'sent' the moment it built the card door,
 * before any card was tapped. Erik hit it on a $6,412 invoice he was still building:
 *
 *   "its not sent its in draft mode thats partially why this is confusing"
 *
 * Migration 0267 gave the row somewhere honest to record the deed, and its comment is the law
 * this function exists to keep: a pay door never stamps sent_at. So the stamp does not live at
 * every `update({ status: "sent" })` — it lives HERE, and only the doors that really put the bill
 * in the customer's hands call it. If you are adding a new caller, the question to answer first is
 * "did a person outside this office just receive this bill?" — not "did the status need to move?".
 *
 * It is also the place the silent-write law is kept for that write (a zero-row UPDATE is a 204,
 * not a success): every caller learns whether the row actually moved, because a screen that says
 * "sent" over a database row that still says draft is the whole shape of this incident.
 */
export async function markInvoiceSent(
  supabase: { from: (t: string) => any },
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  // Was this bill ever in the customer's hands before? Read BEFORE the status write, because the
  // write moves sent_at to now. A draft that already carries a sent_at went out once, came Back To
  // Draft (which keeps the stamp) and is going out again: that is not the FIRST send, and its due
  // date is the one the customer has been holding since, so the restamp below stands down. A read
  // that fails says nothing either way, and the date stays - the safe side of a best-effort write.
  const before = await supabase.from("invoices").select("sent_at").eq("id", id).maybeSingle();
  const firstSend = !before?.error && !!before?.data && (before.data as { sent_at?: string | null }).sent_at == null;
  const patch = { status: "sent", sent_at: new Date().toISOString() };
  let res = await supabase.from("invoices").update(patch).eq("id", id).select("id");
  // A push deploys before its migration runs (cn-v576 lesson): a write naming a column that isn't
  // there yet fails the WHOLE statement, which would turn a few minutes of deploy window into
  // "your invoice won't send". 0267 is applied, so this is belt and braces — but the fallback
  // still moves the status, and an unstamped send is recoverable where a refused send is not.
  if (res.error && isMissingSentAt(res.error)) {
    res = await supabase.from("invoices").update({ status: "sent" }).eq("id", id).select("id");
  }
  if (res.error) return { ok: false, error: dbError(res.error) };
  if (!res.data?.length) return { ok: false, error: "Invoice not found." };
  // The status write has landed: the send IS done. Anything after this line is a second write that
  // may fail on its own without taking the send back with it.
  if (firstSend) await restampDueOnFirstSend(supabase, id);
  return { ok: true };
}

/**
 * THE FIRST SEND STARTS THE CLOCK (W1-27). A draft's due date was stamped the day the draft was
 * made (today + the company's terms), so a draft that sat for three weeks went out already three
 * weeks into its Net 30 - or overdue on arrival. The terms run from the day the customer has the
 * bill. So the first send (this function; a re-send goes through markInvoiceResent and never moves
 * the date) restamps the due date to send day + the terms (Settings › Documents, Net 30 when unset)
 * - unless a person picked the date by hand (0366's invoices.due_date_by_hand, set by
 * setInvoiceDueDate), which is theirs and stays.
 *
 * A SECOND WRITE, BEST EFFORT, AFTER THE STATUS WRITE HAS LANDED - never folded into the status
 * patch: the send is the deed, and a date that can't be moved must never fail it. The guard is in
 * the WHERE (`due_date_by_hand = false`), so a date picked a moment ago is never overwritten, and
 * .select("id") says whether a row moved (a zero-row UPDATE is a 204). Before 0366 the column isn't
 * there: the guard fails as a missing column (42703 / PGRST204) and the date stays exactly as it
 * was, which is today's behaviour. After 0366 an invoice that existed before it reads
 * due_date_by_hand = true (0366 adds the column true on every existing row: nothing recorded a typed
 * date before), so its date stays too; only drafts made after 0366 are restamped. Any other
 * failure is reported and the date stays. Scoped to the invoice's own org (the recurring cron sends
 * on a service client, which has no boundary but the one typed here). The callers recalc (and so drop the stored PDF) after this, so the PDF and the
 * customer's page read the stamped row.
 *
 * Exported for the one first-send door that doesn't go through markInvoiceSent: setInvoiceStatus's
 * "Mark Sent - I Sent It Myself" on a draft that never went out. It is the same deed (the customer
 * has the bill from today), and the draft page promised "Due N days after you send it" for it too.
 * Every caller decides "first" the same way: the row was a draft with no sent_at before this send.
 */
export async function restampDueOnFirstSend(supabase: { from: (t: string) => any }, id: string): Promise<void> {
  try {
    const { data: row, error: readErr } = await supabase.from("invoices").select("org_id").eq("id", id).maybeSingle();
    const orgId = (row as { org_id?: string | null } | null)?.org_id ?? null;
    if (readErr || !orgId) {
      if (readErr) reportError("markInvoiceSent.restampRead", readErr, { invoiceId: id });
      return;
    }
    const due = await defaultDueDateIsoForOrg(supabase, orgId);
    const { error } = await supabase
      .from("invoices")
      .update({ due_date: due })
      .eq("id", id)
      .eq("org_id", orgId)
      .eq("due_date_by_hand", false)
      .select("id");
    if (error && !isMissingColumn(error, "due_date_by_hand")) reportError("markInvoiceSent.restampDue", error, { invoiceId: id });
  } catch (e) {
    reportError("markInvoiceSent.restampDue", e, { invoiceId: id });
  }
}

/**
 * THE SAME BILL, SENT AGAIN — and this time the status must NOT move (0269, 2026-09-18).
 *
 * Once a delivered invoice could be revised, every delivery door grew a second job: a bill that
 * was edited after it went out leaves `revised_at > sent_at` standing, which the invoice page
 * says out loud as "the customer is holding an older copy". Only a real re-delivery settles that,
 * by moving `sent_at` forward — which is why 0269 does not clear `revised_at`: the fact that a
 * revision happened is worth keeping, and the comparison is what answers the question.
 *
 * It cannot go through markInvoiceSent, and the reason is a money bug that would have been very
 * quiet. That function writes `status = 'sent'`, which is exactly right for the draft it was
 * written for and exactly WRONG here: texting a customer a copy of an invoice they have already
 * paid would demote 'paid' to 'sent', putting a settled bill back on the AR list and chasing
 * someone for money they have already handed over. A re-send is a delivery, not a status change.
 * So this writes the one column that records the deed and touches nothing else.
 *
 * Checked, like its twin: a zero-row UPDATE is a 204, and an office told "re-sent" over a row
 * that still says the customer holds an older copy is the shape of every incident in this file.
 */
export async function markInvoiceResent(
  supabase: { from: (t: string) => any },
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await supabase
    .from("invoices")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  // Mid-deploy there is no column to stamp, so there is nothing to fail: the bill still went out,
  // and a send reported as broken because of a missing column would be a lie about the deed.
  if (res.error) return isMissingSentAt(res.error) ? { ok: true } : { ok: false, error: dbError(res.error) };
  if (!res.data?.length) return { ok: false, error: "Invoice not found." };
  return { ok: true };
}

/** Postgres 42703 and PostgREST's schema-cache miss — the one error shape a not-yet-applied
 *  0267 produces, and nothing else, so a real failure still surfaces as itself. */
function isMissingSentAt(err: unknown): boolean {
  return isMissingColumn(err, "sent_at");
}

/** The same shape for any column a migration adds (0366's due_date_by_hand for the restamp). */
function isMissingColumn(err: unknown, column: string): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42703" || code === "PGRST204" || (msg.includes(column) && /does not exist|could not find/i.test(msg));
}
