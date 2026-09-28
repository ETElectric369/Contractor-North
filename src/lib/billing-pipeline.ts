import type { SupabaseClient } from "@supabase/supabase-js";
import { invoiceBalance } from "@/lib/invoice-math";
import { contractTotalFromQuotes, milestoneAmount, type Milestone } from "@/lib/payment-schedule-math";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { daysBetweenYmd } from "@/lib/analytics/money-metrics";

/** Org-local "today" (YYYY-MM-DD) — THE date the overdue rule compares due_date against.
 *  A UTC "today" flags a due-today invoice overdue after ~5 PM Pacific, so every overdue
 *  surface (this pipeline, Nort's list_invoices/get_invoice, reminder emails) must derive
 *  today from the ORG's timezone. Exported so the mirrors call this instead of re-fixing
 *  the timezone locally. */
export async function orgTodayStr(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return todayStrInTz(getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone);
}

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
  /** amount_paid, so a row can say what its balance is due against (invoiceAmount). */
  paid: number;
  /** Whole days past its due date, org-local (daysBetweenYmd, the aging's own arithmetic); 0 when
   *  not late. What the Invoices page's red "N Days Late" chip and its By Customer fold say. */
  daysLate: number;
  /** Whose it is, so By Customer never folds two customers who share a name into one. */
  customerId: string | null;
};

/** "1 Day Late", "12 Days Late": the chip on a late row. */
export const daysLateWords = (n: number): string => `${n} ${n === 1 ? "Day" : "Days"} Late`;

/** One customer with money open: what they owe, their worst lateness, and the invoices under them. */
export type OwedByCustomer = { key: string; customer: string; balance: number; worstDaysLate: number; invoices: PipelineInvoice[] };

/**
 * WHO OWES, ROLLED UP (the Accounts Receivable page, folded into Invoices, W1-29): the pipeline's own
 * open invoices grouped by customer, worst lateness first, then the most owed. One read, one total:
 * the balances here add up to the page's Owed To You to the cent. Pure.
 */
export function owedByCustomer(unpaid: readonly PipelineInvoice[]): OwedByCustomer[] {
  const by = new Map<string, OwedByCustomer>();
  for (const i of unpaid) {
    const key = i.customerId ?? `name:${i.customer ?? ""}`;
    const g = by.get(key) ?? { key, customer: i.customer ?? "No customer", balance: 0, worstDaysLate: 0, invoices: [] };
    g.balance = Math.round((g.balance + i.balance) * 100) / 100;
    g.worstDaysLate = Math.max(g.worstDaysLate, i.daysLate);
    g.invoices.push(i);
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.worstDaysLate - a.worstDaysLate || b.balance - a.balance || a.customer.localeCompare(b.customer));
}

/** THE OWED BAR's pieces, by lateness (current, then 1-30, 31-60 and over 60 days late), in dollars. */
export function owedByLateness(unpaid: readonly PipelineInvoice[]): { current: number; d30: number; d60: number; d90: number } {
  const out = { current: 0, d30: 0, d60: 0, d90: 0 };
  for (const i of unpaid) {
    const k = i.daysLate <= 0 ? "current" : i.daysLate <= 30 ? "d30" : i.daysLate <= 60 ? "d60" : "d90";
    out[k] = Math.round((out[k] + i.balance) * 100) / 100;
  }
  return out;
}

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
  const [today, invRes, jobRes, quoteRes, msRes] = await Promise.all([
    orgTodayStr(supabase),
    // Bounded like its siblings (audit v921): an unbounded select truncates silently at
    // PostgREST's 1000-row max, and invoicedJobIds below is built from whatever survived —
    // past that cliff a job whose invoice fell outside the window reappears in "Done - Not
    // Invoiced" and the Outstanding/Overdue tiles undercount.
    supabase.from("invoices").select("id, invoice_number, total, amount_paid, status, due_date, job_id, customer_id, customers(name), jobs(name)").limit(50000),
    // 'invoiced' is a RETIRED job status (the lifecycle rework moved every row off it), but
    // a stray legacy row could still carry it — keep it in the filter as stage-1 safety so
    // such a job can't escape the board (jobs with a real invoice are removed by the
    // invoicedJobIds filter below).
    supabase.from("jobs").select("id, name, job_number, customers(name)").in("status", ["complete", "invoiced"]).limit(500),
    supabase.from("quotes").select("job_id, total, status, created_at").not("job_id", "is", null).limit(1000),
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
  // Keep every quote per job for contract math (accepted preferred — contractTotalFromQuotes).
  const quotesByJob: Record<string, { total: number | null; status: string | null; created_at: string | null }[]> = {};
  for (const q of quotes) {
    (quotesByJob[q.job_id] ??= []).push(q);
  }

  const doneNotInvoiced: PipelineJob[] = completeJobs
    .filter((j) => !invoicedJobIds.has(j.id))
    // ONE contract rule for both stage-1 branches (audit v921): this used to value the row at
    // the job's BIGGEST quote, so a $30k proposal the customer declined outbid the $4k one they
    // accepted, while the draw branch below already used contractTotalFromQuotes.
    .map((j) => ({ id: j.id, name: j.name, job_number: j.job_number, customer: j.customers?.name ?? null, value: contractTotalFromQuotes(quotesByJob[j.id] ?? []) }));

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
    paid: Number(i.amount_paid) || 0,
    // ONE RULE: overdue is a due date before the org's today, and how late is the same two days
    // counted the aging's way (a due-today invoice is neither).
    daysLate: overdue && i.due_date ? Math.max(0, daysBetweenYmd(String(i.due_date).slice(0, 10), today)) : 0,
    customerId: i.customer_id ?? null,
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
