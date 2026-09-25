/**
 * The one read behind "Link To J-055 Instead" (lib/appointments/visit-start.ts has the rule). The
 * appointment page offers the door from it and linkVisitInstead re-asks it before linking, so the
 * page and the action can never disagree about which job is on offer.
 *
 * Through the CALLER's client: RLS keeps every row to the caller's org.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { linkInsteadPick, visitDay, visitDayBounds, type LinkInsteadJob } from "./visit-start";

/** Who the visit is for: its own customer, else the customer its lead already carries. */
export async function visitCustomerId(
  supabase: SupabaseClient,
  appt: { customer_id?: string | null; inquiry_id?: string | null },
): Promise<string | null> {
  if (appt.customer_id) return appt.customer_id;
  if (!appt.inquiry_id) return null;
  const { data } = await supabase.from("inquiries").select("customer_id").eq("id", appt.inquiry_id).maybeSingle();
  return (data as { customer_id?: string | null } | null)?.customer_id ?? null;
}

/**
 * The same customer's one job made on the visit's day that is not cancelled (open OR finished), or
 * null (none, or more than one). The read is narrowed to the visit's org-local day, so a customer
 * with a long history can never push the right job out of the page; the pick re-checks the day.
 */
export async function loadLinkInstead(
  supabase: SupabaseClient,
  appt: { customer_id?: string | null; inquiry_id?: string | null; starts_at?: string | null; job_id?: string | null },
  tz: string,
): Promise<LinkInsteadJob | null> {
  if (appt.job_id) return null; // a linked visit keeps its link; nothing is offered over it
  const customerId = await visitCustomerId(supabase, appt);
  if (!customerId) return null;
  const day = visitDay(appt.starts_at, tz);
  const { start, end } = visitDayBounds(day, tz);
  const { data, error } = await supabase
    .from("jobs")
    .select("id, job_number, name, status, created_at")
    .eq("customer_id", customerId)
    .neq("status", "cancelled")
    .gte("created_at", start)
    .lt("created_at", end)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data) return null; // a failed read offers nothing rather than a guess
  return linkInsteadPick(data as LinkInsteadJob[], day, tz);
}
