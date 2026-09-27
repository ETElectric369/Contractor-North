import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { offHoldWords } from "@/lib/come-back-days";

/**
 * What the promotion did, for the door that asked: `offHold` is set when the job WAS ON HOLD and this
 * promotion took it off (NY-hold, 0366): the sentence that says so, in the words every clock door
 * shows ("J-048 was on hold (waiting on the permit). It's off hold now."). Null when nothing about a
 * hold changed: the job was not held, the promotion couldn't run, or someone else moved it first.
 */
export type PromoteOutcome = { offHold: string | null };

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
 * A HELD JOB COMES OFF HOLD HERE, AND THAT IS SAID (NY-hold, 0366). on_hold is one of the active
 * statuses, so clocking into a held job promotes it like any other; the database then clears its
 * reason, its day and who held it (jobs_hold_day). Nobody chose that, so it is never silent: the
 * write that took it off hold is its own checked update (only while it is still on hold), and the
 * outcome carries the sentence the door shows.
 *
 * Lives in a plain server module, never a "use server" file: exported from one of those it would
 * be a client-callable action holding the service client.
 *
 * Never throws: the punch is the thing that must land.
 */
export async function promoteJobToInProgress(supabase: Pick<SupabaseClient, "from">, jobId: string): Promise<PromoteOutcome> {
  try {
    const { data: jobRow } = await supabase
      .from("jobs")
      .select("org_id, status, job_number, name, hold_reason")
      .eq("id", jobId)
      .maybeSingle();
    const job = jobRow as { org_id?: string; status?: string | null; job_number?: string | null; name?: string | null; hold_reason?: string | null } | null;
    const jobOrg = job?.org_id;
    if (!jobOrg) return { offHold: null };
    if (job?.status === "on_hold") {
      const { data: woke } = await createServiceClient()
        .from("jobs")
        .update({ status: "in_progress" })
        .eq("id", jobId)
        .eq("org_id", jobOrg)
        .eq("status", "on_hold")
        .select("id");
      if ((woke ?? []).length) return { offHold: offHoldWords({ jobNumber: job.job_number, name: job.name, reason: job.hold_reason }) };
      // Someone moved it off hold between the read and the write: promote it as any other job.
    }
    await createServiceClient()
      .from("jobs")
      .update({ status: "in_progress" })
      .eq("id", jobId)
      .eq("org_id", jobOrg)
      .in("status", ACTIVE_JOB_STATUSES.filter((st) => st !== "in_progress" && st !== "on_hold"));
    return { offHold: null };
  } catch {
    /* the punch already landed — a board that lags is not worth failing it over */
    return { offHold: null };
  }
}
