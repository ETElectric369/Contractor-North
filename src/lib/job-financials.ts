import { getOrgSettings } from "@/lib/org-settings";
import { computeJobLaborBilling, fetchJobLaborRows } from "@/lib/labor-billing";
import { computeJobProgress, type JobProgressFinancials } from "@/lib/job-progress-math";

export type { JobProgressFinancials };

/** Compute a job's progress-billing financials — the numbers behind the progress
 *  report summary on a deposit/progress/final draw. Fetches the rows, then rolls
 *  them up via the pure computeJobProgress() so the panel's "work to date" equals
 *  the sum of the lines importLaborIntoInvoice / importCostsIntoInvoice actually
 *  bill (labor at charge rate via computeJobLaborBilling, materials per-row markup). */
export async function jobProgressFinancials(supabase: any, jobId: string): Promise<JobProgressFinancials> {
  const [{ data: job }, { data: quotes }, { data: invoices }, labor, { data: pos }, { data: bills }, { data: org }] =
    await Promise.all([
      supabase.from("jobs").select("billing_type").eq("id", jobId).maybeSingle(),
      supabase.from("quotes").select("total, status").eq("job_id", jobId),
      supabase.from("invoices").select("total, status, amount_paid").eq("job_id", jobId),
      fetchJobLaborRows(supabase, jobId),
      supabase.from("purchase_orders").select("total").eq("job_id", jobId),
      supabase.from("bills").select("amount").eq("job_id", jobId),
      supabase.from("organizations").select("settings").maybeSingle(),
    ]);

  // Labor: the exact helper importLaborIntoInvoice uses (per-person, quarter-hour,
  // default-rate fallback) — so the panel can't diverge from the billed lines.
  const defaultRate = getOrgSettings((org as any)?.settings).default_labor_rate; // via the settings SSOT
  const { total: billableLabor } = computeJobLaborBilling(labor.jobEntries, labor.jobAllocs, defaultRate);

  return computeJobProgress({
    billingTypeRaw: (job as any)?.billing_type,
    quotes: (quotes ?? []) as any,
    invoices: (invoices ?? []) as any,
    billableLabor,
    pos: (pos ?? []) as any,
    bills: (bills ?? []) as any,
    markupPercent: getOrgSettings((org as any)?.settings).material_markup_percent,
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
