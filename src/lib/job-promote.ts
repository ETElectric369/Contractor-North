import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";

/**
 * PROMOTE A JOB TO in_progress WHEN SOMEBODY STARTS WORKING ON IT.
 *
 * ONE COPY, called by clock-in, by switch-job, and by "Which Job Are You On?" (naming the job a
 * punch is on is the same fact as clocking into it). The drift between two copies IS the bug this
 * fixed: clockIn was moved onto the service client in cn-v650 because `jobs_write` requires
 * is_org_staff(), so a TECH's promotion was a zero-row UPDATE that PostgREST reports as success —
 * Brian starts at 7am, the job sits in to_be_scheduled all day, and the office's board is wrong
 * about what is actually being worked. switchJob kept the old broken copy, so the same silent
 * no-op survived on the other path.
 *
 * THE AUTHORIZATION IS THE READ, on the caller's OWN RLS client. No visible row means no org id
 * and nothing is promoted — so the service write can only ever touch a job this person could
 * already see, in their own org. It writes ONE column on ONE row, and never un-completes a
 * finished or cancelled job.
 *
 * Lives in a plain server module, never a "use server" file: exported from one of those it would
 * be a client-callable action holding the service client.
 *
 * Never throws: the punch is the thing that must land.
 */
export async function promoteJobToInProgress(supabase: Pick<SupabaseClient, "from">, jobId: string): Promise<void> {
  try {
    const { data: jobRow } = await supabase.from("jobs").select("org_id").eq("id", jobId).maybeSingle();
    const jobOrg = (jobRow as { org_id?: string } | null)?.org_id;
    if (!jobOrg) return;
    await createServiceClient()
      .from("jobs")
      .update({ status: "in_progress" })
      .eq("id", jobId)
      .eq("org_id", jobOrg)
      .in("status", ACTIVE_JOB_STATUSES.filter((st) => st !== "in_progress"));
  } catch {
    /* the punch already landed — a board that lags is not worth failing it over */
  }
}
