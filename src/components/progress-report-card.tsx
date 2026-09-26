import { formatCurrency } from "@/lib/utils";
import { progressBalanceRow, progressSummary, totalToEstimateRow } from "@/lib/invoice-math";

/** A progress-billing summary that rides on a deposit/progress/final invoice so a
 *  payment request doubles as a progress report: the agreed estimate, billable
 *  work to date, what's been received, the amount requested now, and the balance. */
export function ProgressReportCard({
  estimate,
  workToDate,
  received,
  thisAmount,
  billingType,
}: {
  estimate: number;
  workToDate: number;
  received: number;
  thisAmount: number;
  billingType?: "fixed" | "tm";
}) {
  const { pctComplete: pct, balance } = progressSummary(estimate, workToDate, received, thisAmount);
  const isTM = billingType === "tm";
  // Never a negative (INV-080). A T&M job ends on its total against the estimate ("$2,391.64 over");
  // a fixed-price job on what's left of the contract.
  const last: { label: string; value: number; note?: string | null } =
    isTM && estimate > 0 ? totalToEstimateRow(workToDate, estimate) : progressBalanceRow(balance, billingType);

  const rows: { label: string; value: number; note?: string | null; sub?: string; strong?: boolean; top?: boolean }[] = [
    { label: isTM ? "Estimate amount" : "Contract", value: estimate },
    { label: "Work completed to date", value: workToDate, sub: estimate > 0 ? `${pct}%` : undefined },
    { label: "Received to date", value: received },
    { label: "This payment request", value: thisAmount, strong: true, top: true },
    { label: last.label, value: last.value, note: last.note },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Progress summary</div>
      <dl className="space-y-1.5 text-sm">
        {rows.map((r) => (
          <div
            key={r.label}
            className={`flex items-center justify-between ${r.top ? "border-t border-slate-200 pt-2" : ""}`}
          >
            <dt className="text-slate-500">
              {r.label}
              {r.sub ? <span className="ml-1.5 text-slate-400">· {r.sub} complete</span> : null}
            </dt>
            <dd className={r.strong ? "font-bold text-slate-900" : "font-medium text-slate-700"}>
              {formatCurrency(r.value)}
              {r.note ? ` ${r.note}` : ""}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
