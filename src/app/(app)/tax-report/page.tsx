import Link from "next/link";
import { Calculator } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { summarizeMileage } from "@/lib/mileage-math";

export const dynamic = "force-dynamic";

type Period = "month" | "quarter" | "ytd" | "year";

function rangeFor(period: Period) {
  const now = new Date();
  const y = now.getFullYear();
  // Each period is a half-open [start, end) window. The bug was a fixed
  // end = Jan 1 next year for month/quarter, so "this month" actually reported
  // the whole year — wrong sales-tax totals. Snap end to the period boundary.
  if (period === "month") {
    return { start: new Date(y, now.getMonth(), 1), end: new Date(y, now.getMonth() + 1, 1) };
  }
  if (period === "quarter") {
    const q = Math.floor(now.getMonth() / 3) * 3;
    return { start: new Date(y, q, 1), end: new Date(y, q + 3, 1) };
  }
  if (period === "year") {
    return { start: new Date(y - 1, 0, 1), end: new Date(y, 0, 1) };
  }
  // ytd → Jan 1 this year through now (next-year boundary keeps today included)
  return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
}

const LABELS: Record<Period, string> = {
  month: "This month",
  quarter: "This quarter",
  ytd: "Year to date",
  year: "Last year",
};

export default async function TaxReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: pRaw } = await searchParams;
  const period: Period = (["month", "quarter", "ytd", "year"].includes(pRaw ?? "") ? pRaw : "ytd") as Period;
  const { start, end } = rangeFor(period);

  const supabase = await createClient();
  const [{ data: invoices }, { data: taxRates }, { data: entries }, { data: org }] = await Promise.all([
    supabase
      .from("invoices")
      .select("tax_rate, tax, subtotal, total, status, created_at")
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString()),
    supabase.from("tax_rates").select("name, rate").order("rate"),
    supabase
      .from("time_entries")
      .select("clock_in, miles, profile_id, profiles:profile_id(commute_baseline_miles)")
      .gte("clock_in", start.toISOString())
      .lt("clock_in", end.toISOString()),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);

  // Business (deductible) mileage = logged miles net of each person's daily commute
  // baseline (subtracted once per day). Grouped per person so baselines apply right.
  const settings = getOrgSettings((org as any)?.settings);
  const byPerson = new Map<string, { baseline: number; entries: any[] }>();
  for (const e of entries ?? []) {
    const rec = byPerson.get(e.profile_id) ?? { baseline: Number((e as any).profiles?.commute_baseline_miles ?? 0), entries: [] as any[] };
    rec.entries.push(e);
    byPerson.set(e.profile_id, rec);
  }
  let businessMiles = 0;
  let loggedMiles = 0;
  for (const rec of byPerson.values()) {
    const s = summarizeMileage(rec.entries, rec.baseline, settings.timezone);
    businessMiles += s.business;
    loggedMiles += s.recorded;
  }
  businessMiles = Math.round(businessMiles * 10) / 10;
  loggedMiles = Math.round(loggedMiles * 10) / 10;
  const mileageDeduction = Math.round(businessMiles * (settings.mileage_rate || 0) * 100) / 100;

  // Only count real (issued) invoices — exclude drafts & voids.
  const real = (invoices ?? []).filter((i: any) => !["void", "draft"].includes(i.status));

  // Map a decimal tax_rate to a named jurisdiction when possible.
  const nameFor = (rateDec: number) => {
    const pct = rateDec * 100;
    const match = (taxRates ?? []).find((t: any) => Math.abs(Number(t.rate) - pct) < 0.001);
    return match?.name ?? (pct === 0 ? "No tax" : `${pct.toFixed(3)}%`);
  };

  // Group by rate.
  const groups = new Map<string, { name: string; pct: number; taxable: number; tax: number; count: number }>();
  let totalTaxable = 0;
  let totalTax = 0;
  for (const i of real) {
    const rateDec = Number(i.tax_rate ?? 0);
    const key = (rateDec * 100).toFixed(3);
    const g = groups.get(key) ?? { name: nameFor(rateDec), pct: rateDec * 100, taxable: 0, tax: 0, count: 0 };
    g.taxable += Number(i.subtotal ?? 0);
    g.tax += Number(i.tax ?? 0);
    g.count += 1;
    groups.set(key, g);
    totalTaxable += Number(i.subtotal ?? 0);
    totalTax += Number(i.tax ?? 0);
  }
  const rows = [...groups.values()].sort((a, b) => b.tax - a.tax);

  return (
    <div>
      <PageHeader title="Tax Report" description="Sales tax collected by rate / jurisdiction — for filing & remittance." />

      <div className="mb-4 flex flex-wrap gap-2">
        {(Object.keys(LABELS) as Period[]).map((p) => (
          <Link
            key={p}
            href={`/tax-report?period=${p}`}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
              period === p ? "border-brand bg-brand text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {LABELS[p]}
          </Link>
        ))}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:max-w-lg">
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold text-slate-900">{formatCurrency(totalTax)}</div>
            <div className="text-xs text-slate-500">Tax collected</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold text-slate-900">{formatCurrency(totalTaxable)}</div>
            <div className="text-xs text-slate-500">Taxable sales</div>
          </CardContent>
        </Card>
      </div>

      {businessMiles > 0 && (
        <Card className="mb-6 sm:max-w-lg">
          <CardContent className="py-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Business mileage deduction (estimate)</div>
            <div className="mt-1 flex items-baseline gap-3">
              <div className="text-2xl font-bold text-slate-900">{businessMiles.toFixed(1)} mi</div>
              {settings.mileage_rate > 0 && <div className="text-lg font-semibold text-green-600">≈ {formatCurrency(mileageDeduction)}</div>}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {loggedMiles.toFixed(1)} logged, net of each person&apos;s commute baseline
              {settings.mileage_rate > 0 ? ` · at ${formatCurrency(settings.mileage_rate)}/mi` : ""}. Confirm the rate &amp; classification with your CPA.
            </p>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState icon={Calculator} title="No invoices in this period" description="Tax collected on issued invoices will appear here." />
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-12 gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
            <div className="col-span-4">Jurisdiction / rate</div>
            <div className="col-span-2 text-right">Rate</div>
            <div className="col-span-2 text-right">Invoices</div>
            <div className="col-span-2 text-right">Taxable</div>
            <div className="col-span-2 text-right">Tax</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.name + r.pct} className="grid grid-cols-2 gap-2 px-5 py-3 text-sm md:grid-cols-12 md:items-center md:gap-3">
                <div className="col-span-4 font-medium text-slate-900">{r.name}</div>
                <div className="col-span-2 text-right text-slate-500">{r.pct.toFixed(3)}%</div>
                <div className="col-span-2 text-right text-slate-500">{r.count}</div>
                <div className="col-span-2 text-right text-slate-600">{formatCurrency(r.taxable)}</div>
                <div className="col-span-2 text-right font-medium text-slate-900">{formatCurrency(r.tax)}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="mt-3 text-xs text-slate-400">
        Based on issued invoices (excludes drafts & voids), dated {formatDate(start.toISOString())} onward.
        Accrual basis — tax counted when invoiced.
      </p>
    </div>
  );
}
