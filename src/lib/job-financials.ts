import { getOrgSettings } from "@/lib/org-settings";
import { computeJobLaborBilling, customerLaborRateForJob, customerMaterialMarkupForJob, fetchJobLaborRows } from "@/lib/labor-billing";
import { billedWorkOnInvoices, computeJobProgress, type JobProgressFinancials } from "@/lib/job-progress-math";
import { readJobBillsWithLines, unbilledWorkForJob } from "@/lib/unbilled-work";
import { readJobStock } from "@/lib/stock-billing";

export type { JobProgressFinancials };

/** Compute a job's progress-billing financials — the numbers behind the progress
 *  report summary on a deposit/progress/final draw. Fetches the rows, then rolls
 *  them up via the pure computeJobProgress() so the panel's "work to date" equals
 *  the sum of the lines importLaborIntoInvoice / importCostsIntoInvoice actually
 *  bill (labor at charge rate via computeJobLaborBilling, materials per-row markup). */
export async function jobProgressFinancials(
  supabase: any,
  jobId: string,
  /**
   * THE SERVICE ROLE PINS ITS OWN ORG (the customer's /i link and portal bill, through
   * readInvoiceDocumentProps). RLS narrows a signed-in caller; the service role reads every org, so
   * each read below is then pinned to this org by hand (the job, its quotes, invoices, orders,
   * receipts, hours and rates, and the organization by id: the old "the organization" read with
   * maybeSingle would find every org and fall back to the default labor rate). The rates come from
   * customerRateRow (fetchJobLaborRows' service path), never a pay figure.
   */
  scope?: { orgId: string },
): Promise<JobProgressFinancials> {
  const orgId = scope?.orgId ?? null;
  const pin = (q: any) => (orgId ? q.eq("org_id", orgId) : q);
  const [jobRead, quotesRead, invoicesRead, labor, posRead, billsRead, orgRead, stock] =
    await Promise.all([
      pin(supabase.from("jobs").select("billing_type").eq("id", jobId)).maybeSingle(),
      pin(supabase.from("quotes").select("total, status, created_at").eq("job_id", jobId)),
      pin(supabase.from("invoices").select("total, status, amount_paid").eq("job_id", jobId)),
      fetchJobLaborRows(supabase, jobId, scope),
      // id + status + po_id feed the shared live-PO rule (a draft/cancelled order isn't a
      // cost, and a PO already paid by a bill is superseded by it — see livePurchaseOrders).
      pin(supabase.from("purchase_orders").select("id, total, status").eq("job_id", jobId)),
      // The job's live receipts WITH their lines, through the ONE reader the Unbilled card uses
      // (readJobBillsWithLines): a receipt counts for what it BILLS, and this panel's whole promise
      // is that its work-to-date equals the lines importCostsIntoInvoice writes. Selecting only
      // `amount` here is what put Erik's snacks, marked up, into the figure a draw is measured
      // against - the projection law, on the read that decides the reference number.
      readJobBillsWithLines(supabase, jobId, scope),
      orgId
        ? supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle()
        : supabase.from("organizations").select("settings").maybeSingle(),
      // The pieces taken from stock onto the job, billed or not (Shop Stock, Phase 3): a fixed-price
      // job's work to date is everything worked. Staff through RLS, the service role pinned to its
      // org; a lost read throws like the receipts. (Time & Material reads them through
      // tmWorkToDate: a billed take is its invoice line, an open one is in unbilledWorkForJob.)
      readJobStock(supabase, jobId, scope),
    ]);

  // A LOST READ IS NOT AN EMPTY ONE (audit v1018 money-1). Every figure below is printed on a
  // customer's bill: a failed invoices read reads as "Received to date $0.00", a failed job read as a
  // fixed-price contract on a Time & Material job, a failed quotes read as no estimate. So each read
  // throws, as the receipts and stock reads already did, and every caller leaves the Progress
  // Summary off and says so (readInvoiceDocumentProps marks it degraded: the print page refuses and
  // stores nothing, /i and the portal say part of the bill couldn't load).
  for (const r of [jobRead, quotesRead, invoicesRead, posRead, orgRead, billsRead]) if (r.error) throw r.error;
  const job = jobRead.data;
  const org = orgRead.data;
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

  // TIME & MATERIAL: work to date is what was billed at the price billed, plus what the next bill
  // would charge (billedWorkOnInvoices). A failed read throws: a work-to-date missing half its
  // lines is a figure nobody billed. Fixed price keeps the contract roll-up below.
  const tmWork = (job as any)?.billing_type === "tm" ? await tmWorkToDate(supabase, jobId, scope) : null;

  return computeJobProgress({
    billingTypeRaw: (job as any)?.billing_type,
    quotes: (quotesRead.data ?? []) as any,
    invoices: (invoicesRead.data ?? []) as any,
    billableLabor,
    pos: (posRead.data ?? []) as any,
    bills: billsRead.data as any,
    markupPercent,
    tmWork,
    stockTakes: stock.takes,
  });
}

/**
 * A TIME & MATERIAL JOB'S WORK TO DATE, IN ITS TWO HALVES: the work lines on its non-void invoices
 * at the price they were billed (billedWorkOnInvoices) and the work no invoice holds yet, priced as
 * the next bill would price it (unbilledWorkForJob). The one reader behind jobProgressFinancials
 * (the Progress Summary on the PDF, /i and the portal, and Nort's job numbers) and the job page's
 * Work To Date, so they cannot disagree. Throws on a failed read, never reports a half.
 */
export async function tmWorkToDate(
  supabase: any,
  jobId: string,
  /** The service role: pin the reads to this org by hand (see jobProgressFinancials). */
  scope?: { orgId: string },
): Promise<{ billed: number; unbilled: number }> {
  let q = supabase
    .from("invoices")
    .select("status, invoice_kind, invoice_items(import_source, line_kind, unit, description, line_total)")
    .eq("job_id", jobId)
    .neq("status", "void");
  if (scope?.orgId) q = q.eq("org_id", scope.orgId);
  const [{ data, error }, unbilled] = await Promise.all([q, unbilledWorkForJob(supabase, jobId, scope)]);
  if (error) throw error;
  // Before 0255 no labor line says which hours it holds, so every hour would read as unbilled AND
  // sit on a billed line: the same work twice. Say so rather than show it.
  if (!unbilled.schemaReady) throw new Error("tmWorkToDate: labor claims unknown (0255 not applied)");
  return { billed: billedWorkOnInvoices(data ?? []), unbilled: unbilled.total };
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
