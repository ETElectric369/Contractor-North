import { laborCostForJob } from "@/lib/labor-billing";
import { jobProgressFinancials } from "@/lib/job-financials";

const round2 = (n: number) => Math.round(n * 100) / 100;

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

export type BudgetCategory = { category: string; budget: number };

/**
 * The estimate's budget broken out by SCOPE category (Framing, Decking, Electrical…) from the
 * job's quote line items' `category` (cn-v420) — summed across ALL the job's quotes, so an
 * original estimate + change-order quotes roll up to the current budget (matching the Tahoe
 * Deck Budget-vs-Actual sheet's "original + approved change orders"). Lets Nort see WHERE the
 * budget lives and reason about concentration/masking ("decking $40k hasn't started, so the
 * spend so far is all demo + framing"). Untagged lines fall under "Uncategorized". Highest
 * first. Empty when the job has no quote (nothing to budget against).
 */
export async function getJobBudgetByCategory(supabase: any, jobId: string): Promise<BudgetCategory[]> {
  const { data: quotes } = await supabase.from("quotes").select("id").eq("job_id", jobId);
  const quoteIds = (quotes ?? []).map((q: { id: string }) => q.id);
  if (quoteIds.length === 0) return [];
  const { data: lines } = await supabase
    .from("quote_line_items")
    .select("category, line_total, quantity, unit_price")
    .in("quote_id", quoteIds);
  const map = new Map<string, number>();
  for (const l of (lines ?? []) as any[]) {
    const cat = String(l.category ?? "").trim() || "Uncategorized";
    const amt = Number(l.line_total ?? (Number(l.quantity) || 0) * (Number(l.unit_price) || 0)) || 0;
    map.set(cat, (map.get(cat) ?? 0) + amt);
  }
  return [...map.entries()]
    .map(([category, budget]) => ({ category, budget: Math.round(budget * 100) / 100 }))
    .sort((a, b) => b.budget - a.budget);
}

export type ActualCategory = { category: string; actual: number };

/** ACTUAL costs by scope category — bills grouped by scope_category (0105), plus purchase
 *  orders folded into "Uncategorized" (POs carry no scope). Highest first. The scope strings
 *  match the estimate's (quote_line_items.category), so this joins to getJobBudgetByCategory. */
export async function getJobActualByCategory(supabase: any, jobId: string): Promise<ActualCategory[]> {
  const [{ data: bills }, { data: pos }] = await Promise.all([
    supabase.from("bills").select("amount, scope_category").eq("job_id", jobId),
    supabase.from("purchase_orders").select("total").eq("job_id", jobId),
  ]);
  const map = new Map<string, number>();
  for (const b of (bills ?? []) as any[]) {
    const cat = String(b.scope_category ?? "").trim() || "Uncategorized";
    map.set(cat, (map.get(cat) ?? 0) + (Number(b.amount) || 0));
  }
  const poTotal = ((pos ?? []) as any[]).reduce((s, p) => s + (Number(p.total) || 0), 0);
  if (poTotal) map.set("Uncategorized", (map.get("Uncategorized") ?? 0) + poTotal);
  return [...map.entries()]
    .map(([category, actual]) => ({ category, actual: Math.round(actual * 100) / 100 }))
    .sort((a, b) => b.actual - a.actual);
}

export type BudgetVsActualRow = {
  category: string;
  budget: number;
  actual: number;
  remaining: number; // budget − actual
  burnPct: number | null; // actual / budget (null when no budget for this scope)
  overBudget: boolean;
};

/** PURE: merge budget-by-scope + actual-by-scope into per-scope variance rows (union of keys). */
export function mergeBudgetActual(budget: BudgetCategory[], actual: ActualCategory[]): BudgetVsActualRow[] {
  const b = new Map(budget.map((x) => [x.category, x.budget]));
  const a = new Map(actual.map((x) => [x.category, x.actual]));
  const cats = [...new Set([...b.keys(), ...a.keys()])];
  return cats
    .map((category) => {
      const bud = b.get(category) ?? 0;
      const act = a.get(category) ?? 0;
      return {
        category,
        budget: bud,
        actual: act,
        remaining: Math.round((bud - act) * 100) / 100,
        burnPct: bud > 0 ? Math.round((act / bud) * 100) : null,
        overBudget: bud > 0 && act > bud,
      };
    })
    .sort((x, y) => y.budget - x.budget || y.actual - x.actual);
}

/** One job's per-scope budget-vs-actual: the estimate budget by scope vs actual costs by
 *  scope. This is what lets Nort say "framing specifically is 83% over" — the masked overrun. */
export async function getJobBudgetVsActual(supabase: any, jobId: string): Promise<BudgetVsActualRow[]> {
  const [budget, actual] = await Promise.all([
    getJobBudgetByCategory(supabase, jobId),
    getJobActualByCategory(supabase, jobId),
  ]);
  return mergeBudgetActual(budget, actual);
}

/** The distinct estimate SCOPE strings for a job (minus "Uncategorized") — the allowed set the
 *  receipt AI must pick from so a tagged cost joins the budget. Empty when the job has no
 *  scoped estimate (then costs stay Uncategorized). */
export async function listJobScopes(supabase: any, jobId: string): Promise<string[]> {
  const budget = await getJobBudgetByCategory(supabase, jobId);
  return budget.map((b) => b.category).filter((c) => c && c !== "Uncategorized");
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

// ── Profit by work type ──────────────────────────────────────────────────────
export type ProfitByType = { type: string; jobs: number; revenue: number; cost: number; profit: number; marginPct: number | null };

/** Pure — roll per-job profit rows up by work type. `typeOf` maps job id → type name. */
export function computeProfitByType(rows: JobProfitRow[], typeOf: Map<string, string>): ProfitByType[] {
  const groups = new Map<string, { revenue: number; cost: number; profit: number; jobs: number }>();
  for (const r of rows) {
    const type = typeOf.get(r.id) ?? "Uncategorized";
    const g = groups.get(type) ?? { revenue: 0, cost: 0, profit: 0, jobs: 0 };
    g.revenue += r.rev;
    g.cost += r.cost;
    g.profit += r.profit;
    g.jobs += 1;
    groups.set(type, g);
  }
  return [...groups.entries()]
    .map(([type, g]) => ({
      type,
      jobs: g.jobs,
      revenue: round2(g.revenue),
      cost: round2(g.cost),
      profit: round2(g.profit),
      marginPct: g.revenue > 0 ? Math.round((g.profit / g.revenue) * 100) : null,
    }))
    .sort((a, b) => b.profit - a.profit);
}

/** Which KIND of work makes money — job profit grouped by the job's code-template ("Panel swap",
 *  "Service call", "Deck build"…). Jobs with no template group under "Uncategorized". */
export async function listProfitByType(supabase: any): Promise<ProfitByType[]> {
  const rows = computeJobProfitRows(await fetchProfitInputs(supabase));
  const { data: jobTypes } = await supabase.from("jobs").select("id, job_code_templates(name)");
  const typeOf = new Map<string, string>();
  for (const j of (jobTypes ?? []) as any[]) typeOf.set(j.id, j.job_code_templates?.name ?? "Uncategorized");
  return computeProfitByType(rows, typeOf);
}
