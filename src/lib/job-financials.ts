import { hoursBetween } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";

export type JobProgressFinancials = {
  /** Sum of the job's quotes — the agreed estimate (a cap on fixed-price, a
   *  reference on Time & Material). */
  estimate: number;
  /** Billable work to date: labor at charge (bill) rate + materials with markup. */
  workToDate: number;
  /** Invoices actually sent to the customer (non-void, non-draft). */
  invoiced: number;
  /** Cash collected on the job (sum of payments on non-void invoices). */
  collected: number;
  /** "fixed" (estimate is a contract cap) or "tm" (estimate is a reference). */
  billingType: "fixed" | "tm";
};

/** Compute a job's progress-billing financials — the numbers behind the progress
 *  report summary that rides on a deposit/progress/final draw. Mirrors the job
 *  page's costing so the two never disagree. */
export async function jobProgressFinancials(supabase: any, jobId: string): Promise<JobProgressFinancials> {
  const [{ data: job }, { data: quotes }, { data: invoices }, { data: entries }, { data: pos }, { data: bills }, { data: org }] =
    await Promise.all([
      supabase.from("jobs").select("billing_type").eq("id", jobId).maybeSingle(),
      supabase.from("quotes").select("total").eq("job_id", jobId),
      supabase.from("invoices").select("total, status, amount_paid").eq("job_id", jobId),
      supabase
        .from("time_entries")
        .select("clock_in, clock_out, lunch_minutes, status, profiles(hourly_rate, bill_rate), time_allocations(hours)")
        .eq("job_id", jobId),
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

  let billableLabor = 0;
  for (const e of entries ?? []) {
    const billRate = Number((e as any).profiles?.bill_rate ?? (e as any).profiles?.hourly_rate ?? 0);
    if ((e as any).time_allocations?.length) {
      for (const a of (e as any).time_allocations) billableLabor += Number(a.hours ?? 0) * billRate;
      continue;
    }
    if (e.status === "closed" && e.clock_out) {
      billableLabor += hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) * billRate;
    }
  }
  const materialCost =
    (pos ?? []).reduce((s: number, p: any) => s + Number(p.total ?? 0), 0) +
    (bills ?? []).reduce((s: number, b: any) => s + Number(b.amount ?? 0), 0);
  const markup = getOrgSettings((org as any)?.settings).material_markup_percent;
  const workToDate = Math.round((billableLabor + materialCost * (1 + markup / 100)) * 100) / 100;

  return { estimate, workToDate, invoiced, collected, billingType };
}
