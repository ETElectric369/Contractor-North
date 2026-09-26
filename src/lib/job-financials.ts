import { getOrgSettings } from "@/lib/org-settings";
import { computeJobLaborBilling, customerLaborRateForJob, customerMaterialMarkupForJob, fetchJobLaborRows } from "@/lib/labor-billing";
import { computeJobProgress, type JobProgressFinancials } from "@/lib/job-progress-math";
import { readJobBillsWithLines } from "@/lib/unbilled-work";
import { readJobStock } from "@/lib/stock-billing";

export type { JobProgressFinancials };

/** Compute a job's progress-billing financials — the numbers behind the progress
 *  report summary on a deposit/progress/final draw. Fetches the rows, then rolls
 *  them up via the pure computeJobProgress() so the panel's "work to date" equals
 *  the sum of the lines importLaborIntoInvoice / importCostsIntoInvoice actually
 *  bill (labor at charge rate via computeJobLaborBilling, materials per-row markup). */
export async function jobProgressFinancials(supabase: any, jobId: string): Promise<JobProgressFinancials> {
  const [{ data: job }, { data: quotes }, { data: invoices }, labor, { data: pos }, billsRead, { data: org }, stock] =
    await Promise.all([
      supabase.from("jobs").select("billing_type").eq("id", jobId).maybeSingle(),
      supabase.from("quotes").select("total, status, created_at").eq("job_id", jobId),
      supabase.from("invoices").select("total, status, amount_paid").eq("job_id", jobId),
      fetchJobLaborRows(supabase, jobId),
      // id + status + po_id feed the shared live-PO rule (a draft/cancelled order isn't a
      // cost, and a PO already paid by a bill is superseded by it — see livePurchaseOrders).
      supabase.from("purchase_orders").select("id, total, status").eq("job_id", jobId),
      // The job's live receipts WITH their lines, through the ONE reader the Unbilled card uses
      // (readJobBillsWithLines): a receipt counts for what it BILLS, and this panel's whole promise
      // is that its work-to-date equals the lines importCostsIntoInvoice writes. Selecting only
      // `amount` here is what put Erik's snacks, marked up, into the figure a draw is measured
      // against - the projection law, on the read that decides the reference number.
      readJobBillsWithLines(supabase, jobId),
      supabase.from("organizations").select("settings").maybeSingle(),
      // The pieces taken from stock onto the job, billed or not (Shop Stock, Phase 3): work to date
      // is everything worked. Staff through RLS; a lost read throws like the receipts.
      readJobStock(supabase, jobId),
    ]);

  // A failed receipt read is tolerated here exactly as the quotes/invoices reads beside it are
  // (empty data, no throw) so a print or analytics page still renders. It is NOT tolerated in
  // unbilledWorkForJob, which is the figure a draw actually bills from.
  // Labor: the exact helper importLaborIntoInvoice uses (per-person, quarter-hour,
  // default-rate fallback) — so the panel can't diverge from the billed lines.
  const defaultRate = getOrgSettings((org as any)?.settings).default_labor_rate; // via the settings SSOT
  const levelRate = await customerLaborRateForJob(supabase, jobId);
  // Materials honor the customer's level too — the panel promises to equal the lines the
  // importers bill, and those now seed from the level (cn-v560).
  const markupPercent = await customerMaterialMarkupForJob(
    supabase,
    jobId,
    getOrgSettings((org as any)?.settings).material_markup_percent,
  );
  const { total: billableLabor } = computeJobLaborBilling(labor.jobEntries, defaultRate, levelRate, labor.nonBillableCodes);

  // A LOST RECEIPT READ IS NOT A JOB WITH NO MATERIALS (review, 2026-09-20). unbilled-work throws
  // on this same failure, deliberately, because a reader that shrugs bills a customer short. This
  // one was passing `billsRead.data` straight through, so the draw modal's reference figure would
  // have quietly shown $0 of material on a job carrying thousands - two screens, one read, two
  // different meanings for the same lost row.
  if (billsRead.error) throw billsRead.error;

  return computeJobProgress({
    billingTypeRaw: (job as any)?.billing_type,
    quotes: (quotes ?? []) as any,
    invoices: (invoices ?? []) as any,
    billableLabor,
    pos: (pos ?? []) as any,
    bills: billsRead.data as any,
    markupPercent,
    stockTakes: stock.takes,
  });
}

/** Dollars already collected on a job BEFORE the invoice being viewed — i.e. every
 *  prior draw's payments, floored at 0 and rounded to cents. Feeds the "Received to
 *  date" line of the progress report on both the in-app billing page and the print
 *  layout, so the two can't drift. `fin.collected` is all payments across the job;
 *  subtract this invoice's own amount_paid to get what came in on earlier draws. */
export function receivedBeforeThisInvoice(
  fin: JobProgressFinancials,
  amountPaid: number | string | null | undefined,
): number {
  return Math.max(0, Math.round((fin.collected - Number(amountPaid ?? 0)) * 100) / 100);
}
