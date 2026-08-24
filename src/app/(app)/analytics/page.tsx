import { attachRates, payRateMap } from "@/lib/profile-columns";
import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import Link from "next/link";
import { TrendingUp, Receipt, FileText, Wallet } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { formatCurrency } from "@/lib/utils";
import { computeJobProfitRows } from "@/lib/analytics/job-profitability";
import { computeArAging, computeRevenueTrend, computeQuoteStats, trailing12Months } from "@/lib/analytics/money-metrics";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

export const dynamic = "force-dynamic";

const monthLabel = (k: string) =>
  // k is "YYYY-MM" — a wall month; render in UTC so it never slips to the prior month.
  new Date(`${k}-15T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short" });

export default async function AnalyticsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  if (!me || !isStaffRole(me.role)) redirect("/planner");

  // The ORG's clock, not the server's UTC: month buckets, the 12-month fetch window,
  // and the overdue rule all derive from the org timezone (the /payments-page + billing-
  // pipeline discipline) — a UTC boundary put a June-30-evening Pacific payment in July
  // and called a due-today invoice late the night before.
  const { data: orgRow } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone;
  const todayYmd = todayStrInTz(tz);
  const windowStart = tzDayStartUtc(`${trailing12Months(todayYmd)[0]}-01`, tz).toISOString();

  const [{ data: payments }, { data: invoices }, { data: quotes }, { data: jobs }, { data: entries }, { data: pos }, { data: bills }, { data: refunds }, { data: jobRefunds }, { data: jobPayments }, { data: pettyCash }] =
    await Promise.all([
      supabase.from("payments").select("amount, paid_at, invoices(status)").gte("paid_at", windowStart).order("paid_at", { ascending: false }).limit(50000),
      // A/R aging reads the WHOLE book or it isn't aging (audit 9) — unbounded meant the 1000
      // newest, so the oldest unpaid invoices, which are exactly what aging is FOR, fell out.
      supabase.from("invoices").select("id, invoice_number, job_id, status, total, amount_paid, due_date, created_at, customers(name)").order("created_at", { ascending: false }).limit(50000),
      supabase.from("quotes").select("status, total").order("created_at", { ascending: false }).limit(50000),
      /**
       * .limit(50000) ON EVERY SIDE, NOT JUST THE CASH ONE (audit 8).
       *
       * Omitting .limit() does NOT mean "all rows" — PostgREST answers with its 1000-row
       * default and says nothing. Payments already carried an explicit high limit; jobs,
       * time entries, POs and bills did not, so past ~1000 closed time entries (three techs,
       * under a year) revenue was read WHOLE against a truncated slice of labor cost and
       * EVERY job looked more profitable than it is. Worse, with no ORDER BY the truncation
       * point isn't even stable — the same job could show two different margins on two loads.
       */
      supabase.from("jobs").select("id, job_number, name, status").order("created_at", { ascending: false }).limit(50000),
      supabase
        .from("time_entries")
        .select("job_id, clock_in, clock_out, lunch_minutes, status, rate_override, profiles(id), time_allocations(job_id, hours)")
        .eq("status", "closed")
        // NO job_id FILTER (audit 9): a clock-in with no job whose hours were SPLIT onto jobs via
        // allocations is real labor — the job page and Nort both cost it, and dropping it here
        // meant one job carried two different labor numbers depending on which screen you asked.
        // laborCostForJob already ignores entries that don't touch the job.
        .order("clock_in", { ascending: false })
        .limit(50000),
      // id + status + po_id feed computeJobProfitRows' shared live-PO rule: a draft/cancelled
      // order isn't a cost, and a PO paid by a bill is superseded by it (no double-charge).
      supabase.from("purchase_orders").select("id, job_id, total, status").limit(50000),
      supabase.from("bills").select("job_id, amount, category, po_id").limit(50000),
      // Cap BOTH sides of the trend (audit 9): bounding the payments that ADD money while leaving
      // the refunds that SUBTRACT it unbounded would overstate collected at exactly the volume
      // where the cap starts to bite.
      supabase.from("customer_credits").select("amount, created_at").eq("disposition", "refund").gte("created_at", windowStart).order("created_at", { ascending: false }).limit(50000),
      // Per-job refunds (all-time, with the invoice they reversed) so job profitability
      // nets refunds the SAME way the job hub does — keyed to a job via its invoice.
      supabase.from("customer_credits").select("amount, invoices(job_id)").eq("disposition", "refund").limit(50000),
      // Per-job CASH collected (all-time): the payments ledger with each payment's invoice
      // job + status, so job profitability sums real cash (net of void invoices) — THE
      // computeCollected definition — not invoices.amount_paid (which folds non-cash credits
      // in and so overstated a job's "collected"). .limit past PostgREST's 1000-row cap.
      supabase.from("payments").select("amount, invoices(job_id, status)").limit(50000),
      // PETTY CASH IS COST. This page builds its own ProfitInputs rather than going through
      // fetchProfitInputs, so it needs its own copy — which is exactly why `pettyCash` is a
      // REQUIRED field on the type: the compiler is what caught that this second caller existed.
      // Job-linked only; petty cash with no job is overhead, not a job's cost.
      supabase.from("petty_cash").select("job_id, amount, kind").not("job_id", "is", null).limit(50000),
    ]);

  // ── Money metrics — the SAME computations Nort's revenue_trend / ar_aging / quote_win_rate
  // tools call, so the dashboard and what Nort says can never diverge.
  const trend = computeRevenueTrend(payments ?? [], refunds ?? [], todayYmd, tz);
  const ar = computeArAging((invoices ?? []) as any[], todayYmd);
  const qs = computeQuoteStats((quotes ?? []) as any[]);

  // ── Job profitability ─────────────────────────────────────────────────────
  // The ONE allocation-aware computation (revenue = collected − refunds; cost = split-aware
  // labor + materials), now shared with the job hub AND Nort's get_job_financials /
  // list_job_profitability tools so a job can't show two different profits anywhere.
  // Labor rates: merged from the staff-scoped `profile_pay` view onto the embedded profile by
  // its id. 0215/0216 revoke those columns from the `authenticated` role — RLS cannot restrict
  // columns — so a PostgREST embed can no longer carry them for anyone. Office staff get the
  // real numbers; anyone else costs labor at zero rather than reading the crew's pay.
  attachRates((entries ?? []) as any[], await payRateMap(supabase), (e: any) => ({ id: e.profiles?.id, holder: e }));

  const jobRows = computeJobProfitRows({
    jobs: jobs ?? [],
    payments: jobPayments ?? [],
    pettyCash: pettyCash ?? [],
    pos: pos ?? [],
    bills: bills ?? [],
    jobRefunds: jobRefunds ?? [],
    entries: entries ?? [],
  }).slice(0, 8);

  // ── Overhead (all time, by category — matches the tile's label) ──────────
  const overhead = new Map<string, number>();
  for (const b of (bills ?? []) as any[]) {
    if (b.job_id) continue;
    const k = b.category ?? "Other";
    overhead.set(k, (overhead.get(k) ?? 0) + Number(b.amount));
  }
  const overheadTotal = [...overhead.values()].reduce((s, v) => s + v, 0);

  const stat = (label: string, value: string, Icon: any, tone: string) => (
    <Card key={label}>
      <CardContent className="flex items-center gap-3 py-4">
        <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${tone}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <div className="text-xl font-bold text-slate-900">{value}</div>
          <div className="text-xs text-slate-500">{label}</div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Analytics" description="How the business is actually doing — money in, money owed, win rate, job profit." />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stat("Collected (12 mo)", formatCurrency(trend.collected12), TrendingUp, "bg-green-50 text-green-600")}
        {stat("Outstanding A/R", formatCurrency(ar.outstanding), Receipt, "bg-red-50 text-red-600")}
        {stat("Estimate win rate", qs.winRatePct != null ? `${qs.winRatePct}%` : "—", FileText, "bg-indigo-50 text-indigo-600")}
        {stat("Overhead (all time)", formatCurrency(overheadTotal), Wallet, "bg-amber-50 text-amber-600")}
      </div>

      <Card className="mb-6">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          Money collected by month
        </div>
        <CardContent className="py-5">
          <div className="flex h-40 items-end gap-1.5">
            {trend.series.map(({ month, collected: v }) => (
              <div key={month} className="flex flex-1 flex-col items-center gap-1" title={`${monthLabel(month)}: ${formatCurrency(v)}`}>
                <div className="text-[10px] text-slate-500">{v > 0 ? `$${Math.round(v / 1000)}k` : ""}</div>
                <div
                  className="w-full rounded-t bg-brand/80"
                  style={{ height: `${Math.max(2, (v / trend.maxRev) * 100)}%` }}
                />
                <div className="text-[10px] text-slate-400">{monthLabel(month)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            Who owes you (A/R aging)
          </div>
          <CardContent className="space-y-2 py-5 text-sm">
            {[
              ["Not yet due", ar.buckets.current, "bg-green-500"],
              ["1–30 days late", ar.buckets.d30, "bg-amber-400"],
              ["31–60 days late", ar.buckets.d60, "bg-orange-500"],
              ["60+ days late", ar.buckets.d90, "bg-red-500"],
            ].map(([label, v, tone]) => (
              <div key={label as string} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-xs text-slate-500">{label as string}</span>
                <div className="h-3 flex-1 overflow-hidden rounded bg-slate-100">
                  <div className={`h-full ${tone as string}`} style={{ width: ar.outstanding > 0 ? `${((v as number) / ar.outstanding) * 100}%` : 0 }} />
                </div>
                <span className="w-20 text-right font-medium text-slate-800">{formatCurrency(v as number)}</span>
              </div>
            ))}
            <p className="pt-2 text-xs text-slate-400">
              {ar.openCount} open invoice{ar.openCount === 1 ? "" : "s"} · chase the red first
            </p>
          </CardContent>
        </Card>

        <Card>
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            Estimates & pipeline
          </div>
          <CardContent className="space-y-2 py-5 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Won</span><span className="font-medium text-green-600">{qs.won}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Lost / expired</span><span className="font-medium text-red-600">{qs.lost}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Awaiting answer</span><span className="font-medium text-slate-800">{qs.awaiting}</span></div>
            <div className="flex justify-between border-t border-slate-100 pt-2"><span className="text-slate-500">Pipeline value (sent)</span><span className="font-semibold text-slate-900">{formatCurrency(qs.pipelineValue)}</span></div>
            {overhead.size > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Overhead by category</div>
                {[...overhead.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs">
                    <span className="text-slate-500">{k}</span>
                    <span className="text-slate-700">{formatCurrency(v)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          Job profitability (collected − labor − materials − bills)
        </div>
        <ul className="divide-y divide-slate-100">
          {jobRows.map((j) => (
            <li key={j.id}>
              <Link href={`/jobs/${j.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-slate-900">{j.job_number} — {j.name}</span>
                  <Badge tone={statusTone(j.status)} className="ml-2">{jobStatusLabel(j.status)}</Badge>
                </div>
                <span className="text-slate-500">in {formatCurrency(j.rev)}</span>
                <span className="text-slate-500">out {formatCurrency(j.cost)}</span>
                <span className={`w-24 text-right font-semibold ${j.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCurrency(j.profit)}
                </span>
              </Link>
            </li>
          ))}
          {jobRows.length === 0 && (
            <li className="px-5 py-8 text-center text-sm text-slate-400">
              No invoiced or costed jobs yet — profitability shows up as soon as money moves.
            </li>
          )}
        </ul>
      </Card>
    </div>
  );
}
