import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A LEAD'S ENDING TAKES ITS PICK-A-TIME LINK WITH IT (cn-v1180, the audit of 2026-11-22, A3 and the
 * carried C7).
 *
 * The withdrawal of a customer's pick-a-time link lived in one door only: a visit cancelled or done
 * (appointments/actions setAppointmentStatus). A lead's own endings never asked it. So a lead that was
 * sent times, got no pick before the first one went by (its visit no longer stands, and the lead is
 * back on the Leads list), and was then marked Not Sold, or booked another way, still had a live link:
 * the customer tapped a later time and the database (choose_schedule_slot, 0370) turned the old
 * `proposed` visit into a booking, a visit on the calendar for a lead that had ended, or a SECOND visit
 * beside the one the office had just booked. The owner's law: "one door opens, the last one closes".
 *
 * ONE RULE, EVERY ENDING ASKS IT: Not Sold on a lead, Book It (and the batch that books through it),
 * Start Now. For one lead of one company it:
 *   1. takes every `proposed` visit of that lead off through the status door it is handed (the app's
 *      one way to cancel a visit: it withdraws that visit's link, says so, and reconciles the calendar),
 *      never a second way to cancel;
 *   2. then cancels any PENDING proposal still pointing at any visit of that lead (a link the first
 *      step could not reach), read back.
 * `exceptVisitId` is left exactly as it is: the visit the calling door has just booked.
 *
 * The company is named by hand on every read and write (three companies share one database, and a
 * caller may hold a client that row-level security does not fence). Every write is read back: the
 * status door selects its row, and the sweep selects what it cancelled. Nothing here says words (a
 * lib never imports a catalog): it returns what it withdrew, and the caller says it.
 */

export type CancelVisit = (visitId: string) => Promise<{ ok: boolean; error?: string; note?: string }>;

export type PicksWithdrawn = {
  /** The `proposed` visits the status door took off. */
  visits: string[];
  /** Pick-a-time links that went from pending to cancelled (the door's own and the sweep's). */
  links: number;
  /** Proposed visits the status door could not take off. */
  failed: string[];
  /** A read or a sweep that failed. The caller files it; the ending itself has already landed. */
  error?: unknown;
};

/** True when there is something to tell the person who tapped. */
export function withdrewAnything(r: PicksWithdrawn): boolean {
  return r.visits.length > 0 || r.links > 0;
}

export async function withdrawLeadPicks(
  supabase: SupabaseClient,
  lead: { orgId: string | null; inquiryId: string; exceptVisitId?: string | null },
  cancelVisit: CancelVisit,
): Promise<PicksWithdrawn> {
  const out: PicksWithdrawn = { visits: [], links: 0, failed: [] };
  const except = lead.exceptVisitId ?? null;
  // No company, no read: a filter on a missing company would find nothing and say nothing was there.
  if (!lead.orgId) return { ...out, error: new Error("withdrawLeadPicks: no company") };

  const { data: proposed, error: readErr } = await supabase
    .from("appointments")
    .select("id")
    .eq("org_id", lead.orgId)
    .eq("inquiry_id", lead.inquiryId)
    .eq("status", "proposed");
  if (readErr) return { ...out, error: readErr };
  for (const v of (proposed ?? []) as { id: string }[]) {
    if (v.id === except) continue;
    const res = await cancelVisit(v.id);
    if (!res.ok) {
      out.failed.push(v.id);
      continue;
    }
    out.visits.push(v.id);
    // The status door says its note only when its own read-back found a link it withdrew.
    if (res.note) out.links += 1;
  }

  // THE SWEEP: a pending link on any visit of this lead that the door above did not reach.
  const { data: all, error: allErr } = await supabase
    .from("appointments")
    .select("id")
    .eq("org_id", lead.orgId)
    .eq("inquiry_id", lead.inquiryId);
  if (allErr) return { ...out, error: allErr };
  const ids = ((all ?? []) as { id: string }[]).map((a) => a.id).filter((id) => id !== except);
  if (!ids.length) return out;
  const { data: swept, error: sweepErr } = await supabase
    .from("schedule_proposals")
    .update({ status: "cancelled" })
    .eq("org_id", lead.orgId)
    .in("appointment_id", ids)
    .eq("status", "pending")
    .select("id");
  if (sweepErr) return { ...out, error: sweepErr };
  out.links += (swept ?? []).length;
  return out;
}
