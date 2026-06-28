import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * THE money pipeline: every job/invoice that needs a money action, in exactly one stage, so nothing
 * falls through. Stage 1 (done-not-invoiced) is the silent gap — a job marked complete with NO invoice
 * shows up nowhere else. Shared by the Billing board + the My Day money line (single source of truth).
 */
export type PipelineJob = { id: string; name: string | null; job_number: string | null; customer: string | null; value: number };
export type PipelineInvoice = {
  id: string; invoice_number: string | null; total: number; balance: number; status: string;
  due_date: string | null; customer: string | null; job: string | null; overdue: boolean;
};

export type MoneyPipeline = {
  doneNotInvoiced: PipelineJob[]; // complete jobs, no invoice → CREATE one
  drafts: PipelineInvoice[]; // draft invoices → REVIEW & SEND
  unpaid: PipelineInvoice[]; // sent/partial with a balance → RECORD PAYMENT (overdue flagged)
  toInvoiceTotal: number;
  draftTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  overdueCount: number;
};

export async function getMoneyPipeline(supabase: SupabaseClient): Promise<MoneyPipeline> {
  const today = new Date().toISOString().slice(0, 10);
  const [invRes, jobRes, quoteRes] = await Promise.all([
    supabase.from("invoices").select("id, invoice_number, total, amount_paid, status, due_date, job_id, customers(name), jobs(name)"),
    supabase.from("jobs").select("id, name, job_number, customers(name)").eq("status", "complete").limit(500),
    supabase.from("quotes").select("job_id, total").not("job_id", "is", null).limit(1000),
  ]);
  const invoices = (invRes.data ?? []) as any[];
  const completeJobs = (jobRes.data ?? []) as any[];
  const quotes = (quoteRes.data ?? []) as any[];

  // A job is "invoiced" if it has any non-void invoice.
  const invoicedJobIds = new Set(invoices.filter((i) => i.status !== "void" && i.job_id).map((i) => i.job_id as string));
  // Value an un-invoiced job by its biggest quote (best guess at what to bill).
  const quoteByJob: Record<string, number> = {};
  for (const q of quotes) {
    const t = Number(q.total) || 0;
    if (!quoteByJob[q.job_id] || t > quoteByJob[q.job_id]) quoteByJob[q.job_id] = t;
  }

  const doneNotInvoiced: PipelineJob[] = completeJobs
    .filter((j) => !invoicedJobIds.has(j.id))
    .map((j) => ({ id: j.id, name: j.name, job_number: j.job_number, customer: j.customers?.name ?? null, value: quoteByJob[j.id] ?? 0 }));

  const toInv = (i: any, overdue: boolean): PipelineInvoice => ({
    id: i.id, invoice_number: i.invoice_number, total: Number(i.total) || 0,
    balance: (Number(i.total) || 0) - (Number(i.amount_paid) || 0), status: i.status,
    due_date: i.due_date, customer: i.customers?.name ?? null, job: i.jobs?.name ?? null, overdue,
  });

  const drafts = invoices.filter((i) => i.status === "draft").map((i) => toInv(i, false));
  const unpaid = invoices
    .filter((i) => !["draft", "paid", "void"].includes(i.status) && (Number(i.total) || 0) - (Number(i.amount_paid) || 0) > 0.005)
    .map((i) => toInv(i, !!i.due_date && i.due_date < today))
    .sort((a, b) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1)); // overdue first

  const sum = (arr: { balance?: number; value?: number; total?: number }[], k: "balance" | "value" | "total") => arr.reduce((s, x: any) => s + (Number(x[k]) || 0), 0);

  return {
    doneNotInvoiced,
    drafts,
    unpaid,
    toInvoiceTotal: sum(doneNotInvoiced, "value"),
    draftTotal: sum(drafts, "total"),
    outstandingTotal: sum(unpaid, "balance"),
    overdueTotal: sum(unpaid.filter((i) => i.overdue), "balance"),
    overdueCount: unpaid.filter((i) => i.overdue).length,
  };
}
