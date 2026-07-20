import { invoiceBalance } from "@/lib/invoice-math";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

/**
 * Money metrics shared by /analytics AND Nort's ar_aging / revenue_trend / quote_win_rate tools —
 * ONE implementation each, lifted verbatim from the /analytics page so the dashboard and what Nort
 * says can never diverge. Pure compute + a thin org-scoped fetch wrapper per metric.
 *
 * CLOCK DISCIPLINE: every "which day/month is it" question here runs on the ORG's timezone
 * (todayYmd/tz params), never the server's UTC Date methods — the same rule as /payments'
 * month tile and billing-pipeline's overdue check. A server-local boundary called a due-today
 * invoice "late" from 5 PM Pacific the night before, and put a June-30-evening payment in July.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "YYYY-MM-DD" out of a DATE column or ISO timestamp (null passes through). */
const ymdOf = (v: string | null | undefined): string | null => {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Whole days from `fromYmd` to `toYmd` (positive when `toYmd` is later). */
const daysBetweenYmd = (fromYmd: string, toYmd: string): number =>
  Math.round((new Date(`${toYmd}T00:00:00Z`).getTime() - new Date(`${fromYmd}T00:00:00Z`).getTime()) / 86_400_000);

/** The org's timezone + org-local today — the fetch wrappers' shared clock. */
async function orgClock(supabase: any): Promise<{ tz: string; todayYmd: string }> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone;
  return { tz, todayYmd: todayStrInTz(tz) };
}

// ── A/R aging ───────────────────────────────────────────────────────────────
export type ArBuckets = { current: number; d30: number; d60: number; d90: number };
export type ArInvoice = { id?: string | null; customer_id?: string | null; invoice_number: string | null; customer: string | null; balance: number; daysLate: number; bucket: keyof ArBuckets };
export type ArAging = { buckets: ArBuckets; outstanding: number; openCount: number; invoices: ArInvoice[] };

const OPEN_EXCLUDED = ["paid", "void", "draft"];
const bucketOf = (days: number): keyof ArBuckets => (days <= 0 ? "current" : days <= 30 ? "d30" : days <= 60 ? "d60" : "d90");

/**
 * `todayYmd` is the ORG-local today ("YYYY-MM-DD"). Lateness follows THE app-wide overdue rule
 * (billing-pipeline / Nort's list_invoices): an invoice is late iff it HAS a due date and that
 * date is before the org-local today — whole days, so a due-today invoice is NOT late until
 * tomorrow. An invoice with NO due date is never "late" (it sits in Not-yet-due but still counts
 * as outstanding). The old version fell back to created_at and compared UTC instants, so
 * /analytics called a dateless sent invoice "1–30 days late" while /billing's Overdue tile said $0.
 */
export function computeArAging(invoices: any[], todayYmd: string): ArAging {
  const open = (invoices ?? []).filter((i) => !OPEN_EXCLUDED.includes(i.status));
  const buckets: ArBuckets = { current: 0, d30: 0, d60: 0, d90: 0 };
  const rows: ArInvoice[] = [];
  for (const i of open) {
    const balance = invoiceBalance(i.total, i.amount_paid);
    if (balance <= 0) continue;
    const dueYmd = ymdOf(i.due_date);
    const daysLate = dueYmd ? Math.max(0, daysBetweenYmd(dueYmd, todayYmd)) : 0;
    const bucket = bucketOf(daysLate);
    buckets[bucket] += balance;
    rows.push({ id: i.id ?? null, customer_id: i.customer_id ?? null, invoice_number: i.invoice_number ?? null, customer: i.customers?.name ?? null, balance: round2(balance), daysLate, bucket });
  }
  const outstanding = buckets.current + buckets.d30 + buckets.d60 + buckets.d90;
  rows.sort((a, b) => b.daysLate - a.daysLate);
  return {
    buckets: { current: round2(buckets.current), d30: round2(buckets.d30), d60: round2(buckets.d60), d90: round2(buckets.d90) },
    outstanding: round2(outstanding),
    openCount: open.length,
    invoices: rows,
  };
}

// ── Job billing status (the /jobs completed-row tag) ─────────────────────────
export type JobBillingStatus = "to_be_invoiced" | "pending" | "partial" | "paid_in_full";

export const JOB_BILLING_STATUS_LABEL: Record<JobBillingStatus, string> = {
  to_be_invoiced: "To Be Invoiced",
  pending: "Pending",
  partial: "Partial",
  paid_in_full: "Paid In Full",
};

/** The invoice fields the tag needs — amount_paid is THE rolled-up payments figure
 *  (recalcTotals keeps it in sync with the payments table), the same field AR reads. */
export type JobBillingInvoice = { status: string; total?: number | null; amount_paid?: number | null };

/**
 * ONE definition of "where does this job's money stand", shared by the /jobs
 * completed list and anything else that tags a job — built ON the AR pieces
 * (invoiceBalance + the same status vocabulary computeArAging reads) so the tag
 * and /billing/ar can never disagree. Rules, in precedence order:
 *
 *  1. "to_be_invoiced" — no non-draft/non-void invoice exists. A draft-ONLY job
 *     counts here: the finish-job flow parks its auto-invoice as a draft in the
 *     "To be invoiced" queue (org-settings auto_send_invoice_on_complete), so a
 *     held draft is not-yet-invoiced by THE app's own vocabulary.
 *  2. "paid_in_full" — nothing owed on ANY live (non-void) invoice, cents-tolerant.
 *     Live DRAFTS count in this gate: a paid deposit + a drafted final draw is NOT
 *     settled — billing isn't finished — so it reads "partial", never "paid_in_full"
 *     (exactly the job getMoneyPipeline would still show in its drafts stage).
 *  3. "partial" — money in (any payment recorded on a billed invoice) but not all.
 *  4. "pending" — billed (sent/partial/overdue), nothing paid yet. Overdue is an AR
 *     concern (aging lives on /billing/ar); here it still reads "pending"/"partial".
 */
export function jobBillingStatus(invoices: JobBillingInvoice[]): JobBillingStatus {
  const live = (invoices ?? []).filter((i) => i.status !== "void");
  const billed = live.filter((i) => i.status !== "draft");
  if (billed.length === 0) return "to_be_invoiced";
  const owed = live.reduce((s, i) => s + invoiceBalance(i.total, i.amount_paid), 0);
  if (owed <= 0.005) return "paid_in_full";
  const paid = billed.reduce((s, i) => {
    const n = Number(i.amount_paid);
    return s + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  return paid > 0.005 ? "partial" : "pending";
}

// ── A/R by customer (WHO owes, rolled up) ────────────────────────────────────
export type ArCustomer = { customer: string; balance: number; worstDaysLate: number; invoices: ArInvoice[] };

/** Group the aging rows by customer — the "Accounts Receivable" ledger view: one line per
 *  customer with their total open balance, worst lateness first. Pure transform over
 *  computeArAging's output so the two can never disagree. */
export function computeArByCustomer(aging: ArAging): ArCustomer[] {
  const byKey = new Map<string, ArCustomer>();
  for (const r of aging.invoices) {
    const key = r.customer_id ?? r.customer ?? "—";
    const entry = byKey.get(key) ?? { customer: r.customer ?? "No customer", balance: 0, worstDaysLate: 0, invoices: [] };
    entry.balance = round2(entry.balance + r.balance);
    entry.worstDaysLate = Math.max(entry.worstDaysLate, r.daysLate);
    entry.invoices.push(r);
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => b.worstDaysLate - a.worstDaysLate || b.balance - a.balance);
}

// ── Revenue trend (collected by month, last 12) ──────────────────────────────
export type RevPoint = { month: string; collected: number };
export type RevenueTrend = { series: RevPoint[]; maxRev: number; collected12: number; best: RevPoint | null; worst: RevPoint | null };

/** The month ("YYYY-MM") an instant falls in, in the ORG's timezone — the /payments-page rule
 *  (cn-v508 class): a payment recorded 6 PM Pacific on June 30 is a JUNE payment, even though
 *  its UTC timestamp already says July 1. */
export const monthKeyInTz = (at: string | Date, tz: string): string => todayStrInTz(tz, typeof at === "string" ? new Date(at) : at).slice(0, 7);

/** The 12 wall-month keys ending in `todayYmd`'s month (oldest first) — shared so the fetch
 *  window and the buckets always agree. Month arithmetic is day-1-pinned (Date.UTC), so calling
 *  this on the 31st can never overflow into the wrong month (May 31 − 11 months is JUNE 1, not
 *  the July 1 that `setMonth` overflow produced). */
export function trailing12Months(todayYmd: string): string[] {
  const [y, m] = todayYmd.split("-").map(Number);
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** `todayYmd` = org-local today; `tz` = the org's IANA timezone (payments bucket by ORG month). */
export function computeRevenueTrend(payments: any[], refunds: any[], todayYmd: string, tz: string): RevenueTrend {
  const months = trailing12Months(todayYmd);
  const byMonth = new Map<string, number>(months.map((m) => [m, 0]));
  for (const p of payments ?? []) {
    if (p.invoices?.status === "void") continue; // voided invoice → money reversed, don't count
    const k = monthKeyInTz(p.paid_at, tz);
    if (byMonth.has(k)) byMonth.set(k, byMonth.get(k)! + Number(p.amount));
  }
  const refunds12 = (refunds ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const series = months.map((m) => ({ month: m, collected: round2(byMonth.get(m) ?? 0) }));
  const maxRev = Math.max(1, ...series.map((p) => p.collected));
  const collected12 = round2(series.reduce((s, p) => s + p.collected, 0) - refunds12);
  const gross = series.reduce((s, p) => s + p.collected, 0);
  const sorted = [...series].sort((a, b) => b.collected - a.collected);
  // best/worst only mean something once there's revenue — otherwise it'd report "best month: $0".
  const best = gross > 0 ? sorted[0] : null;
  const worst = gross > 0 ? sorted[sorted.length - 1] : null;
  return { series, maxRev, collected12, best, worst };
}

// ── Quote win rate & pipeline ────────────────────────────────────────────────
export type QuoteStats = { won: number; lost: number; awaiting: number; draft: number; decided: number; winRatePct: number | null; pipelineValue: number };

export function computeQuoteStats(quotes: any[]): QuoteStats {
  let accepted = 0, declined = 0, expired = 0, sent = 0, draft = 0, pipeline = 0;
  for (const x of quotes ?? []) {
    if (x.status === "accepted") accepted++;
    else if (x.status === "declined") declined++;
    else if (x.status === "expired") expired++;
    else if (x.status === "sent") { sent++; pipeline += Number(x.total); }
    else draft++;
  }
  const decided = accepted + declined + expired;
  return {
    won: accepted,
    lost: declined + expired,
    awaiting: sent,
    draft,
    decided,
    winRatePct: decided > 0 ? Math.round((accepted / decided) * 100) : null,
    pipelineValue: round2(pipeline),
  };
}

// ── Org-scoped fetch wrappers (for Nort's tools; the caller's RLS scopes the org) ────
export async function getArAging(supabase: any): Promise<ArAging> {
  const [{ data }, { todayYmd }] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, customer_id, invoice_number, status, total, amount_paid, due_date, created_at, customers(name)"),
    orgClock(supabase),
  ]);
  return computeArAging(data ?? [], todayYmd);
}

export async function getRevenueTrend(supabase: any, now: Date = new Date()): Promise<RevenueTrend> {
  const { tz } = await orgClock(supabase);
  const todayYmd = todayStrInTz(tz, now);
  // Fetch from org-local midnight on the 1st of the window's OLDEST month, so the
  // window and the buckets agree to the instant.
  const start = tzDayStartUtc(`${trailing12Months(todayYmd)[0]}-01`, tz);
  const [{ data: payments }, { data: refunds }] = await Promise.all([
    supabase.from("payments").select("amount, paid_at, invoices(status)").gte("paid_at", start.toISOString()),
    supabase.from("customer_credits").select("amount").eq("disposition", "refund").gte("created_at", start.toISOString()),
  ]);
  return computeRevenueTrend(payments ?? [], refunds ?? [], todayYmd, tz);
}

export async function getQuoteStats(supabase: any): Promise<QuoteStats> {
  const { data } = await supabase.from("quotes").select("status, total");
  return computeQuoteStats(data ?? []);
}

// ── Customer value (lifetime collected + jobs, best first) ────────────────────
export type CustomerValue = { customer: string; collected: number; jobs: number; lastPaid: string | null };

/** Pure — lifetime CASH collected per customer (payments net of void invoices) + job count. */
export function computeCustomerValue(
  payments: any[],
  jobCountByCustomer: Map<string, number>,
  nameById: Map<string, string>,
): CustomerValue[] {
  const byCust = new Map<string, { collected: number; lastPaid: string | null }>();
  for (const p of payments ?? []) {
    const inv = p.invoices;
    const cid = inv?.customer_id;
    if (!cid || inv?.status === "void") continue; // voided invoice → money reversed
    const g = byCust.get(cid) ?? { collected: 0, lastPaid: null };
    g.collected += Number(p.amount);
    if (p.paid_at && (!g.lastPaid || p.paid_at > g.lastPaid)) g.lastPaid = p.paid_at;
    byCust.set(cid, g);
  }
  return [...byCust.entries()]
    .map(([cid, g]) => ({
      customer: nameById.get(cid) ?? "Unknown",
      collected: round2(g.collected),
      jobs: jobCountByCustomer.get(cid) ?? 0,
      lastPaid: g.lastPaid,
    }))
    .sort((a, b) => b.collected - a.collected);
}

export async function getCustomerValue(supabase: any, limit = 15): Promise<CustomerValue[]> {
  const [{ data: payments }, { data: jobs }, { data: customers }] = await Promise.all([
    supabase.from("payments").select("amount, paid_at, invoices(customer_id, status)"),
    supabase.from("jobs").select("customer_id"),
    supabase.from("customers").select("id, name"),
  ]);
  const jobCount = new Map<string, number>();
  for (const j of (jobs ?? []) as any[]) if (j.customer_id) jobCount.set(j.customer_id, (jobCount.get(j.customer_id) ?? 0) + 1);
  const nameById = new Map<string, string>();
  for (const c of (customers ?? []) as any[]) nameById.set(c.id, c.name);
  return computeCustomerValue(payments ?? [], jobCount, nameById).slice(0, Math.min(40, Math.max(1, limit)));
}
