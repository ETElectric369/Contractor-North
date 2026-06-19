import { getOrgSettings } from "@/lib/org-settings";
import { computeJobLaborBilling, fetchJobLaborRows } from "@/lib/labor-billing";

export type JobProgressFinancials = {
  /** Sum of the job's quotes — the agreed estimate (a cap on fixed-price, a
   *  reference on Time & Material). */
  estimate: number;
  /** Billable work to date: labor at charge (bill) rate + materials with markup.
   *  Computed the SAME way importLabor/importCosts bill, so it reconciles to the
   *  penny with the labor/material lines that actually land on the invoice. */
  workToDate: number;
  /** Invoices actually sent to the customer (non-void, non-draft). */
  invoiced: number;
  /** Cash collected on the job (sum of payments on non-void invoices). */
  collected: number;
  /** "fixed" (estimate is a contract cap) or "tm" (estimate is a reference). */
  billingType: "fixed" | "tm";
};

/** Compute a job's progress-billing financials — the numbers behind the progress
 *  report summary on a deposit/progress/final draw. Uses the SAME shared
 *  computations as importLaborIntoInvoice / importCostsIntoInvoice so the panel's
 *  "work to date" equals the sum of the lines that get billed. */
export async function jobProgressFinancials(supabase: any, jobId: string): Promise<JobProgressFinancials> {
  const [{ data: job }, { data: quotes }, { data: invoices }, labor, { data: pos }, { data: bills }, { data: org }] =
    await Promise.all([
      supabase.from("jobs").select("billing_type").eq("id", jobId).maybeSingle(),
      supabase.from("quotes").select("total").eq("job_id", jobId),
      supabase.from("invoices").select("total, status, amount_paid").eq("job_id", jobId),
      fetchJobLaborRows(supabase, jobId),
      supabase.from("purchase_orders").select("total").eq("job_id", jobId),
      supabase.from("bills").select("amount").eq("job_id", jobId),
      supabase.from("organizations").select("settings").maybeSingle(),
    ]);
  const billingType: "fixed" | "tm" = (job as any)?.billing_type === "tm" ? "tm" : "fixed";

  const estimate = (quotes ?? []).reduce((s: number, q: any) => s + Number(q.total ?? 0), 0);
  const invoiced = (invoices ?? []).reduce(
    (s: number, i: any) => (i.status !== "void" && i.status !== "draft" ? s + Number(i.total ?? 0) : s),
    0,
  );
  const collected = (invoices ?? []).reduce(
    (s: number, i: any) => (i.status !== "void" ? s + Number(i.amount_paid ?? 0) : s),
    0,
  );

  // Labor: the exact helper importLaborIntoInvoice uses (per-person, quarter-hour,
  // default-rate fallback) — so the panel can't diverge from the billed lines.
  const defaultRate = Number(((org as any)?.settings ?? {}).default_labor_rate ?? 0);
  const { total: billableLabor } = computeJobLaborBilling(labor.jobEntries, labor.jobAllocs, defaultRate);

  // Materials: marked up PER ROW exactly like importCostsIntoInvoice (cost > 0 only).
  const markup = getOrgSettings((org as any)?.settings).material_markup_percent;
  const mk = (cost: number) => Math.round(cost * (1 + markup / 100) * 100) / 100;
  const billableMaterials =
    (pos ?? []).reduce((s: number, p: any) => (Number(p.total ?? 0) > 0 ? s + mk(Number(p.total)) : s), 0) +
    (bills ?? []).reduce((s: number, b: any) => (Number(b.amount ?? 0) > 0 ? s + mk(Number(b.amount)) : s), 0);
  const workToDate = Math.round((billableLabor + billableMaterials) * 100) / 100;

  return { estimate, workToDate, invoiced, collected, billingType };
}
