import { redirect } from "next/navigation";
import Link from "next/link";
import { TrendingUp, Receipt, FileText, Wallet } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (k: string) =>
  new Date(`${k}-15`).toLocaleDateString(undefined, { month: "short" });

export default async function AnalyticsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  if (!me || !["owner", "admin", "office"].includes(me.role)) redirect("/dashboard");

  const yearAgo = new Date();
  yearAgo.setMonth(yearAgo.getMonth() - 11);
  yearAgo.setDate(1);

  const [{ data: payments }, { data: invoices }, { data: quotes }, { data: jobs }, { data: entries }, { data: pos }, { data: bills }] =
    await Promise.all([
      supabase.from("payments").select("amount, paid_at").gte("paid_at", yearAgo.toISOString()),
      supabase.from("invoices").select("id, invoice_number, job_id, status, total, amount_paid, due_date, created_at, customers(name)"),
      supabase.from("quotes").select("status, total"),
      supabase.from("jobs").select("id, job_number, name, status").order("created_at", { ascending: false }).limit(100),
      supabase
        .from("time_entries")
        .select("job_id, clock_in, clock_out, lunch_minutes, status, profiles(hourly_rate)")
        .eq("status", "closed")
        .not("job_id", "is", null),
      supabase.from("purchase_orders").select("job_id, total"),
      supabase.from("bills").select("job_id, amount, category"),
    ]);

  // ── Revenue by month (collected payments, last 12 months) ────────────────
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(yearAgo);
    d.setMonth(d.getMonth() + i);
    months.push(monthKey(d));
  }
  const revByMonth = new Map<string, number>(months.map((m) => [m, 0]));
  for (const p of payments ?? []) {
    const k = monthKey(new Date(p.paid_at));
    if (revByMonth.has(k)) revByMonth.set(k, revByMonth.get(k)! + Number(p.amount));
  }
  const maxRev = Math.max(1, ...revByMonth.values());
  const collected12 = [...revByMonth.values()].reduce((s, v) => s + v, 0);

  // ── A/R aging ─────────────────────────────────────────────────────────────
  const openInvoices = (invoices ?? []).filter((i: any) => !["paid", "void", "draft"].includes(i.status));
  const now = Date.now();
  const aging = { current: 0, d30: 0, d60: 0, d90: 0 };
  for (const i of openInvoices as any[]) {
    const bal = Number(i.total) - Number(i.amount_paid);
    if (bal <= 0) continue;
    const ref = i.due_date ? new Date(i.due_date).getTime() : new Date(i.created_at).getTime();
    const days = (now - ref) / 86400_000;
    if (days <= 0) aging.current += bal;
    else if (days <= 30) aging.d30 += bal;
    else if (days <= 60) aging.d60 += bal;
    else aging.d90 += bal;
  }
  const outstanding = aging.current + aging.d30 + aging.d60 + aging.d90;

  // ── Quote win rate & pipeline ─────────────────────────────────────────────
  const q = { accepted: 0, declined: 0, expired: 0, sent: 0, draft: 0, pipeline: 0 };
  for (const x of (quotes ?? []) as any[]) {
    if (x.status === "accepted") q.accepted++;
    else if (x.status === "declined") q.declined++;
    else if (x.status === "expired") q.expired++;
    else if (x.status === "sent") {
      q.sent++;
      q.pipeline += Number(x.total);
    } else q.draft++;
  }
  const decided = q.accepted + q.declined + q.expired;
  const winRate = decided > 0 ? (q.accepted / decided) * 100 : null;

  // ── Job profitability ─────────────────────────────────────────────────────
  const cost = new Map<string, number>();
  const add = (id: string | null, v: number) => {
    if (!id) return;
    cost.set(id, (cost.get(id) ?? 0) + v);
  };
  for (const e of (entries ?? []) as any[]) {
    if (!e.clock_out) continue;
    const hrs = Math.max(
      0,
      (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 - (e.lunch_minutes ?? 0) / 60,
    );
    add(e.job_id, hrs * Number(e.profiles?.hourly_rate ?? 0));
  }
  for (const p of (pos ?? []) as any[]) add(p.job_id, Number(p.total));
  for (const b of (bills ?? []) as any[]) add(b.job_id, Number(b.amount));

  const revenueByJob = new Map<string, number>();
  for (const i of (invoices ?? []) as any[]) {
    if (i.job_id && !["void", "draft"].includes(i.status))
      revenueByJob.set(i.job_id, (revenueByJob.get(i.job_id) ?? 0) + Number(i.total));
  }
  const jobRows = ((jobs ?? []) as any[])
    .map((j) => {
      const rev = revenueByJob.get(j.id) ?? 0;
      const c = cost.get(j.id) ?? 0;
      return { ...j, rev, cost: c, profit: rev - c };
    })
    .filter((j) => j.rev > 0 || j.cost > 0)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 8);

  // ── Overhead (year to date, by category) ─────────────────────────────────
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
        {stat("Collected (12 mo)", formatCurrency(collected12), TrendingUp, "bg-green-50 text-green-600")}
        {stat("Outstanding A/R", formatCurrency(outstanding), Receipt, "bg-red-50 text-red-600")}
        {stat("Quote win rate", winRate != null ? `${winRate.toFixed(0)}%` : "—", FileText, "bg-indigo-50 text-indigo-600")}
        {stat("Overhead (all time)", formatCurrency(overheadTotal), Wallet, "bg-amber-50 text-amber-600")}
      </div>

      <Card className="mb-6">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          Money collected by month
        </div>
        <CardContent className="py-5">
          <div className="flex h-40 items-end gap-1.5">
            {months.map((m) => {
              const v = revByMonth.get(m) ?? 0;
              return (
                <div key={m} className="flex flex-1 flex-col items-center gap-1" title={`${monthLabel(m)}: ${formatCurrency(v)}`}>
                  <div className="text-[10px] text-slate-500">{v > 0 ? `$${Math.round(v / 1000)}k` : ""}</div>
                  <div
                    className="w-full rounded-t bg-brand/80"
                    style={{ height: `${Math.max(2, (v / maxRev) * 100)}%` }}
                  />
                  <div className="text-[10px] text-slate-400">{monthLabel(m)}</div>
                </div>
              );
            })}
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
              ["Not yet due", aging.current, "bg-green-500"],
              ["1–30 days late", aging.d30, "bg-amber-400"],
              ["31–60 days late", aging.d60, "bg-orange-500"],
              ["60+ days late", aging.d90, "bg-red-500"],
            ].map(([label, v, tone]) => (
              <div key={label as string} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-xs text-slate-500">{label as string}</span>
                <div className="h-3 flex-1 overflow-hidden rounded bg-slate-100">
                  <div className={`h-full ${tone as string}`} style={{ width: outstanding > 0 ? `${((v as number) / outstanding) * 100}%` : 0 }} />
                </div>
                <span className="w-20 text-right font-medium text-slate-800">{formatCurrency(v as number)}</span>
              </div>
            ))}
            <p className="pt-2 text-xs text-slate-400">
              {openInvoices.length} open invoice{openInvoices.length === 1 ? "" : "s"} · chase the red first
            </p>
          </CardContent>
        </Card>

        <Card>
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            Quotes & pipeline
          </div>
          <CardContent className="space-y-2 py-5 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Won</span><span className="font-medium text-green-600">{q.accepted}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Lost / expired</span><span className="font-medium text-red-600">{q.declined + q.expired}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Awaiting answer</span><span className="font-medium text-slate-800">{q.sent}</span></div>
            <div className="flex justify-between border-t border-slate-100 pt-2"><span className="text-slate-500">Pipeline value (sent)</span><span className="font-semibold text-slate-900">{formatCurrency(q.pipeline)}</span></div>
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
          Job profitability (invoiced − labor − materials − bills)
        </div>
        <ul className="divide-y divide-slate-100">
          {jobRows.map((j) => (
            <li key={j.id}>
              <Link href={`/jobs/${j.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-slate-900">{j.job_number} — {j.name}</span>
                  <Badge tone={statusTone(j.status)} className="ml-2">{j.status.replace("_", " ")}</Badge>
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
