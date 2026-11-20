import type { SupabaseClient } from "@supabase/supabase-js";
import { NOT_SOLD_STATUS, isOpenLead, standingFor } from "./new-intake";

/**
 * A LEAD'S NOT SOLD, BOTH WAYS (cn-v1170), for the two server doors that write it besides the lead's
 * own status: Reopen (leads/actions reopenLead, and a visit's Undo) and a visit that ended Not Sold
 * (appointments/actions setAppointmentOutcome). One copy of each guard, so the doors cannot drift.
 * Every write asks for its row back (the silent-write law). No catalog: the callers say the words.
 */

/** Where a reopened lead goes back to: Contacted when somebody reached them, else New. */
export function reopenedStatus(lastContactedAt: string | null | undefined): "contacted" | "new" {
  return lastContactedAt ? "contacted" : "new";
}

export type ReopenAnswer = { ok: true } | { ok: false; reason: "notNotSold" | "error"; error?: unknown };

/** Put a Not Sold lead back on the list. Only a lead that is Not Sold and not converted, guarded at
 *  the write too, so a lead that moved on meanwhile is never pulled back. */
export async function reopenNotSold(supabase: SupabaseClient, id: string): Promise<ReopenAnswer> {
  const { data: row, error: readErr } = await supabase
    .from("inquiries")
    .select("id, status, converted_at, last_contacted_at")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return { ok: false, reason: "error", error: readErr };
  const lead = row as { status?: string | null; converted_at?: string | null; last_contacted_at?: string | null } | null;
  if (!lead || lead.status !== NOT_SOLD_STATUS || lead.converted_at) return { ok: false, reason: "notNotSold" };
  const { data, error } = await supabase
    .from("inquiries")
    .update({ status: reopenedStatus(lead.last_contacted_at), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", NOT_SOLD_STATUS)
    .is("converted_at", null)
    .select("id");
  if (error) return { ok: false, reason: "error", error };
  if (!data?.length) return { ok: false, reason: "notNotSold" };
  return { ok: true };
}

/**
 * A VISIT ENDED NOT SOLD: its lead is Not Sold too, but only when the lead is open and NO OTHER visit
 * from it still stands (read after the visit's own outcome was written, so that one no longer
 * stands). A lead whose visits could not be read is left open: in doubt, offered, never hidden.
 */
export async function markLeadNotSoldFromVisit(
  supabase: SupabaseClient,
  inquiryId: string,
): Promise<{ marked: boolean; error?: unknown }> {
  const { data: row, error: readErr } = await supabase.from("inquiries").select("id, status, converted_at").eq("id", inquiryId).maybeSingle();
  if (readErr) return { marked: false, error: readErr };
  if (!row || !isOpenLead(row as { status?: string | null; converted_at?: string | null })) return { marked: false };
  const read = await standingFor(supabase, [inquiryId]);
  if (read.unread.has(inquiryId)) return { marked: false, error: new Error("lead visits unread") };
  if (read.standing.has(inquiryId)) return { marked: false };
  const { data, error } = await supabase
    .from("inquiries")
    .update({ status: NOT_SOLD_STATUS, updated_at: new Date().toISOString() })
    .eq("id", inquiryId)
    .neq("status", NOT_SOLD_STATUS)
    .is("converted_at", null)
    .select("id");
  if (error) return { marked: false, error };
  return { marked: !!data?.length };
}
