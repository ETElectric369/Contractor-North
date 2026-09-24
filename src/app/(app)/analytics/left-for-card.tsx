import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented";
import { formatCurrency } from "@/lib/utils";
import { BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";
import {
  OWNER_MONEY_WINDOWS,
  costFigure,
  countedNotPaidLine,
  isOwnerMoneySegmentKey,
  notCountedLine,
  windowLabel,
  type OwnerMoney,
  type OwnerMoneyWindowKey,
} from "@/lib/analytics/owner-money";
import type { OwnerRegister } from "@/lib/owner-draw";
import { OfficeCanSeeSwitch } from "./office-switch";

/**
 * OWNER'S DRAW (0286; named "Left For You" until Erik renamed it 2026-09-24): the card right under Money by Month on /analytics, read like a receipt.
 *
 * Received, then every real cost on its own line, then what is left for the owner as the row that
 * stands out, with "Before income tax. Ask your accountant how much to set aside." directly under
 * it, because the figure is never spendable as it stands. The chart above it draws the same
 * computeOwnerMoney per-month rows, and a month tapped there shows here (windowKey "YYYY-MM"): the
 * subtitle names the month and no segment is selected until one is chosen.
 */
export function LeftForCard({
  money,
  problem,
  voice,
  windowKey,
  viewerIsOwner,
  officeSees,
}: {
  money: OwnerMoney | null;
  problem: string | null;
  voice: OwnerRegister;
  windowKey: OwnerMoneyWindowKey;
  viewerIsOwner: boolean;
  officeSees: boolean;
}) {
  const t = money?.totals;
  const cost = costFigure;
  const row = (label: string, value: string, key?: string) => (
    <div key={key ?? label} className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="text-sm font-medium tabular-nums text-slate-800">{value}</span>
    </div>
  );
  const notCounted = money ? notCountedLine(money) : null;
  const countedNotPaid = money ? countedNotPaidLine(money) : null;

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">{voice.leftFor}</div>
          {money && <div className="text-xs text-slate-500">{windowLabel(money)}</div>}
        </div>
        <SegmentedControl
          items={OWNER_MONEY_WINDOWS.map((w) => ({ id: w.key, label: w.label, href: `/analytics?w=${w.key}` }))}
          activeId={isOwnerMoneySegmentKey(windowKey) ? windowKey : undefined}
        />
      </div>

      <div className="px-5 py-4">
        {!money || !t ? (
          // NOTHING SILENT, AND NEVER A FIGURE THAT MIGHT BE WRONG: every line here is subtraction,
          // so a read that came back short would print a confident wrong number.
          // The shell has no browser reload, so the way back is a real control (the Pay board's own
          // refusal does the same), never a sentence that points at a button that is not there.
          <div>
            <p className="text-sm text-slate-600">
              No figure is shown right now because {problem ?? "the records could not be read"}. Nothing changed. Tap Reload to try
              again.
            </p>
            <a
              href={`/analytics?w=${windowKey}`}
              className="mt-2 inline-flex min-h-[44px] items-center text-sm font-medium text-brand-600"
            >
              Reload
            </a>
          </div>
        ) : (
          <>
            <div className="divide-y divide-slate-100">
              {row("Received", formatCurrency(t.received))}
              {row("Materials & Bills", cost(t.materialsAndBills))}
              {row("Crew Pay", cost(t.crewPay))}
              {Math.abs(t.crewMileagePaid) >= 0.005 && row("Crew Mileage", cost(t.crewMileagePaid))}
              <details className="group">
                <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 py-1.5 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-1 text-sm text-slate-600">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
                    Business Costs
                  </span>
                  <span className="text-sm font-medium tabular-nums text-slate-800">{cost(t.businessCostsTotal)}</span>
                </summary>
                <div className="mb-2 ml-5 border-l border-slate-100 pl-3">
                  {BUSINESS_COST_BUCKETS.map((b) => (
                    <div key={b} className="flex items-baseline justify-between gap-4 py-1">
                      <span className="text-xs text-slate-500">
                        {b}
                        {b === "Fees" && t.processorFees >= 0.005 && (
                          <span className="text-slate-400"> (includes {formatCurrency(t.processorFees)} Stripe card fees)</span>
                        )}
                      </span>
                      <span className="text-xs tabular-nums text-slate-700">{formatCurrency(t.businessCosts[b])}</span>
                    </div>
                  ))}
                </div>
              </details>
            </div>

            <div className="mt-2 border-t-2 border-slate-200 pt-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-base font-semibold text-slate-900">{voice.leftFor}</span>
                <span className={`text-2xl font-bold tabular-nums ${t.left >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCurrency(t.left)}
                </span>
              </div>
              <p className="mt-0.5 text-right text-xs text-slate-500">Before income tax. Ask your accountant how much to set aside.</p>
              {t.ownerHours > 0 && t.perOwnerHour !== null && (
                <p className="mt-1 text-right text-sm text-slate-600">
                  about {formatCurrency(t.perOwnerHour)} for each hour {voice.who} worked
                </p>
              )}
            </div>

            {(notCounted || countedNotPaid) && (
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                {[notCounted, countedNotPaid].filter(Boolean).join(" ")}
              </p>
            )}
          </>
        )}

        {viewerIsOwner && (
          <div className="mt-3 flex justify-end border-t border-slate-100 pt-2">
            <OfficeCanSeeSwitch initial={officeSees} />
          </div>
        )}
      </div>
    </Card>
  );
}
