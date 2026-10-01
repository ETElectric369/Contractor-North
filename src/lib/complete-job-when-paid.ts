import { revalidatePath } from "next/cache";
import { pushCalendarItem } from "@/lib/calendar-sync";
import { STARTED_JOB_STATUSES, jobStatusLabel } from "@/lib/job-status";
import { reportError } from "@/lib/observe";

/**
 * PAID COMPLETES THE JOB (209451e1, the money half, 2026-09-30).
 *
 * A job that has been billed in full and paid in full is done: nobody is coming back to it, and
 * a tile that still says "in progress" over a paid bill is a lie the office has to clean up by
 * hand. So every door money lands through asks this once, after the recalc that came out "paid" —
 * and since M1 there is exactly ONE caller, lib/after-payment-landed, which every payment writer
 * goes through (Record Payment and Settle Up, the Stripe writer the webhook and the Pay Now sheet
 * share, and a deposit put on an invoice out of the bank download, which used to skip this step
 * and leave a paid-off job reading "in progress" for ever).
 *
 * THE GATE, in the order it is read:
 *   1. the invoice is paid, and it is a STANDARD invoice. A paid draw (deposit / progress /
 *      final on the payment schedule) is a stage of the job, never its end; a paid deposit on a
 *      job that hasn't started must not mark it complete.
 *   2. the invoice belongs to a job, and that job has STARTED (in progress, or on hold after
 *      starting). A job still to be scheduled, or booked for a day ahead, is not ended by a
 *      bill paid up front: a small job billed as one standard invoice on Monday and paid by the
 *      link Monday night must still be on Tuesday's schedule, crew board, map and My Day, and in
 *      Google — completing it here would silently pull it off all of them before anyone drove
 *      there. The tech's punch (promoteJobToInProgress) is what starts it; then a paid bill can
 *      end it. A complete or cancelled job is left exactly as it is — nothing here un-cancels a
 *      job because a straggler bill was paid.
 *   3. the job has no OTHER live, unpaid bill. A second open invoice — a draft still being
 *      built, a sent bill still owed — means the job is still open. Void doesn't count.
 *
 * The write is CHECKED (the silent-write law: .select("id"), and the status filter rides on the
 * update so a job that moved under this read is not overwritten). Then the same touches a
 * Finish Job does (jobs/actions.ts finishJob's `complete`): the calendar push and the four
 * revalidates — duplicated here rather than imported, because that file is a "use server"
 * module owned by another lane and this runs from a Route Handler as well as from actions.
 *
 * Works with any client (RLS-scoped staff client or the webhook's service client). Never throws:
 * the money is already recorded when this runs, and a job status is not worth failing a payment
 * over — a miss is reported and the job stays as it was.
 */
export type CompleteWhenPaid = { completed: true; jobId: string } | { completed: false; why: string };

export async function completeJobWhenPaid(
  supabase: any,
  invoiceId: string,
  /** The side effects of a completion, injectable for tests. Defaults to the calendar push and the revalidates. */
  touch: (jobId: string) => Promise<void> = touchCompletedJob,
): Promise<CompleteWhenPaid> {
  try {
    const { data: inv, error: invErr } = await supabase
      .from("invoices")
      .select("id, job_id, invoice_kind, status")
      .eq("id", invoiceId)
      .maybeSingle();
    if (invErr) {
      reportError("completeJobWhenPaid:read-invoice", invErr, { invoiceId });
      return { completed: false, why: "the invoice couldn't be read" };
    }
    const row = inv as { id: string; job_id?: string | null; invoice_kind?: string | null; status?: string | null } | null;
    if (!row) return { completed: false, why: "invoice not found" };
    if (row.status !== "paid") return { completed: false, why: `the invoice is ${row.status ?? "not paid"}, not paid` };
    const kind = row.invoice_kind ?? "standard";
    if (kind !== "standard") return { completed: false, why: `a paid ${kind} draw is a stage of the job, not its end` };
    const jobId = row.job_id ?? null;
    if (!jobId) return { completed: false, why: "the invoice isn't on a job" };

    const { data: job, error: jobErr } = await supabase.from("jobs").select("id, status").eq("id", jobId).maybeSingle();
    if (jobErr) {
      reportError("completeJobWhenPaid:read-job", jobErr, { invoiceId, jobId });
      return { completed: false, why: "the job couldn't be read" };
    }
    const jobStatus = String((job as { status?: string | null } | null)?.status ?? "");
    if (!job) return { completed: false, why: "job not found" };
    if (jobStatus === "complete" || jobStatus === "cancelled") return { completed: false, why: `the job is already ${jobStatus}` };
    if (!(STARTED_JOB_STATUSES as string[]).includes(jobStatus)) {
      return { completed: false, why: `the job hasn't started (it is ${jobStatusLabel(jobStatus) || "not started"}) — a bill paid ahead of the visit doesn't end it` };
    }

    const { data: others, error: othersErr } = await supabase.from("invoices").select("id, status").eq("job_id", jobId).neq("id", invoiceId);
    if (othersErr) {
      reportError("completeJobWhenPaid:read-others", othersErr, { invoiceId, jobId });
      return { completed: false, why: "the job's other bills couldn't be read" };
    }
    const stillOwed = ((others ?? []) as { id: string; status?: string | null }[]).filter((o) => o.status !== "void" && o.status !== "paid");
    if (stillOwed.length) return { completed: false, why: `the job has ${stillOwed.length} other open bill${stillOwed.length === 1 ? "" : "s"}` };

    const { data: done, error: updErr } = await supabase
      .from("jobs")
      .update({ status: "complete" })
      .eq("id", jobId)
      .in("status", STARTED_JOB_STATUSES)
      .select("id");
    if (updErr) {
      reportError("completeJobWhenPaid:write", updErr, { invoiceId, jobId });
      return { completed: false, why: "the job's status didn't save" };
    }
    if (!done?.length) return { completed: false, why: "the job moved before it could be completed" };
    await touch(jobId);
    return { completed: true, jobId };
  } catch (e) {
    reportError("completeJobWhenPaid", e, { invoiceId });
    return { completed: false, why: "something went wrong" };
  }
}

/** What finishJob touches after its own status write (jobs/actions.ts): Google, and the four pages a finish moves. */
async function touchCompletedJob(jobId: string): Promise<void> {
  await pushCalendarItem("job", jobId); // finished job leaves Google (fire-safe)
  try {
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
    revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
    revalidatePath("/billing");
  } catch (e) {
    // The status is written; only the caches are stale, and the next navigation clears them.
    reportError("completeJobWhenPaid:revalidate", e, { jobId });
  }
}
