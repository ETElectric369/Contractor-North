import Link from "next/link";
import { Calculator } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { summarizeMileage } from "@/lib/mileage-math";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

export const dynamic = "force-dynamic";

type Period = "month" | "quarter" | "ytd" | "year";

/** Half-open [start, end) period window, anchored to the BUSINESS timezone so "this
 *  month" means the org's month — and so the window agrees with the per-day mileage
 *  grouping (which is also org-tz). Returns UTC instants of org-tz midnights. */
function rangeFor(period: Period, tz: string) {
  const [y, m] = todayStrInTz(tz).split("-").map(Number); // m = 1..12 in the org tz
  const firstOf = (yy: number, mm: number) => {
    const yr = yy + Math.floor((mm - 1) / 12);
    const mo = (((mm - 1) % 12) + 12) % 12 + 1;
    return `${yr}-${String(mo).padStart(2, "0")}-01`;
  };
  let s: string, e: string;
  if (period === "month") { s = firstOf(y, m); e = firstOf(y, m + 1); }
  else if (period === "quarter") { const q = Math.floor((m - 1) / 3) * 3 + 1; s = firstOf(y, q); e = firstOf(y, q + 3); }
  else if (period === "year") { s = `${y - 1}-01-01`; e = `${y}-01-01`; }
  else { s = `${y}-01-01`; e = `${y + 1}-01-01`; } // ytd
  return { start: tzDayStartUtc(s, tz), end: tzDayStartUtc(e, tz) };
}

const LABELS: Record<Period, string> = {
  month: "This Month",
  quarter: "This Quarter",
  ytd: "Year to Date",
  year: "Last Year",
};

export default async function TaxReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: pRaw } = await searchParams;
  const period: Period = (["month", "quarter", "ytd", "year"].includes(pRaw ?? "") ? pRaw : "ytd") as Period;
  const supabase = await createClient();
  // Load the org tz first so the period window + the per-day mileage grouping agree.
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const settings = getOrgSettings((org as any)?.settings);
  const { start, end } = rangeFor(period, settings.timezone);

  const [{ data: invoices }, { data: taxRates }, { data: entries }] = await Promise.all([
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
  ]);

  // Business (deductible) mileage = logged miles net of each person's daily commute
  // baseline (subtracted once per day). Grouped per person so baselines apply right.
  const byPerson = new Map<string, { baseline: number; entries: any[] }>();
  for (const e of entries ?? []) {
    const rec = byPerson.get(e.profile_id) ?? { baseline: Number((e as any).profiles?.commute_baseline_miles ?? 0), entries: [] as any[] };
    rec.entries.push(e);
    byPerson.set(e.profile_id, rec);
  }
  let businessMilesRaw = 0;
  let loggedMilesRaw = 0;
  for (const rec of byPerson.values()) {
    const s = summarizeMileage(rec.entries, rec.baseline, settings.timezone);
    businessMilesRaw += s.business;
    loggedMilesRaw += s.recorded;
  }
  // Apply the rate to the un-rounded business-miles SUM (round once, at the dollar), so
  // the deduction isn't skewed by rounding each person's tenth-of-a-mile twice.
  const mileageDeduction = Math.round(businessMilesRaw * (settings.mileage_rate || 0) * 100) / 100;
  const businessMiles = Math.round(businessMilesRaw * 10) / 10; // display only
  const loggedMiles = Math.round(loggedMilesRaw * 10) / 10; // display only

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
    // "Taxable sales" = sales that actually carry tax. A 0% / exempt invoice is part of
    // total sales but NOT taxable — counting it here would overstate the taxable base
    // and mismatch what's owed. (It still shows in the per-rate breakdown under "No tax".)
    if (rateDec > 0) totalTaxable += Number(i.subtotal ?? 0);
    totalTax += Number(i.tax ?? 0);
  }
  const rows = [...groups.values()].sort((a, b) => b.tax - a.tax);

  return (
    <div>
      <PageHeader title="Tax report" description="Sales tax collected by rate / jurisdiction — for filing & remittance." />

      <div className="mb-4 flex flex-wrap gap-2">
        {(Object.keys(LABELS) as Period[]).map((p) => (
          <Link
            key={p}
            href={`/tax-report?period=${p}`}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
              period === p ? "seaglass-active border-transparent" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <span className="relative z-10">{LABELS[p]}</span>
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
