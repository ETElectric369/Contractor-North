import { Card } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented";
import { formatCurrency } from "@/lib/utils";
import {
  OWNER_MONEY_WINDOWS,
  costFigure,
  countedNotPaidLine,
  hasUnratedHours,
  isOwnerMoneySegmentKey,
  notCountedLine,
  stockLine,
  windowLabel,
  type OwnerMoney,
  type OwnerMoneyWindowKey,
} from "@/lib/analytics/owner-money";
import { profitAndLoss, sayPct, type PnlKey, type PnlRow } from "@/lib/analytics/profit-and-loss";
import type { OwnerRegister } from "@/lib/owner-draw";
import { OfficeCanSeeSwitch } from "./office-switch";

/**
 * OWNER'S DRAW (0286; named "Left For You" until Erik renamed it 2026-09-24): the card right under
 * Money by Month on /analytics, read like the accounting industry's profit and loss (Erik,
 * 2026-09-28: "the tried and true old school simple wording and formatting").
 *
 *   Revenue, then Cost of Goods Sold (COGS) line by line and Total COGS, then Gross Profit with its
 *   Gross Margin %, then Overhead line by line and Total Overhead, then Net Profit (Owner's Draw) as
 *   the row that stands out, with "Before income tax. Ask your accountant how much to set aside."
 *   directly under it, because the figure is never spendable as it stands.
 *
 * Every row is profit-and-loss.ts's, the same lines and words as Money by Month and the accountant's
 * Summary, so no two screens say the same money two ways. Stock bought rides inside Materials &
 * Bills here (Erik, 2026-09-27), and the line under the card says how much. The owner's hours are
 * hours, said under the bottom line, never a cost.
 *
 * The chart above it draws the same computeOwnerMoney per-month rows, and a month tapped there shows
 * here (windowKey "YYYY-MM"): the subtitle names the month and no segment is selected until one is
 * chosen.
 */

/** The cost lines the card always says, $0.00 included (a solo owner still reads Crew Pay $0.00);
 *  every other line only when it holds some money, the way the card always has. */
const ALWAYS_SAID = new Set<PnlKey>(["materials", "crew_pay"]);

/** The Fuel bucket keeps its own colour here, the one Money by Month and the Fuel card draw it in. */
const FUEL: PnlKey = "bucket:Fuel";

/** A row name whose parenthesis never breaks inside: on a phone "Net Profit (Owner's Draw)" wraps as
 *  "Net Profit" over "(Owner's Draw)", never "Net Profit (Owner's" over "Draw)". */
function RowName({ label }: { label: string }) {
  const at = label.indexOf(" (");
  if (at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)} <span className="whitespace-nowrap">{label.slice(at + 1)}</span>
    </>
  );
}

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
  const notCounted = money ? notCountedLine(money) : null;
  const countedNotPaid = money ? countedNotPaidLine(money) : null;
  const stock = money ? stockLine(money) : null;
  // THE PROFIT AND LOSS: only the owner (or an office the owner shared it with) ever gets this card.
  const pnl = t ? profitAndLoss(t, { otherIncome: Math.abs(t.otherIncome ?? 0) >= 0.005, stockInMaterials: true, margin: true }) : [];
  const said = pnl.filter((r) => {
    if (r.kind === "cost") return ALWAYS_SAID.has(r.key) || Math.abs(r.cents ?? 0) >= 1;
    if (r.kind === "part") return Math.abs(r.cents ?? 0) >= 1;
    if (r.kind === "margin") return r.pct != null;
    return true;
  });

  const lineOf = (r: PnlRow) => {
    const amount = r.amount ?? 0;
    switch (r.kind) {
      case "revenue":
        return (
          <div key={r.key} className="flex items-baseline justify-between gap-4 py-1.5">
            <span className="text-sm font-medium text-slate-900">{r.label}</span>
            <span className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(amount)}</span>
          </div>
        );
      case "part":
        // OTHER INCOME (0363): deposits a bank download placed as income no invoice holds. Already
        // inside Revenue; its own chip so it is never mistaken for paid work.
        return (
          <div key={r.key} className="flex justify-end pb-1.5">
            <span className="rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-800">
              {r.label} {formatCurrency(amount)}
            </span>
          </div>
        );
      case "heading":
        return (
          <div key={r.key} className="pb-0.5 pt-3 text-xs font-semibold text-slate-500">
            {r.label}
          </div>
        );
      case "cost":
        return (
          <div key={r.key} className="flex items-baseline justify-between gap-4 py-1 pl-3">
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-slate-600">
              {/* FUEL STANDS OUT (Erik, 2026-09-27): its own line, in the Fuel colour. */}
              {r.key === FUEL && <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm bg-pink-800" aria-hidden="true" />}
              <span>
                {r.label}
                {r.key === "bucket:Fees" && t && t.processorFees >= 0.005 && (
                  <span className="text-slate-400"> (includes {formatCurrency(t.processorFees)} Stripe fees)</span>
                )}
              </span>
            </span>
            <span className="text-sm tabular-nums text-slate-800">{costFigure(amount)}</span>
          </div>
        );
      case "total":
        return (
          <div key={r.key} className="flex items-baseline justify-between gap-4 border-t border-slate-100 py-1.5">
            <span className="text-sm font-medium text-slate-700">{r.label}</span>
            <span className="text-sm font-semibold tabular-nums text-slate-800">{costFigure(amount)}</span>
          </div>
        );
      case "margin":
        return (
          <div key={r.key} className="flex items-baseline justify-between gap-4 pb-1">
            <span className="text-xs text-slate-500">{r.label}</span>
            <span className="text-xs tabular-nums text-slate-600">{sayPct(r.pct ?? 0)}</span>
          </div>
        );
      case "profit":
        // The bottom line is drawn on its own, below; Gross Profit is the middle one.
        if (r.key === "net_profit") return null;
        return (
          <div key={r.key} className="flex items-baseline justify-between gap-4 border-t border-slate-200 pb-0.5 pt-2">
            <span className="text-sm font-semibold text-slate-900">{r.label}</span>
            <span className={`text-base font-bold tabular-nums ${amount < 0 ? "text-red-700" : "text-slate-900"}`}>{formatCurrency(amount)}</span>
          </div>
        );
    }
  };
  const net = pnl.find((r) => r.key === "net_profit");

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
        {!money || !t || !net ? (
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
            <div>{said.map(lineOf)}</div>

            <div className="mt-2 border-t-2 border-slate-200 pt-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-base font-semibold text-slate-900">
                  <RowName label={net.label} />
                </span>
                <span className={`text-2xl font-bold tabular-nums ${(net.amount ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCurrency(net.amount ?? 0)}
                </span>
              </div>
              <p className="mt-0.5 text-right text-xs text-slate-500">Before income tax. Ask your accountant how much to set aside.</p>
              {/* THE OWNER'S TIME IS HOURS, NEVER A COST: said under the line, as what the line is worth an hour. */}
              {t.ownerHours > 0 && t.perOwnerHour !== null && (
                <p className="mt-1 text-right text-sm text-slate-600">
                  about {formatCurrency(t.perOwnerHour)} for each hour {voice.who} worked
                </p>
              )}
            </div>

            {stock && <p className="mt-3 text-xs text-slate-500">{stock}</p>}

            {(notCounted || countedNotPaid) && (
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                {[notCounted, countedNotPaid].filter(Boolean).join(" ")}
              </p>
            )}
            {/* NO DEAD END (audit v994 MR3): hours priced at $0 for want of a pay rate come with the
                door that fixes them, the Pay box on the Team page. */}
            {hasUnratedHours(money) && (
              <a href="/team" className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium text-brand-600">
                Set Pay Rates
              </a>
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
