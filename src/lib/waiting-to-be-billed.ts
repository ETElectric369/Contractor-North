import type { SupabaseClient } from "@supabase/supabase-js";
import { unbilledWorkForJob } from "@/lib/unbilled-work";
import { jobBillsItsActuals } from "@/lib/invoice-import-rule";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { jobSaidLabel } from "@/lib/job-pick-label";
import { customerNamePart } from "@/lib/schedule-options";
import { reportError } from "@/lib/observe";

/**
 * WAITING TO BE BILLED (Wednesday task 4, item F, 2026-10-07): every Time & Material job, open or
 * complete, that holds hours, receipts or stock no invoice claims yet - oldest work first.
 *
 * Done - Not Invoiced lists COMPLETE jobs with NO invoice at all, by design; a T&M job with one
 * invoice and three more weeks of hours is on no list anywhere (the J-013 hole). The answer per job
 * is THE ONE FUNCTION (unbilledWorkForJob): the same claims rule, the same prices, the same
 * "something to bill" test the job's own card uses (workPending). This module reads no claim of its
 * own and derives no second figure: it loops jobs and sorts. A job whose work could not be read is
 * listed as unread, never as $0 - a lost read is not an empty job.
 *
 * Read only behind /billing?open=waiting: it is a dozen round trips per job.
 */

export type WaitingRow = {
  jobId: string;
  /** The job as the repo's one label helper says it: place, number, who (name-jobs-not-numbers). */
  label: string;
  /** The job's status word, so a complete job reads as one. */
  status: string;
  oldestAt: string | null;
  hours: number;
  billsBilled: number;
  stockBilled: number;
  total: number;
  /** The job's work could not be read: say so, never $0. */
  unread?: boolean;
};

export type WaitingRead = { rows: WaitingRow[]; problem: string | null; /** Jobs past the cap, not checked. */ more: number };

/** The most jobs one open of the list checks; the rest are counted and said, never cut quietly. */
export const WAITING_JOBS = 200;

type JobRow = {
  id: string;
  job_number: string | null;
  name: string | null;
  status: string;
  billing_type: string | null;
  customers?: { name?: string | null; company_name?: string | null } | { name?: string | null; company_name?: string | null }[] | null;
};

const say = (j: JobRow) => jobSaidLabel({ job_number: j.job_number, name: j.name, customer: customerNamePart(Array.isArray(j.customers) ? j.customers[0] : j.customers) });

/** Oldest work first (a row with no date after those, an unread row last), then by label. */
export function rankWaiting(rows: readonly WaitingRow[]): WaitingRow[] {
  const tier = (r: WaitingRow) => (r.unread ? 2 : r.oldestAt ? 0 : 1);
  const day = (r: WaitingRow) => (r.oldestAt ?? "").slice(0, 10);
  return [...rows].sort((a, b) => tier(a) - tier(b) || (day(a) < day(b) ? -1 : day(a) > day(b) ? 1 : 0) || a.label.localeCompare(b.label));
}

export async function readWaitingToBeBilled(supabase: SupabaseClient): Promise<WaitingRead> {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, job_number, name, status, billing_type, customers(name, company_name)")
    .eq("billing_type", "tm")
    .in("status", [...ACTIVE_JOB_STATUSES, "complete"])
    .order("created_at", { ascending: false })
    .limit(WAITING_JOBS + 1);
  if (error) {
    reportError("billing:waiting.jobs", error);
    return { rows: [], problem: "Your jobs couldn't be read just now. Reload to try again.", more: 0 };
  }
  const all = ((data ?? []) as JobRow[]).map((j) => ({ ...j, id: String(j.id) }));
  const jobs = all.slice(0, WAITING_JOBS);
  const more = Math.max(0, all.length - jobs.length);
  // A job on a payment schedule bills by its milestones (jobBillsItsActuals): never here.
  const withMilestones = new Set<string>();
  if (jobs.length) {
    const ms = await supabase
      .from("payment_milestones")
      .select("job_id")
      .in("job_id", jobs.map((j) => j.id))
      .limit(5000);
    if (ms.error) {
      reportError("billing:waiting.milestones", ms.error);
      return { rows: [], problem: "Your payment schedules couldn't be read just now. Reload to try again.", more: 0 };
    }
    for (const m of (ms.data ?? []) as { job_id: string }[]) withMilestones.add(String(m.job_id));
  }
  const candidates = jobs.filter((j) => jobBillsItsActuals(j.billing_type, withMilestones.has(j.id) ? 1 : 0));
  const rows: WaitingRow[] = [];
  // Four jobs at a time: each is its own dozen reads.
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const j = candidates[next++];
      try {
        const w = await unbilledWorkForJob(supabase, j.id);
        // Before the claims schema, nothing can say what is unclaimed: the card says nothing either.
        if (!w.schemaReady) continue;
        // THE CARD'S OWN TEST for "something to bill" (workPending on the job's card).
        if (!(w.hours > 0 || w.billsCount > 0 || w.stockCount > 0)) continue;
        rows.push({ jobId: j.id, label: say(j), status: j.status, oldestAt: w.oldestAt ?? null, hours: w.hours, billsBilled: w.billsBilled, stockBilled: w.stockBilled ?? 0, total: w.total });
      } catch (e) {
        reportError("billing:waiting.job", e, { jobId: j.id });
        rows.push({ jobId: j.id, label: say(j), status: j.status, oldestAt: null, hours: 0, billsBilled: 0, stockBilled: 0, total: 0, unread: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  return { rows: rankWaiting(rows), problem: null, more };
}
