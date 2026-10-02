import { Card } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented";
import { formatCurrency } from "@/lib/utils";
import {
  OWNER_MONEY_WINDOWS,
  costFigure,
  countedNotPaidLine,
  hasOwnerBuildTime,
  hasUnratedHours,
  isOwnerMoneySegmentKey,
  notCountedLine,
  ownerDrawUnseen,
  stockLine,
  uncostedBuildTime,
  windowLabel,
  type OwnerMoney,
  type OwnerMoneyWindowKey,
} from "@/lib/analytics/owner-money";
import { buildTimeNotCostedSentence } from "@/lib/build-time-cost";
import { isBelowNetProfit, profitAndLoss, sayPct, type PnlKey, type PnlRow } from "@/lib/analytics/profit-and-loss";
import type { OwnerRegister } from "@/lib/owner-draw";
import { OfficeCanSeeSwitch } from "./office-switch";

/**
 * NET PROFIT (named "Left For You", then "Owner's Draw", then plain Net Profit on 2026-10-01 when
 * Erik said "lets get rid of the terminology owners draw and use only net profit"): the card right
 * under Money by Month on /analytics, read like the accounting industry's profit and loss (Erik,
 * 2026-09-28: "the tried and true old school simple wording and formatting").
 *
 *   Revenue, then Cost of Goods Sold (COGS) line by line and Total COGS, then Gross Profit with its
 *   Gross Margin %, then Overhead line by line and Total Overhead, then NET PROFIT as the row that
 *   stands out, with "Before income tax. Ask your accountant how much to set aside." directly under
 *   it, because the figure is never spendable as it stands - and then, below the rule, OWNER'S DRAW:
 *   what he actually took out, which is equity and is never subtracted from anything above it.
 *
 * Every row is profit-and-loss.ts's, the same lines and words as Money by Month and the accountant's
 * Summary, so no two screens say the same money two ways. Stock bought rides inside Materials &
 * Bills here (Erik, 2026-09-27), and the line under the card says how much.
 *
 * HIS BUILD TIME IS A COST HERE AND STILL NOT A DEDUCTION. Owner Hours Charged To Jobs charges his
 * on-site hours inside COGS, and the contra line under it books the same amount back, so Net Profit
 * is the same figure it was before the allocation existed - which it has to be, because a sole
 * proprietor cannot deduct his own labour. Until he sets a cost rate the pair is not drawn at all and
 * a sentence says so, with the door: no figure here is ever built on a guessed rate.
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

/** A row name that never breaks mid-word on a phone. It used to read "Owner Build Time Allocation
 *  (Contra)" and wrapped as "… Allocation" over "(Contra)", never "… Allocation (Con" over "tra)". It was
 *  written for "Net Profit (Owner's Draw)", which has no parenthesis any more (Erik, 2026-10-01), and
 *  it is kept because the contra line has one and is the longest row name on the card. */
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
  // HIS BUILD TIME IS NOT COSTED YET: said in words, with the door, instead of two $0 rows that would
  // read as an answer. The sentence and the Team-page link below are the whole of "nothing silent".
  const uncosted = money ? uncostedBuildTime(money) : null;
  // THE PROFIT AND LOSS: only the owner (or an office the owner shared it with) ever gets this card.
  // Both of the owner's optional sections are switched on only when there is money in them: the
  // build-time PAIR (never half of it) and the draw below the line.
  // THE EQUITY LINE IS ALWAYS DRAWN, $0.00 INCLUDED (Erik, 2026-10-01: "an actual draw from the owner is
  // considered equity and should be a line item below net profit stating what Ive taken out this
  // month"). It used to be switched on only when the figure was non-zero, and the figure has ONE source
  // - bank lines sorted as Owner's Draw - so an owner who draws by cheque from an account he does not
  // download, or anyone who has not sorted a bank download, got no row, no $0.00 and no sentence: a card
  // identical to yesterday's, with no way to tell "I drew nothing" from "the app cannot see my draws"
  // from "the line was never built". Whoever sees this card is entitled to the owner's money, so the row
  // is here, and ownerDrawUnseen decides whether the sentence and the door come with it.
  const pnl = t
    ? profitAndLoss(t, {
        otherIncome: Math.abs(t.otherIncome ?? 0) >= 0.005,
        stockInMaterials: true,
        margin: true,
        // The build-time PAIR, through the one predicate both this card and the accountant's Summary ask.
        ownerBuildTime: hasOwnerBuildTime(t),
        ownerDraw: true,
      })
    : [];
  // Zero draws THAT THE APP CAN SEE. Not the same claim as "he drew nothing", and said as such.
  const drawUnseen = money ? ownerDrawUnseen(money) : false;
  // The rows ABOVE the bottom line. Equity is drawn by hand under it, so it never joins this list -
  // a row below the rule must not be able to slide up into the subtractions by being in the same map.
  const said = pnl.filter((r) => {
    if (isBelowNetProfit(r.kind)) return false;
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
      case "equity":
        // BELOW THE BOTTOM LINE, and `said` above never hands one here: the draw is drawn by hand with
        // Net Profit so it cannot be mistaken for a subtraction. The case exists because PnlKind is
        // exhaustive - a kind this switch has not been told about used to render NOTHING, silently.
        return null;
    }
  };
  const net = pnl.find((r) => r.key === "net_profit");
  const draw = pnl.find((r) => r.key === "owner_draw");

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
              {/* WHAT THE BOTTOM LINE IS WORTH AN HOUR. It does NOT move when his build time is costed:
                  the allocation nets to zero, so `left` and his hours are both unchanged. On a JOB the
                  same phrase does move, because a job's profit really does carry his cost - two true
                  figures, which is why this one says "for each hour you worked" and the job says profit. */}
              {t.ownerHours > 0 && t.perOwnerHour !== null && (
                <p className="mt-1 text-right text-sm text-slate-600">
                  about {formatCurrency(t.perOwnerHour)} for each hour {voice.who} worked
                </p>
              )}
            </div>

            {/* OWNER'S DRAW: EQUITY, BELOW THE LINE (Erik, 2026-10-01: "an actual draw from the owner is
                considered equity and should be a line item below net profit stating what Ive taken out
                this month"). Drawn as a plain row, deliberately not bold and with no top rule of its
                own: it must never look like a total of the figure above it. And it says what it can
                see - bank lines sorted as Owner's Draw, not cash. */}
            {draw && (
              <div className="mt-3 border-t border-dashed border-slate-200 pt-2">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm text-slate-700">{draw.label}</span>
                  <span className="text-sm tabular-nums text-slate-800">{formatCurrency(draw.amount ?? 0)}</span>
                </div>
                {/* $0.00 IS NOT "YOU TOOK NOTHING OUT". The figure has ONE source - bank lines sorted as
                    Owner's Draw - so an empty one means "nothing this period that the app can see", and
                    the door that changes the answer is Drop Your Bank Download, the line directly below
                    this card on this same page. Named rather than linked, because it is a file picker
                    three inches away and a link to somewhere else would be the longer way round. */}
                <p className="mt-0.5 text-xs text-slate-500">
                  Equity, not a cost: it is not taken off Net Profit. {money.ownerDrawSeen}
                  {drawUnseen ? " Nothing this period that the app can see — Drop Your Bank Download below to change that." : ""}
                </p>
              </div>
            )}

            {/* NOTHING SILENT, AND NO GUESSED RATE. His on-site hours are a direct cost, but nobody has
                said what an hour of his build time costs, so it is not costed at all and this says so,
                in his register, with the box that fixes it. */}
            {uncosted && (
              <div className="mt-3">
                <p className="text-xs text-slate-500">{buildTimeNotCostedSentence(uncosted.hours, voice.viewerIsOwner ? "you" : voice.who)}</p>
                <a href="/team" className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand-600">
                  Set Build Time Cost Rate
                </a>
              </div>
            )}

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
