import { laborCostForJob } from "@/lib/labor-billing";
import { jobProgressFinancials } from "@/lib/job-financials";

/**
 * Job profitability — the ONE allocation-aware computation shared by /analytics, the job hub, and
 * (now) Nort's get_job_financials / list_job_profitability tools, so a job can never show two
 * different profits. Extracted verbatim from the /analytics inline block; revenue = cash COLLECTED
 * (amount_paid on non-void invoices) net of refunds, cost = labor (laborCostForJob, at pay rate,
 * split-aware) + materials (POs + bills).
 *
 * KNOWN DOUBLE-COUNT (mirrored on the job hub + analytics): a cost entered as BOTH a purchase order
 * AND a supplier bill is counted twice — there's no FK linking a bill to the PO it pays, so it can't
 * be deduped yet. Recording one or the other (not both) keeps it honest. Tools disclose this.
 */
export type JobProfitRow = {
  id: string;
  job_number: string;
  name: string;
  status: string;
  rev: number;
  cost: number;
  profit: number;
};

export type ProfitInputs = {
  jobs: any[];
  invoices: any[];
  pos: any[];
  bills: any[];
  jobRefunds: any[];
  entries: any[];
};

/** Pure — the exact per-job rows /analytics renders, sorted most-profitable first. Callers slice. */
export function computeJobProfitRows(inp: ProfitInputs): JobProfitRow[] {
  const matCost = new Map<string, number>();
  const addMat = (id: string | null, v: number) => {
    if (!id) return;
    matCost.set(id, (matCost.get(id) ?? 0) + v);
  };
  for (const p of inp.pos ?? []) addMat(p.job_id, Number(p.total));
  for (const b of inp.bills ?? []) addMat(b.job_id, Number(b.amount));

  const refundByJob = new Map<string, number>();
  for (const r of inp.jobRefunds ?? []) {
    const jid = (r as any).invoices?.job_id;
    if (jid) refundByJob.set(jid, (refundByJob.get(jid) ?? 0) + Number(r.amount ?? 0));
  }

  const revenueByJob = new Map<string, number>();
  for (const i of inp.invoices ?? []) {
    if (i.job_id && i.status !== "void")
      revenueByJob.set(i.job_id, (revenueByJob.get(i.job_id) ?? 0) + Number(i.amount_paid ?? 0));
  }

  return ((inp.jobs ?? []) as any[])
    .map((j) => {
      const rev = Math.max(0, (revenueByJob.get(j.id) ?? 0) - (refundByJob.get(j.id) ?? 0));
      const cost = laborCostForJob((inp.entries ?? []) as any[], j.id).cost + (matCost.get(j.id) ?? 0);
      return { id: j.id, job_number: j.job_number, name: j.name, status: j.status, rev, cost, profit: rev - cost };
    })
    .filter((j) => j.rev > 0 || j.cost > 0)
    .sort((a, b) => b.profit - a.profit);
}

/** Fetch the inputs for profitability. Entries are ALL closed (labor is split-aware — an allocation
 *  tagged to a job can live on another job's entry), so this is not job-scopeable; money is. */
async function fetchProfitInputs(supabase: any, jobId?: string): Promise<ProfitInputs> {
  const jobsQ = jobId
    ? supabase.from("jobs").select("id, job_number, name, status").eq("id", jobId)
    : supabase.from("jobs").select("id, job_number, name, status").order("created_at", { ascending: false });
  const invQ = jobId
    ? supabase.from("invoices").select("job_id, status, amount_paid").eq("job_id", jobId)
    : supabase.from("invoices").select("job_id, status, amount_paid");
  const posQ = jobId
    ? supabase.from("purchase_orders").select("job_id, total").eq("job_id", jobId)
    : supabase.from("purchase_orders").select("job_id, total");
  const billsQ = jobId
    ? supabase.from("bills").select("job_id, amount").eq("job_id", jobId)
    : supabase.from("bills").select("job_id, amount");

  const [{ data: jobs }, { data: invoices }, { data: pos }, { data: bills }, { data: jobRefunds }, { data: entries }] =
    await Promise.all([
      jobsQ,
      invQ,
      posQ,
      billsQ,
      supabase.from("customer_credits").select("amount, invoices(job_id)").eq("disposition", "refund"),
      supabase
        .from("time_entries")
        .select("job_id, clock_in, clock_out, lunch_minutes, status, rate_override, profiles(hourly_rate), time_allocations(job_id, hours)")
        .eq("status", "closed")
        .not("job_id", "is", null),
    ]);
  return {
    jobs: jobs ?? [],
    invoices: invoices ?? [],
    pos: pos ?? [],
    bills: bills ?? [],
    // refunds embed all-time; filter to this job when scoped (embedded filter isn't reliable).
    jobRefunds: jobId ? ((jobRefunds ?? []) as any[]).filter((r) => r.invoices?.job_id === jobId) : (jobRefunds ?? []),
    entries: entries ?? [],
  };
}

export type JobFinancials = JobProfitRow & {
  estimate: number;
  workToDate: number;
  invoiced: number;
  billingType: "fixed" | "tm";
  remaining: number; // estimate − cost
  burnPct: number | null; // cost / estimate (null when no estimate)
  overBudget: boolean; // cost has exceeded the estimate
};

/** One job's full money picture: profit (rev − cost) + budget burn (cost vs the quoted estimate). */
export async function getJobFinancials(supabase: any, jobId: string): Promise<JobFinancials | null> {
  const inp = await fetchProfitInputs(supabase, jobId);
  const row = computeJobProfitRows(inp).find((r) => r.id === jobId)
    // computeJobProfitRows drops jobs with zero rev AND zero cost; synthesize a zero row so a brand-new job still answers.
    ?? (inp.jobs[0] ? { id: jobId, job_number: inp.jobs[0].job_number, name: inp.jobs[0].name, status: inp.jobs[0].status, rev: 0, cost: 0, profit: 0 } : null);
  if (!row) return null;

  const fin = await jobProgressFinancials(supabase, jobId);
  const estimate = Math.round(fin.estimate * 100) / 100;
  return {
    ...row,
    estimate,
    workToDate: Math.round(fin.workToDate * 100) / 100,
    invoiced: Math.round(fin.invoiced * 100) / 100,
    billingType: fin.billingType,
    remaining: Math.round((estimate - row.cost) * 100) / 100,
    burnPct: estimate > 0 ? Math.round((row.cost / estimate) * 100) : null,
    overBudget: estimate > 0 && row.cost > estimate,
  };
}

/** Ranked job profitability across the org. sort "profit" = most profitable first (default);
 *  "loss" = biggest loss first. Optional status filter (e.g. active jobs only). */
export async function listJobProfitability(
  supabase: any,
  opts: { limit?: number; statuses?: string[]; sort?: "profit" | "loss" } = {},
): Promise<JobProfitRow[]> {
  const inp = await fetchProfitInputs(supabase);
  let rows = computeJobProfitRows(inp);
  if (opts.statuses?.length) rows = rows.filter((r) => opts.statuses!.includes(r.status));
  if (opts.sort === "loss") rows = [...rows].sort((a, b) => a.profit - b.profit);
  const limit = Math.min(40, Math.max(1, opts.limit ?? 15));
  return rows.slice(0, limit);
}
