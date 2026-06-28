"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Check, Download, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatDuration } from "@/lib/utils";
import { payLineFromGross } from "@/lib/payroll-math";
import { markPeriodPaid, unmarkPeriodPaid } from "./actions";

// Format a calendar date STRING without a timezone shift — date-only strings
// parse as UTC midnight, so formatting in a Pacific browser would show the day
// before. Anchor at noon UTC and format in UTC.
const fmtYmd = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

interface Row {
  profileId: string;
  name: string;
  rate: number;
  unpaidHours: number;
  unpaidMiles: number;
  unpaidGross: number;
  paidHours: number;
  paidMiles: number;
  paidGross: number;
}

export function PayrollView({
  rows,
  period,
  offset,
  mileageRate,
}: {
  rows: Row[];
  period: { start: string; end: string };
  offset: number;
  mileageRate: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The period reads [start, end); display the inclusive last day.
  const endInclusive = new Date(new Date(`${period.end}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const label = `${fmtYmd(period.start)} – ${fmtYmd(endInclusive)}`;

  // Gross comes from the per-entry accumulation (honors rate_override), NOT hours×one-rate.
  const gross = (r: Row) => payLineFromGross(r.unpaidGross, r.unpaidMiles, mileageRate).gross;
  const mileagePay = (r: Row) => payLineFromGross(r.unpaidGross, r.unpaidMiles, mileageRate).mileagePay;
  const total = (r: Row) => payLineFromGross(r.unpaidGross, r.unpaidMiles, mileageRate).total;
  // Effective $/hr to display — equals the base rate when no shift was overridden.
  const effRate = (r: Row) => (r.unpaidHours > 0 ? r.unpaidGross / r.unpaidHours : r.paidHours > 0 ? r.paidGross / r.paidHours : r.rate);

  const payable = rows.filter((r) => r.unpaidHours > 0);
  const totals = {
    hours: payable.reduce((s, r) => s + r.unpaidHours, 0),
    gross: payable.reduce((s, r) => s + gross(r), 0),
    mileage: payable.reduce((s, r) => s + mileagePay(r), 0),
    total: payable.reduce((s, r) => s + total(r), 0),
  };

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, id: string) {
    setError(null);
    setBusyId(id);
    start(async () => {
      const res = await fn();
      setBusyId(null);
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else router.refresh();
    });
  }

  function exportCsv() {
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const header = ["Employee", "Hours", "Rate ($/hr)", "Gross ($)", "Miles", "Mileage ($)", "Total ($)", "Status"];
    const lines = rows.map((r) => {
      const paid = r.unpaidHours === 0 && r.paidHours > 0;
      const hrs = paid ? r.paidHours : r.unpaidHours;
      const mi = paid ? r.paidMiles : r.unpaidMiles;
      const grossAcc = paid ? r.paidGross : r.unpaidGross;
      const { gross: g, mileagePay: milePay, total: t } = payLineFromGross(grossAcc, mi, mileageRate);
      const rate = hrs > 0 ? grossAcc / hrs : r.rate; // effective $/hr (blends any overridden shifts)
      return [r.name, hrs.toFixed(2), rate.toFixed(2), g.toFixed(2), mi.toFixed(1), milePay.toFixed(2), t.toFixed(2), paid ? "Paid" : "Unpaid"];
    });
    const csv = [
      [`Payroll — ${label}`],
      header,
      ...lines.map((l) => l),
      ["TOTAL (unpaid)", totals.hours.toFixed(2), "", totals.gross.toFixed(2), "", totals.mileage.toFixed(2), totals.total.toFixed(2), ""],
    ]
      .map((row) => row.map(esc).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${period.start}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link
            href={`/payroll?period=${offset + 1}`}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
            title="Previous period"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[170px] text-center text-sm font-medium text-slate-800">
            {offset === 0 ? "This pay period" : label}
          </span>
          <Link
            href={`/payroll?period=${Math.max(0, offset - 1)}`}
            className={`rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50 ${offset === 0 ? "pointer-events-none opacity-40" : ""}`}
            title="Next period"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>

      <p className="text-xs text-slate-400">{label}</p>
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {payable.length > 0 && (
        <Card className="bg-brand/5">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <span className="font-semibold text-slate-900">To pay this period</span>
            <span className="text-slate-700">
              {formatDuration(totals.hours)} · gross {formatCurrency(totals.gross)}
              {totals.mileage > 0 ? ` · mileage ${formatCurrency(totals.mileage)}` : ""} ·{" "}
              <span className="font-bold text-slate-900">{formatCurrency(totals.total)}</span>
            </span>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-slate-400">No hours logged in this pay period.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const fullyPaid = r.unpaidHours === 0 && r.paidHours > 0;
            return (
              <Card key={r.profileId} className="px-5 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      {r.name}
                      {fullyPaid && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                          <Check className="h-3 w-3" /> Paid
                        </span>
                      )}
                    </div>
                    {r.unpaidHours > 0 ? (
                      <div className="mt-0.5 text-xs text-slate-500">
                        {formatDuration(r.unpaidHours)} × {formatCurrency(effRate(r))}/hr = <span className="font-medium text-slate-700">{formatCurrency(gross(r))}</span>
                        {r.unpaidMiles > 0 && <> · {r.unpaidMiles.toFixed(1)} mi {formatCurrency(mileagePay(r))}</>}
                        {" · "}<span className="font-semibold text-slate-900">{formatCurrency(total(r))}</span>
                      </div>
                    ) : (
                      <div className="mt-0.5 text-xs text-slate-400">{formatDuration(r.paidHours)} paid</div>
                    )}
                  </div>
                  <div className="shrink-0">
                    {r.unpaidHours > 0 ? (
                      <Button
                        size="sm"
                        onClick={() => run(() => markPeriodPaid({ profileId: r.profileId, periodStart: period.start, periodEnd: period.end }), r.profileId)}
                        disabled={pending && busyId === r.profileId}
                      >
                        <Check className="h-4 w-4" /> Mark paid
                      </Button>
                    ) : fullyPaid ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-slate-500"
                        onClick={() => run(() => unmarkPeriodPaid({ profileId: r.profileId, periodStart: period.start, periodEnd: period.end }), r.profileId)}
                        disabled={pending && busyId === r.profileId}
                      >
                        <Undo2 className="h-4 w-4" /> Undo
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <p className="pt-1 text-xs text-slate-400">
        Gross pay &amp; mileage only — tax deductions &amp; withholdings are handled by your accountant /
        payroll service from this export.
      </p>
    </div>
  );
}
