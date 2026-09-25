import { attachRates, payRateMap } from "@/lib/profile-columns";
import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import Link from "next/link";
import { TrendingUp, Receipt, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { formatCurrency } from "@/lib/utils";
import { computeJobProfitRows } from "@/lib/analytics/job-profitability";
import { readJobShelfNet } from "@/lib/job-cost";
import { computeArAging, computeQuoteStats } from "@/lib/analytics/money-metrics";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { getOwnerMoneyViews, ownerMoneyChartWindow, ownerMoneyWindow, resolveOwnerMoneySelection } from "@/lib/analytics/owner-money";
import { buildMoneyChartData, drawnMonth, emptyChartSentence } from "@/lib/analytics/money-chart";
import { ownerRegister } from "@/lib/owner-draw";
import { LeftForCard } from "./left-for-card";
import { MoneyChartCard } from "./money-chart-card";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; from?: string }>;
}) {
  const { w, from } = await searchParams;
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
  const orgSettings = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings);
  const tz = orgSettings.timezone;

  // LEFT FOR YOU (0286). The owner always sees it; office staff (admin, office) see it unless the
  // owner switched "Office Can See This" off, in which case they get no card at all. Techs never
  // reach this page (the redirect above).
  const viewerIsOwner = me.role === "owner";
  const showOwnerMoney = viewerIsOwner || orgSettings.office_sees_owner_money;
  const todayYmd = todayStrInTz(tz);

  // MONEY BY MONTH + LEFT FOR YOU, ONE READ. The card shows This Year unless a segment or a month
  // tapped on the chart says otherwise (?w=, validated here against the chart's 12 months). The
  // chart's 12 months and the card's window are computed from the SAME rows, read once over the span
  // covering both, so the chart's August and the card's August are one computation. An office viewer
  // the owner has not allowed still gets the chart, cut to Collected on this server before it is
  // handed to the page (buildMoneyChartData), and no card.
  //
  // A month in ?w= is shown only if the chart DRAWS it (drawnMonth, below): a month before the
  // chart's trimmed start would select nothing on the chart and print a month of $0s from before the
  // books began. So the segment's window is computed too (same rows, no extra read) as the fallback.
  const selection = resolveOwnerMoneySelection(w, from, todayYmd);
  const cardWindows = showOwnerMoney
    ? [ownerMoneyWindow(selection.segment, todayYmd), ...(selection.month ? [ownerMoneyWindow(selection.month, todayYmd)] : [])]
    : [];
  const ownerMoneyP = getOwnerMoneyViews(supabase, [ownerMoneyChartWindow(todayYmd), ...cardWindows], tz, todayYmd);

  const [{ data: invoices }, { data: quotes }, { data: jobs }, { data: entries }, { data: pos }, { data: bills }, { data: jobRefunds }, { data: jobPayments }, { data: pettyCash }, shelf] =
    await Promise.all([
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
        .select("job_id, clock_in, clock_out, lunch_minutes, status, rate_override, profiles(id)")
        .eq("status", "closed")
        // laborCostForJob ignores entries that don't touch the job, so no job_id filter is needed.
        .order("clock_in", { ascending: false })
        .limit(50000),
      // id + status + po_id feed computeJobProfitRows' shared live-PO rule: a draft/cancelled
      // order isn't a cost, and a PO paid by a bill is superseded by it (no double-charge).
      supabase.from("purchase_orders").select("id, job_id, total, status").limit(50000),
      // A SUPERSEDED BILL IS A DUPLICATE, AND A DUPLICATE IS NOT A COST (0271, review of cn-v963).
      // Erik's books carry one proven case: the same CED ticket, line for line to the penny, filed to both
      // 13631 Northwoods and 85 Whitney Place. The duplicate picker tells him the copy he sets aside "stops
      // counting against that job" - a sentence that was false everywhere, because every cost reader summed
      // bills unfiltered. The same column also catches the Sunnyvale preview once its Truckee-priced invoice
      // arrives and supersedes it, which is the case that has not happened yet and would otherwise have
      // counted one purchase twice on the same job.
      supabase.from("bills").select("job_id, amount, category, po_id").is("superseded_by_bill_id", null).limit(50000),
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
      // THE SHELF (0303): what went on the shelf from each job's tickets and what each job took from
      // it, from the same view every job-cost reader reads (src/lib/job-cost.ts).
      readJobShelfNet(supabase),
    ]);
  // A job's cost missing its shelf part would be a confident wrong number on every row below.
  if (shelf.error) throw shelf.error;

  // ── Money metrics — the SAME computations Nort's ar_aging / quote_win_rate tools call. The
  // monthly money here is the Money by Month chart (owner-money, computeCollected per month), and
  // Nort's revenue_trend is held to it month by month by a test (audit v994 MR4), not by sharing
  // this call: this page no longer calls computeRevenueTrend.
  const ar = computeArAging((invoices ?? []) as any[], todayYmd);
  const qs = computeQuoteStats((quotes ?? []) as any[]);

  // ── Job profitability ─────────────────────────────────────────────────────
  // The ONE computation (revenue = collected − refunds; cost = crew
  // labor + materials), now shared with the job hub AND Nort's get_job_financials /
  // list_job_profitability tools so a job can't show two different profits anywhere.
  // Labor rates: merged from the staff-scoped `profile_pay` view onto the embedded profile by
  // its id. 0215/0216 revoke those columns from the `authenticated` role — RLS cannot restrict
  // columns — so a PostgREST embed can no longer carry them for anyone. Office staff get the
  // real numbers; anyone else costs labor at zero rather than reading the crew's pay.
  const rates = await payRateMap(supabase);
  attachRates((entries ?? []) as any[], rates, (e: any) => ({ id: e.profiles?.id, holder: e }));

  const ownerMoney = await ownerMoneyP;
  const chartMoney = ownerMoney.views?.[0] ?? null;
  // Who "you" is on the card and the chart: the owners by name (from the same names profile_pay
  // carries) and the viewer, in the register payroll-view started (lib/owner-draw).
  const voice = ownerRegister(chartMoney?.owners ?? [...rates.entries()].filter(([, r]) => r.paid_by_draw).map(([id]) => ({ id, name: null })), user?.id ?? null);
  const chartData = chartMoney ? buildMoneyChartData(chartMoney, { ownerFigures: showOwnerMoney, leftLabel: voice.leftFor }) : null;
  const selectedMonth = drawnMonth(selection.month, chartData);
  const windowKey = selectedMonth ?? selection.segment;
  const cardMoney = showOwnerMoney ? (ownerMoney.views?.[selectedMonth ? 2 : 1] ?? null) : null;
  // "Collected (12 mo)" is the chart's own 12 months (received, net of refunds and voided invoices:
  // the computeCollected rule), not a second read of the same payments that could drift from it.
  const collected12 = chartMoney ? chartMoney.totals.received : null;
  const emptyLine = emptyChartSentence(ownerMoney.firstPaymentDay, ownerMoneyChartWindow(todayYmd).start);

  const jobRows = computeJobProfitRows({
    jobs: jobs ?? [],
    payments: jobPayments ?? [],
    pettyCash: pettyCash ?? [],
    pos: pos ?? [],
    bills: bills ?? [],
    jobRefunds: jobRefunds ?? [],
    entries: entries ?? [],
    shelfNet: shelf.rows,
  }).slice(0, 8);

  // The old "Overhead (all time)" tile and "Overhead by category" block are gone (0286). They
  // counted only no-job bills, all time, in the old category words, and disagreed with Business
  // Costs. The Left For You card carries business costs now, in the six buckets, for the window.

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

      <MoneyChartCard
        data={chartData}
        problem={ownerMoney.problem}
        selectedMonth={selectedMonth}
        segment={selection.segment}
        linkMonths={showOwnerMoney}
        emptyLine={emptyLine}
      />

      {showOwnerMoney && (
        <LeftForCard
          money={cardMoney}
          problem={ownerMoney.problem}
          voice={voice}
          windowKey={windowKey}
          viewerIsOwner={viewerIsOwner}
          officeSees={orgSettings.office_sees_owner_money}
        />
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
        {stat("Collected (12 mo)", collected12 == null ? "—" : formatCurrency(collected12), TrendingUp, "bg-green-50 text-green-600")}
        {stat("Outstanding A/R", formatCurrency(ar.outstanding), Receipt, "bg-red-50 text-red-600")}
        {stat("Estimate win rate", qs.winRatePct != null ? `${qs.winRatePct}%` : "—", FileText, "bg-indigo-50 text-indigo-600")}
      </div>

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
          </CardContent>
        </Card>
      </div>

      <Card>
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          Job profitability (collected − crew pay − materials − bills − petty cash)
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
