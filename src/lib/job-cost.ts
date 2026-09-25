/**
 * WHAT A JOB'S MATERIALS COST THE COMPANY, ONCE THE SHELF IS IN THE PICTURE (Shop Stock, 0303).
 *
 *   job material cost = the job's live bills  -  off_shelf  +  from_shelf
 *
 *   · off_shelf  = what the rolls put on the shelf from the job's OWN tickets cost (the 12/2 coil
 *                  Herringbone bought and did not use: $180.17 comes off Herringbone);
 *   · from_shelf = what the pieces the job TOOK from the shelf cost, as the database stamped them,
 *                  less any carried back (60 ft of that coil onto another job: $43.24 lands there).
 *
 * Both come from ONE place, the security-invoker view job_shelf_net, so Nort's SQL, this file and
 * every screen read the same number. With no lots anywhere - every org, the day this shipped - both
 * are zero and every job's cost is exactly what it was: bills.amount, summed.
 *
 * ── RULE 11: WHAT DOES NOT MOVE ───────────────────────────────────────────────────────────────
 * Only JOB COST and OWNER MONEY follow the piece. These keep reading the WHOLE ticket, because CED
 * is owed for the roll whoever ends up using it:
 *   · the supplier balance (Bills page, supplier accounts and statements);
 *   · learned prices (src/lib/pricing/learned-prices.ts, the 0100 price book: what a part COST);
 *   · supplier_invoices debt and the CED reconciliation.
 * Do not "fix" them to net the shelf out. A supplier balance that shrinks because a roll went on a
 * shelf would be a debt that vanished on paper and not at CED.
 *
 * ── THE PR CHECKLIST (Phase 1): every `.from("bills")` read that sums amount by job ──────────
 *   switched to jobMaterialCost (bills - off_shelf + from_shelf):
 *     · src/app/(app)/jobs/[id]/page.tsx        the Costs tab tiles, profit, the Costs headline
 *     · src/lib/analytics/job-profitability.ts  computeJobProfitRows (via ProfitInputs.shelfNet),
 *                                               fetchProfitInputs, getJobActualByCategory
 *     · src/app/(app)/analytics/page.tsx        Job profitability (builds its own ProfitInputs)
 *     · Nort: get_job_financials / list_job_profitability / profit_by_type (through the above)
 *     · src/lib/analytics/owner-money.ts        the shelf's part of a bill goes to Put On The Shelf
 *   stays whole (a supplier's paper, or what the CUSTOMER pays):
 *     · src/app/(app)/bills/page.tsx, bills/supplier-actions.ts   supplier balance and debt
 *     · src/lib/pricing/learned-prices.ts (0100)                   learned price
 *     · src/lib/unbilled-work.ts, src/lib/job-financials.ts,
 *       billing/actions.ts importCostsIntoInvoice                  what the customer is billed: a
 *       receipt counts for what it BILLS (billableBillCost), and the shelf's part of a line is
 *       already off through billed_amount. Pieces taken from the shelf join these in Phase 3.
 *     · jobs/actions.ts, organize/*, recurring-engine.ts, action-items/*   writes and presence
 *       checks, no sums.
 *
 * Pure half plus a thin read. No server-only imports, so the tests and the snapshot tool load it.
 */

export type ShelfNet = { offShelf: number; fromShelf: number };
export const NO_SHELF: ShelfNet = Object.freeze({ offShelf: 0, fromShelf: 0 });

/** A row of job_shelf_net as PostgREST hands it back (numeric columns may arrive as strings). */
export type JobShelfNetRow = { job_id: string | null; off_shelf: unknown; from_shelf: unknown };

const cents = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** job_shelf_net rows keyed by job. A job with no row has nothing on or off the shelf. */
export function shelfNetByJob(rows: readonly JobShelfNetRow[] | null | undefined): Map<string, ShelfNet> {
  const out = new Map<string, ShelfNet>();
  for (const r of rows ?? []) {
    if (!r?.job_id) continue;
    const prev = out.get(r.job_id) ?? { offShelf: 0, fromShelf: 0 };
    out.set(r.job_id, { offShelf: cents(prev.offShelf + num(r.off_shelf)), fromShelf: cents(prev.fromShelf + num(r.from_shelf)) });
  }
  return out;
}

/** The one line of arithmetic: bills - off_shelf + from_shelf, to the cent. */
export function jobMaterialCostFrom(billsTotal: number, net?: ShelfNet | null): number {
  return cents(num(billsTotal) - num(net?.offShelf) + num(net?.fromShelf));
}

export type JobMaterialCost = {
  /** What the job's materials cost the company: tickets + fromStock. */
  total: number;
  /** The job's own tickets, less what went on the shelf from them. */
  tickets: number;
  /** Pieces taken from the shelf onto this job, net of any carried back. */
  fromStock: number;
  /** What went on the shelf from this job's own tickets. */
  offShelf: number;
  /** True when the shelf touched this job at all - the only time a screen says so. */
  shelfTouched: boolean;
};

/** The same number, broken out the way the job page's tile reads it. */
export function splitJobMaterialCost(billsTotal: number, net?: ShelfNet | null): JobMaterialCost {
  const off = cents(num(net?.offShelf));
  const from = cents(num(net?.fromShelf));
  const tickets = cents(num(billsTotal) - off);
  return {
    total: jobMaterialCostFrom(billsTotal, net),
    tickets,
    fromStock: from,
    offShelf: off,
    shelfTouched: Math.abs(off) >= 0.005 || Math.abs(from) >= 0.005,
  };
}

/**
 * The one error a database WITHOUT 0303 gives for the shelf's tables and views. Read as "no lots
 * yet", which is exactly true there: there cannot be a lot in a table that does not exist. Any
 * other error is a lost read and is never read as zero.
 */
export function isMissingShelf(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    ((/stock_|job_shelf_net|on_shelf/i.test(msg)) && /does not exist|could not find/i.test(msg))
  );
}

type Sb = { from: (t: string) => any };

/**
 * job_shelf_net for one job, a list of jobs, or (no argument) every job the caller can see. RLS
 * scopes it (security invoker: staff only; a tech reads nothing, and reads no bills either).
 * Returns `error` for a real failure so the caller can refuse rather than print a number that is
 * short by the shelf.
 */
export async function readJobShelfNet(
  supabase: Sb,
  jobs?: string | readonly string[],
): Promise<{ byJob: Map<string, ShelfNet>; rows: JobShelfNetRow[]; error: unknown | null }> {
  let q = supabase.from("job_shelf_net").select("job_id, off_shelf, from_shelf");
  if (typeof jobs === "string") q = q.eq("job_id", jobs);
  else if (Array.isArray(jobs)) {
    if (!jobs.length) return { byJob: new Map(), rows: [], error: null };
    q = q.in("job_id", jobs as string[]);
  } else q = q.limit(50000);
  const { data, error } = await q;
  if (error) {
    if (isMissingShelf(error)) return { byJob: new Map(), rows: [], error: null };
    return { byJob: new Map(), rows: [], error };
  }
  const rows = (data ?? []) as JobShelfNetRow[];
  return { byJob: shelfNetByJob(rows), rows, error: null };
}

/** One job's material cost from its live bills total (the caller already summed bills.amount). */
export async function jobMaterialCost(supabase: Sb, jobId: string, billsTotal: number): Promise<JobMaterialCost> {
  const { byJob, error } = await readJobShelfNet(supabase, jobId);
  if (error) throw error;
  return splitJobMaterialCost(billsTotal, byJob.get(jobId));
}

/** Many jobs at once: each job's bills total in, each job's material cost out. */
export async function jobMaterialCostByJob(
  supabase: Sb,
  billsTotalByJob: ReadonlyMap<string, number>,
): Promise<Map<string, JobMaterialCost>> {
  const { byJob, error } = await readJobShelfNet(supabase, [...billsTotalByJob.keys()]);
  if (error) throw error;
  const out = new Map<string, JobMaterialCost>();
  for (const [jobId, total] of billsTotalByJob) out.set(jobId, splitJobMaterialCost(total, byJob.get(jobId)));
  // A job that only TOOK from the shelf and has no bills of its own still has a material cost.
  for (const [jobId, net] of byJob) if (!out.has(jobId)) out.set(jobId, splitJobMaterialCost(0, net));
  return out;
}

/**
 * What the shelf took off each of a set of bills: the cost of the live lots on each. For readers
 * that break a job's cost down BY BILL (budget vs actual, by scope). Staff only through RLS.
 */
export async function readBillShelfOff(
  supabase: Sb,
  billIds: readonly string[],
): Promise<{ byBill: Map<string, number>; error: unknown | null }> {
  if (!billIds.length) return { byBill: new Map(), error: null };
  const { data, error } = await supabase
    .from("stock_lot_balance")
    .select("bill_id, cost, live")
    .in("bill_id", billIds as string[])
    .eq("live", true);
  if (error) {
    if (isMissingShelf(error)) return { byBill: new Map(), error: null };
    return { byBill: new Map(), error };
  }
  const byBill = new Map<string, number>();
  for (const r of (data ?? []) as { bill_id: string | null; cost: unknown }[]) {
    if (!r.bill_id) continue;
    byBill.set(r.bill_id, cents((byBill.get(r.bill_id) ?? 0) + num(r.cost)));
  }
  return { byBill, error: null };
}
