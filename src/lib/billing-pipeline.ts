import type { SupabaseClient } from "@supabase/supabase-js";
import { invoiceBalance } from "@/lib/invoice-math";
import { contractTotalFromQuotes, milestoneAmount, type Milestone } from "@/lib/payment-schedule-math";

/**
 * THE money pipeline: every job/invoice that needs a money action, in exactly one stage, so nothing
 * falls through. Stage 1 (done-not-invoiced) is the silent gap — a job marked complete with NO invoice
 * shows up nowhere else. Shared by the Billing board + the My Day money line (single source of truth).
 */
// `draw` marks a schedule job whose next action is "Request next payment" (milestone draw),
// NOT a standard invoice — the UI must route those to the job's payment schedule.
export type PipelineJob = { id: string; name: string | null; job_number: string | null; customer: string | null; value: number; draw?: boolean };
export type PipelineInvoice = {
  id: string; invoice_number: string | null; total: number; balance: number; status: string;
  due_date: string | null; customer: string | null; job: string | null; overdue: boolean;
};

export type MoneyPipeline = {
  doneNotInvoiced: PipelineJob[]; // complete jobs, no invoice (or un-drawn schedule draws) → BILL them
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
  const [invRes, jobRes, quoteRes, msRes] = await Promise.all([
    supabase.from("invoices").select("id, invoice_number, total, amount_paid, status, due_date, job_id, customers(name), jobs(name)"),
    // 'invoiced' is a RETIRED job status (the lifecycle rework moved every row off it), but
    // a stray legacy row could still carry it — keep it in the filter as stage-1 safety so
    // such a job can't escape the board (jobs with a real invoice are removed by the
    // invoicedJobIds filter below).
    supabase.from("jobs").select("id, name, job_number, customers(name)").in("status", ["complete", "invoiced"]).limit(500),
    supabase.from("quotes").select("job_id, total, status").not("job_id", "is", null).limit(1000),
    // Un-drawn payment-schedule milestones. "Unbilled" = no linked invoice — the same rule
    // as scheduleStatus (deleting a mistaken draft draw nulls the FK and re-offers it).
    supabase.from("payment_milestones").select("job_id, label, percent, amount, sort_order").is("invoice_id", null).limit(1000),
  ]);
  const invoices = (invRes.data ?? []) as any[];
  const completeJobs = (jobRes.data ?? []) as any[];
  const quotes = (quoteRes.data ?? []) as any[];
  const openMilestones = (msRes.data ?? []) as any[];

  // A job is "invoiced" if it has any non-void invoice.
  const invoicedJobIds = new Set(invoices.filter((i) => i.status !== "void" && i.job_id).map((i) => i.job_id as string));
  // Value an un-invoiced job by its biggest quote (best guess at what to bill)…
  const quoteByJob: Record<string, number> = {};
  // …and keep every quote per job for contract math (accepted preferred — contractTotalFromQuotes).
  const quotesByJob: Record<string, { total: number | null; status: string | null }[]> = {};
  for (const q of quotes) {
    const t = Number(q.total) || 0;
    if (!quoteByJob[q.job_id] || t > quoteByJob[q.job_id]) quoteByJob[q.job_id] = t;
    (quotesByJob[q.job_id] ??= []).push(q);
  }

  const doneNotInvoiced: PipelineJob[] = completeJobs
    .filter((j) => !invoicedJobIds.has(j.id))
    .map((j) => ({ id: j.id, name: j.name, job_number: j.job_number, customer: j.customers?.name ?? null, value: quoteByJob[j.id] ?? 0 }));

  // Partially-billed schedule jobs: a fixed-bid job that drew its deposit HAS an invoice, so
  // the no-invoice filter above skips it — yet most of the contract may never have been billed.
  // Surface each finished job's un-drawn milestones as a stage-1 entry so it can't fall out.
  const openMsByJob: Record<string, any[]> = {};
  for (const m of openMilestones) (openMsByJob[m.job_id] ??= []).push(m);
  for (const j of completeJobs) {
    if (!invoicedJobIds.has(j.id)) continue; // no invoice at all → already listed above at quote value
    const pending = (openMsByJob[j.id] ?? []).sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
    if (!pending.length) continue;
    const contract = contractTotalFromQuotes(quotesByJob[j.id] ?? []);
    const value = pending.reduce((s, m) => s + milestoneAmount(m as Milestone, contract), 0);
    // Label the remaining draw(s) so the row reads as "what to bill", e.g. "Final payment — Panel swap".
    const drawLabel = pending.length === 1 ? pending[0].label || "Next draw" : `${pending.length} draws left`;
    const jobName = j.name ?? j.job_number;
    doneNotInvoiced.push({
      id: j.id,
      name: jobName ? `${drawLabel} — ${jobName}` : drawLabel,
      job_number: j.job_number,
      customer: j.customers?.name ?? null,
      value,
      draw: true,
    });
  }

  const toInv = (i: any, overdue: boolean): PipelineInvoice => ({
    id: i.id, invoice_number: i.invoice_number, total: Number(i.total) || 0,
    balance: invoiceBalance(i.total, i.amount_paid), status: i.status,
    due_date: i.due_date, customer: i.customers?.name ?? null, job: i.jobs?.name ?? null, overdue,
  });

  const drafts = invoices.filter((i) => i.status === "draft").map((i) => toInv(i, false));
  const unpaid = invoices
    .filter((i) => !["draft", "paid", "void"].includes(i.status) && invoiceBalance(i.total, i.amount_paid) > 0.005)
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
