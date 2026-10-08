import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * STAMP FOLLOWS DEED, THE LEAD TOO (review, 2026-09-25; moved into the one attach door, cn-v1069).
 *
 * A visit booked from a lead that is attached to an existing job has converted that lead exactly as
 * Start The Job would: the job carries the lead (only when it carries none), and the lead is won
 * (only when nobody stamped it yet). This used to live in Link To J-0xx Instead alone, so the SAME
 * attach made through the visit's own Connect picker (linkAppointmentTo) left the lead sitting on
 * /leads as "contacted" with its job already on the calendar. Now every road to the attach door
 * stamps it, through this one function.
 *
 * Best-effort: the attach already landed, and a lead that could not be marked is SAID (the sentence
 * comes back), never swallowed. Twice-safe by the null guards.
 */
export async function stampLeadWonByJob(
  supabase: SupabaseClient,
  w: { jobId: string; inquiryId: string | null | undefined },
): Promise<{ warning?: string }> {
  if (!w.inquiryId) return {};
  const nowIso = new Date().toISOString();
  const { error: jErr } = await supabase
    .from("jobs")
    .update({ inquiry_id: w.inquiryId })
    .eq("id", w.jobId)
    .is("inquiry_id", null)
    .select("id");
  const { error: lErr } = await supabase
    .from("inquiries")
    .update({ status: "won", converted_at: nowIso, updated_at: nowIso })
    .eq("id", w.inquiryId)
    .is("converted_at", null)
    .select("id");
  if (jErr || lErr) return { warning: "The lead behind this visit could not be marked won. Mark it on Leads." };
  return {};
}
