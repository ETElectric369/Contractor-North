import { attachRates, payRateMap } from "@/lib/profile-columns";
import { laborCostForJob } from "@/lib/labor-billing";
import { jobProgressFinancials } from "@/lib/job-financials";
import { livePurchaseOrders } from "@/lib/job-progress-math";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Job profitability — the ONE allocation-aware computation shared by /analytics and Nort's
 * get_job_financials / list_job_profitability tools, so a job can never show two different
 * profits across them. Revenue = cash COLLECTED net of refunds; cost = labor (laborCostForJob,
 * at pay rate, split-aware) + materials (live POs + bills, via the shared livePurchaseOrders rule).
 *
 * "Collected" is THE cash definition (computeCollected in money-metrics): the PAYMENTS ledger net
 * of voided invoices — NOT invoices.amount_paid. amount_paid folds non-cash account credits in
 * (recalcInvoice does that so a posted credit reduces the balance), so a disputed invoice written
 * off as a credit — no cash anywhere — used to push a job's "collected"/profit UP while /payments'
 * ledger and /analytics' 12-month tile (both payments-based) disagreed on the same screen. Summing
 * payments here makes the per-job "in" number the SAME kind of cash everywhere.
 *
 * The old materials double-count is CLOSED (migration 0142): a bill that names the PO it pays
 * (bills.po_id) SUPERSEDES that PO, so one delivery entered as both a purchase order and a supplier
 * bill is counted once, at the invoiced amount. Draft/cancelled POs are not costs at all. A bill
 * filed WITHOUT naming its PO still double-counts — there is no way to infer the link, so the fix
 * is to set the PO on the bill.
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
  /** The payments ledger, each row joined to its invoice's { job_id, status }. Revenue is
   *  the SUM of these net of voided invoices — THE cash definition (not invoices.amount_paid). */
  payments: any[];
  pos: any[];
  bills: any[];
  jobRefunds: any[];
  entries: any[];
  /** Job-linked petty-cash EXPENSES. Real money out of the tin, spent on a job, and until now
   *  counted by nothing — see addMat below. */
  pettyCash: any[];
};

/** Pure — the exact per-job rows /analytics renders, sorted most-profitable first. Callers slice. */
export function computeJobProfitRows(inp: ProfitInputs): JobProfitRow[] {
  const matCost = new Map<string, number>();
  const addMat = (id: string | null, v: number) => {
    if (!id) return;
    matCost.set(id, (matCost.get(id) ?? 0) + v);
  };
  // Live POs only — a draft/cancelled order was never a cost, and a PO whose supplier bill
  // has arrived is superseded by that bill (one delivery, one cost). The bills list is
  // org-wide here, which is fine: PO ids are unique, so the supersede set can't cross-hit.
  for (const p of livePurchaseOrders((inp.pos ?? []) as any[], (inp.bills ?? []) as any[]))
    addMat((p as any).job_id, Number((p as any).total));
  for (const b of inp.bills ?? []) addMat(b.job_id, Number(b.amount));
  // PETTY CASH IS COST (audit v800 wave B). A tech buys 35 ft of 10/3 Romex out of the tin,
  // tags it to the job, and every profit reader in the app ignored it — the job looked more
  // profitable by exactly the amount that left the business. Only `expense` counts: a
  // `replenish` row is the tin being refilled, which is a transfer, not a cost, and adding it
  // would double-count the same dollars as they move.
  for (const pc of inp.pettyCash ?? [])
    if ((pc as any).kind !== "replenish") addMat((pc as any).job_id, Number((pc as any).amount) || 0);

  const refundByJob = new Map<string, number>();
  for (const r of inp.jobRefunds ?? []) {
    const jid = (r as any).invoices?.job_id;
    if (jid) refundByJob.set(jid, (refundByJob.get(jid) ?? 0) + Number(r.amount ?? 0));
  }

  // Revenue = CASH collected per job: the payments ledger net of voided invoices (THE
  // computeCollected definition), keyed to a job via the payment's invoice. NOT
  // invoices.amount_paid — that includes non-cash account credits and overstated "collected".
  const revenueByJob = new Map<string, number>();
  for (const p of inp.payments ?? []) {
    const inv = (p as any).invoices;
    if (!inv?.job_id || inv.status === "void") continue; // no cash on a voided invoice
    revenueByJob.set(inv.job_id, (revenueByJob.get(inv.job_id) ?? 0) + Number((p as any).amount ?? 0));
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
    // The one query cn-v744 missed (audit 9): the JOB LIST itself. Truncated, an org's older
    // jobs vanish from profitability entirely — their revenue and cost both gone, so the board
    // silently ranks a subset while claiming to rank the business.
    : supabase.from("jobs").select("id, job_number, name, status").order("created_at", { ascending: false }).limit(50000);
  // Cash collected per job = the PAYMENTS ledger net of voided invoices (THE computeCollected
  // definition), NOT invoices.amount_paid (which folds in non-cash account credits). Embedded
  // filters aren't reliable (same note as jobRefunds below), so a scoped call fetches all
  // payments with the invoice join and filters in JS. .limit past PostgREST's 1000-row cap.
  const paymentsQ = supabase.from("payments").select("amount, invoices(job_id, status)").limit(50000);
  // id/status/po_id feed the shared livePurchaseOrders rule (draft+cancelled aren't costs;
  // a billed PO is superseded by its bill).
  const posQ = jobId
    ? supabase.from("purchase_orders").select("id, job_id, total, status").eq("job_id", jobId)
    : supabase.from("purchase_orders").select("id, job_id, total, status").limit(50000);
  const billsQ = jobId
    ? supabase.from("bills").select("job_id, amount, po_id").eq("job_id", jobId)
    : supabase.from("bills").select("job_id, amount, po_id").limit(50000);
  // Job-linked only: petty cash with no job is overhead, not a job's cost.
  const pettyQ = jobId
    ? supabase.from("petty_cash").select("job_id, amount, kind").eq("job_id", jobId)
    : supabase.from("petty_cash").select("job_id, amount, kind").not("job_id", "is", null).limit(50000);

  const [{ data: jobs }, { data: payments }, { data: pos }, { data: bills }, { data: petty }, { data: jobRefunds }, { data: entries }] =
    await Promise.all([
      jobsQ,
      paymentsQ,
      posQ,
      billsQ,
      pettyQ,
      supabase.from("customer_credits").select("amount, invoices(job_id)").eq("disposition", "refund").limit(50000),
      supabase
        .from("time_entries")
        .select("job_id, clock_in, clock_out, lunch_minutes, status, rate_override, profiles(id), time_allocations(job_id, hours)")
        .eq("status", "closed")
        // Explicit high limit + a stable order (audit 8): no .limit() means PostgREST's silent
        // 1000-row default, which truncated LABOR while revenue came back whole — every job
        // read more profitable than it is, and unstably so with no ORDER BY.
        .order("clock_in", { ascending: false })
        .limit(50000),
        // NB: no `.not("job_id","is",null)` — a job-less clock-in whose hours were split
        // ONTO jobs via allocations was dropped here while the job hub costed it, so the
        // same job showed two different labor numbers. laborCostForJob already ignores
        // entries that don't touch the job.
    ]);
  // Labor rates: merged from the staff-scoped `profile_pay` view onto the embedded profile by
  // its id. 0215/0216 revoke those columns from the `authenticated` role — RLS cannot restrict
  // columns — so a PostgREST embed can no longer carry them for anyone. Office staff get the
  // real numbers; anyone else costs labor at zero rather than reading the crew's pay.
  attachRates((entries ?? []) as any[], await payRateMap(supabase), (e: any) => ({ id: e.profiles?.id, holder: e }));

  return {
    jobs: jobs ?? [],
    // payments + refunds embed all-time; filter to this job when scoped (embedded filter isn't reliable).
    payments: jobId ? ((payments ?? []) as any[]).filter((p) => p.invoices?.job_id === jobId) : (payments ?? []),
    pos: pos ?? [],
    bills: bills ?? [],
    pettyCash: petty ?? [],
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
 * THE CATEGORY LABOUR IS BOOKED UNDER on both sides of budget-vs-actual.
 *
 * Not a scope the office types — a reserved bucket, which is why it filters out of listJobScopes
 * alongside "Uncategorized": a receipt is never labour.
 */
export const LABOR_CATEGORY = "Labor";

const HOUR_UNITS = new Set(["hr", "hrs", "hour", "hours", "man-hr", "manhr"]);

/**
 * IS THIS ESTIMATE LINE LABOUR?
 *
 * budget-vs-actual was comparing a budget that INCLUDED labour against an actual that counted
 * only bills and purchase orders. Every scope therefore read wildly under budget, and on a
 * service job — which is mostly labour — a job 90% through its hours reported as barely started.
 * Nort's tool description tells it to warn when a total "looks fine only because big scopes
 * haven't started", so it would have said exactly that, confidently, about a job running hot.
 * Production carried $141k of hourly estimate lines against $0 of labour actual.
 *
 * TWO SIGNALS, checked against every estimate line in production (180 lines, 3 orgs):
 *   · an HOURLY unit — 41 lines, and all 41 are labour. Chris prices deck steps at "80 hrs @
 *     $125"; Erik prices "Lead electrician (CA C-10) — 52 hr @ $150". Zero false positives.
 *   · the word LABOUR in the description — catches the flat-rate ones the unit misses, e.g.
 *     "Labor - 2 guys for one full day, ea, $2,000" and a fixed-price panel swap.
 *
 * WHERE THIS CAN BE WRONG, and why that is survivable. An hourly EQUIPMENT rental ("excavator, 8
 * hr") would be booked as labour. That is the determinism boundary doing its usual thing, so the
 * failure mode is chosen deliberately: this split decides only which ROW a budget lands in, never
 * the total. Misfiling moves a number between two rows that are both on screen; it cannot make
 * the job's total budget or total cost wrong. A heuristic that can only ever be locally wrong is
 * worth having; one that could move the bottom line would not be.
 */
export function isLaborBudgetLine(line: { unit?: string | null; description?: string | null }): boolean {
  const unit = String(line.unit ?? "").trim().toLowerCase();
  if (HOUR_UNITS.has(unit)) return true;
  return /\blabou?rs?\b/i.test(String(line.description ?? ""));
}

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
    .select("category, line_total, quantity, unit_price, unit, description")
    .in("quote_id", quoteIds);
  const map = new Map<string, number>();
  for (const l of (lines ?? []) as any[]) {
    // Labour leaves its scope and goes to the labour bucket, because the ACTUAL side can only
    // ever know labour job-wide — a time entry carries no scope. Comparing a scope's
    // labour-inclusive budget against its materials-only actual is what made every scope read
    // under budget. See isLaborBudgetLine.
    const cat = isLaborBudgetLine(l)
      ? LABOR_CATEGORY
      : String(l.category ?? "").trim() || "Uncategorized";
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
  const [{ data: bills }, { data: pos }, { data: entries }, { data: petty }] = await Promise.all([
    supabase.from("bills").select("amount, scope_category, po_id").eq("job_id", jobId),
    supabase.from("purchase_orders").select("id, total, status").eq("job_id", jobId),
    // THE HALF THAT WAS NEVER COUNTED. Through laborCostForJob — the same split-aware, pay-rate
    // helper computeJobProfitRows uses.
    //
    // THE PROJECTION LAW, AND I BROKE IT SHIPPING THE FIX FOR IT (audit v824). cn-v821 wrote
    // `.select("*")` here. In PostgREST `*` means THIS TABLE'S COLUMNS — it does not expand
    // embeds. So the rows reached laborCostForJob with no `profiles` (no pay rate) and no
    // `time_allocations` (no split), and every hour priced at $0. The Labor row I had just added
    // to both sides read `actual: 0` on every job, and the commit's claim that the two readers
    // "can never report two different labour numbers" was false in the same breath that made it.
    // The helper was shared; the INPUT was not, and laborCostForJob is entirely input-driven.
    //
    // This is now the IDENTICAL projection to fetchProfitInputs above — same columns, same
    // embeds, same explicit limit — because that is the only thing that makes the two agree.
    supabase
      .from("time_entries")
      .select("job_id, clock_in, clock_out, lunch_minutes, status, rate_override, profiles(id), time_allocations(job_id, hours)")
      .eq("status", "closed")
      .eq("job_id", jobId)
      .order("clock_in", { ascending: false })
      .limit(50000),
    supabase.from("petty_cash").select("amount, kind").eq("job_id", jobId),
  ]);
  const map = new Map<string, number>();
  for (const b of (bills ?? []) as any[]) {
    const cat = String(b.scope_category ?? "").trim() || "Uncategorized";
    map.set(cat, (map.get(cat) ?? 0) + (Number(b.amount) || 0));
  }
  // Same live-PO rule as every other cost sum, so budget-vs-actual can't show a
  // materials overrun that only exists because a delivery was entered twice.
  const poTotal = livePurchaseOrders((pos ?? []) as any[], (bills ?? []) as any[]).reduce(
    (s, p) => s + (Number((p as any).total) || 0),
    0,
  );
  if (poTotal) map.set("Uncategorized", (map.get("Uncategorized") ?? 0) + poTotal);
  // Petty cash carries its OWN category vocabulary ("Receipt", "Materials") which is not the
  // estimate's scope vocabulary, so it lands in Uncategorized alongside POs rather than being
  // force-joined to a scope it was never tagged with.
  const pettyTotal = ((petty ?? []) as any[])
    .filter((x) => x.kind !== "replenish")
    .reduce((t, x) => t + (Number(x.amount) || 0), 0);
  if (pettyTotal) map.set("Uncategorized", (map.get("Uncategorized") ?? 0) + pettyTotal);
  // AND THE RATES. 0215/0216 revoked the pay columns from `authenticated`, so no PostgREST embed
  // can carry them for anyone — they are merged in from the staff-scoped profile_pay view,
  // exactly as fetchProfitInputs does. Without this the embeds are present and every rate is
  // still undefined, which looks identical to the bug above and is a second way to get $0.
  attachRates((entries ?? []) as any[], await payRateMap(supabase), (e: any) => ({ id: e.profiles?.id, holder: e }));
  const laborCost = laborCostForJob((entries ?? []) as any[], jobId).cost;
  if (laborCost) map.set(LABOR_CATEGORY, (map.get(LABOR_CATEGORY) ?? 0) + laborCost);
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
  // LABOR_CATEGORY is reserved, not a scope the office typed — and a receipt is never labour.
  return budget.map((b) => b.category).filter((c) => c && c !== "Uncategorized" && c !== LABOR_CATEGORY);
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
  const { data: jobTypes } = await supabase.from("jobs").select("id, job_code_templates(name)").order("created_at", { ascending: false }).limit(50000);
  const typeOf = new Map<string, string>();
  for (const j of (jobTypes ?? []) as any[]) typeOf.set(j.id, j.job_code_templates?.name ?? "Uncategorized");
  return computeProfitByType(rows, typeOf);
}
