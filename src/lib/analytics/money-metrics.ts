import { invoiceBalance } from "@/lib/invoice-math";

/**
 * Money metrics shared by /analytics AND Nort's ar_aging / revenue_trend / quote_win_rate tools —
 * ONE implementation each, lifted verbatim from the /analytics page so the dashboard and what Nort
 * says can never diverge. Pure compute + a thin org-scoped fetch wrapper per metric.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── A/R aging ───────────────────────────────────────────────────────────────
export type ArBuckets = { current: number; d30: number; d60: number; d90: number };
export type ArInvoice = { invoice_number: string | null; customer: string | null; balance: number; daysLate: number; bucket: keyof ArBuckets };
export type ArAging = { buckets: ArBuckets; outstanding: number; openCount: number; invoices: ArInvoice[] };

const OPEN_EXCLUDED = ["paid", "void", "draft"];
const bucketOf = (days: number): keyof ArBuckets => (days <= 0 ? "current" : days <= 30 ? "d30" : days <= 60 ? "d60" : "d90");

export function computeArAging(invoices: any[], nowMs: number): ArAging {
  const open = (invoices ?? []).filter((i) => !OPEN_EXCLUDED.includes(i.status));
  const buckets: ArBuckets = { current: 0, d30: 0, d60: 0, d90: 0 };
  const rows: ArInvoice[] = [];
  for (const i of open) {
    const balance = invoiceBalance(i.total, i.amount_paid);
    if (balance <= 0) continue;
    const ref = i.due_date ? new Date(i.due_date).getTime() : new Date(i.created_at).getTime();
    const days = (nowMs - ref) / 86_400_000;
    const bucket = bucketOf(days);
    buckets[bucket] += balance;
    rows.push({ invoice_number: i.invoice_number ?? null, customer: i.customers?.name ?? null, balance: round2(balance), daysLate: Math.max(0, Math.floor(days)), bucket });
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

// ── Revenue trend (collected by month, last 12) ──────────────────────────────
export type RevPoint = { month: string; collected: number };
export type RevenueTrend = { series: RevPoint[]; maxRev: number; collected12: number; best: RevPoint | null; worst: RevPoint | null };

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** The 12 wall-month keys ending in `now`'s month (oldest first) — shared so the fetch window and
 *  the buckets always agree. */
export function trailing12Months(now: Date): string[] {
  const start = new Date(now);
  start.setMonth(start.getMonth() - 11);
  start.setDate(1);
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + i);
    out.push(monthKey(d));
  }
  return out;
}

export function computeRevenueTrend(payments: any[], refunds: any[], now: Date): RevenueTrend {
  const months = trailing12Months(now);
  const byMonth = new Map<string, number>(months.map((m) => [m, 0]));
  for (const p of payments ?? []) {
    if (p.invoices?.status === "void") continue; // voided invoice → money reversed, don't count
    const k = monthKey(new Date(p.paid_at));
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
  const { data } = await supabase
    .from("invoices")
    .select("invoice_number, status, total, amount_paid, due_date, created_at, customers(name)");
  return computeArAging(data ?? [], Date.now());
}

export async function getRevenueTrend(supabase: any, now: Date = new Date()): Promise<RevenueTrend> {
  const start = new Date(now);
  start.setMonth(start.getMonth() - 11);
  start.setDate(1);
  const [{ data: payments }, { data: refunds }] = await Promise.all([
    supabase.from("payments").select("amount, paid_at, invoices(status)").gte("paid_at", start.toISOString()),
    supabase.from("customer_credits").select("amount").eq("disposition", "refund").gte("created_at", start.toISOString()),
  ]);
  return computeRevenueTrend(payments ?? [], refunds ?? [], now);
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
