import Link from "next/link";
import { Calculator } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Period = "month" | "quarter" | "ytd" | "year";

function rangeFor(period: Period) {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  if (period === "month") start.setMonth(now.getMonth());
  else if (period === "quarter") start.setMonth(Math.floor(now.getMonth() / 3) * 3);
  else if (period === "year") start.setFullYear(now.getFullYear() - 1, 0, 1);
  // ytd → Jan 1 this year (default)
  const end = period === "year" ? new Date(now.getFullYear(), 0, 1) : new Date(now.getFullYear() + 1, 0, 1);
  return { start, end };
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
  const [{ data: invoices }, { data: taxRates }] = await Promise.all([
    supabase
      .from("invoices")
      .select("tax_rate, tax, subtotal, total, status, created_at")
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString()),
    supabase.from("tax_rates").select("name, rate").order("rate"),
  ]);

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
