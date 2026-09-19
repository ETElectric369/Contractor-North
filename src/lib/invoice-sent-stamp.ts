import "server-only";
import { dbError } from "@/lib/db-error";

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
  return { ok: true };
}

/** Postgres 42703 and PostgREST's schema-cache miss — the one error shape a not-yet-applied
 *  0267 produces, and nothing else, so a real failure still surfaces as itself. */
function isMissingSentAt(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42703" || code === "PGRST204" || (msg.includes("sent_at") && /does not exist|could not find/i.test(msg));
}
