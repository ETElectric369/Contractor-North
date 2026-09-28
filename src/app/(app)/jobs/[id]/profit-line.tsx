import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { WhyFold } from "@/components/why-fold";
import { formatCurrency, formatDuration } from "@/lib/utils";

const money = (n: number) => formatCurrency(n);
const cents = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * PROFIT IN ONE LINE (W1-23), at the bottom of the Costs tab so what is OPEN still leads it. "Profit
 * $X · Y%" in green or red, or "Nothing Collected Yet · Spent $Z" while nothing has come in (never a
 * made-up 0%). The Why? fold holds the rows the old seven-to-ten figure strip spread across the
 * card, and one thin bar the width of what was collected, split into where it went.
 *
 * THE MATH DOES NOT CHANGE, AND IT IS NOT DONE HERE: profit and margin arrive from the page exactly
 * as it always worked them out (collected − crew labor − live orders − bills − petty cash; the same
 * as /analytics and Nort), and every row is a figure the page already had. Materials & Bills is the
 * live orders and the bills as ONE figure (materialCost + billsCost to the cent, the same as
 * Analytics). The owner's hours are hours only (0286: an owner is paid by draw, never a cost), and
 * the mileage is miles only, not in profit.
 */
export function ProfitLine({
  collected,
  crewLabor,
  crewHours,
  ownerHours,
  ownerHoursLabel,
  materialsAndBills,
  shelfTouched,
  tickets,
  fromStock,
  pettyCash,
  miles,
  profit,
  margin,
  perOwnerHour,
  perHourPhrase,
}: {
  /** Collected on the job, net of refunds (the page's revenue). */
  collected: number;
  crewLabor: number;
  crewHours: number;
  ownerHours: number;
  ownerHoursLabel: string;
  /** The live orders and the bills, as one figure. */
  materialsAndBills: number;
  /** Stock touched this job: its own tickets and what it took from stock are said. */
  shelfTouched: boolean;
  tickets: number;
  fromStock: number;
  pettyCash: number;
  miles: number;
  profit: number;
  margin: number;
  perOwnerHour: number | null;
  perHourPhrase: string;
}) {
  const spent = cents(crewLabor + materialsAndBills + pettyCash);
  const anyCollected = collected > 0.005;
  const loss = profit < -0.005;
  // The bar: the width of what was collected, split into where it went, and the profit left. A loss
  // runs past what was collected, so the bar is the spend's width then, and the part past the
  // collected mark is red.
  const whole = Math.max(collected, spent, 0.01);
  const pct = (n: number) => `${Math.max(0, Math.min(100, (Math.max(0, n) / whole) * 100))}%`;
  const collectedMark = Math.max(0, Math.min(100, (collected / whole) * 100));

  return (
    <Card>
      <CardContent className="py-4">
        {anyCollected ? (
          <div className={`text-lg font-semibold ${loss ? "text-red-600" : "text-green-600"}`}>
            Profit {money(profit)} · {margin.toFixed(0)}%
          </div>
        ) : (
          <div className="text-lg font-semibold text-slate-700">Nothing Collected Yet · Spent {money(spent)}</div>
        )}
        <WhyFold>
          {anyCollected && (
            <div
              className="relative mb-2 mt-1 flex h-2 w-full max-w-md overflow-hidden rounded-full bg-slate-100"
              role="img"
              aria-label={`${money(collected)} collected: crew labor ${money(crewLabor)}, materials and bills ${money(materialsAndBills)}${pettyCash ? `, petty cash ${money(pettyCash)}` : ""}, ${loss ? `a loss of ${money(-profit)}` : `profit ${money(profit)}`}`}
            >
              <div className="h-full bg-slate-500" style={{ width: pct(crewLabor) }} />
              <div className="h-full bg-slate-400" style={{ width: pct(materialsAndBills) }} />
              {Math.abs(pettyCash) > 0.005 && <div className="h-full bg-slate-300" style={{ width: pct(pettyCash) }} />}
              {!loss && <div className="h-full bg-green-500" style={{ width: pct(profit) }} />}
              {loss && <div className="absolute inset-y-0 right-0 bg-red-500/80" style={{ left: `${collectedMark}%` }} />}
            </div>
          )}
          <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm text-slate-600">
            <dt>Collected</dt>
            <dd className="text-right text-slate-800">{money(collected)}</dd>
            <dt>Crew Labor · {formatDuration(crewHours)}</dt>
            <dd className="text-right text-slate-800">{money(crewLabor)}</dd>
            {ownerHours > 0 && (
              <>
                {/* HOURS ONLY, NO DOLLARS (0286): the owner is paid by owner's draw. */}
                <dt>{ownerHoursLabel}</dt>
                <dd className="text-right text-slate-800">{formatDuration(ownerHours)}</dd>
              </>
            )}
            <dt>
              Materials &amp; Bills
              {shelfTouched && (
                <span className="block text-xs text-slate-500">
                  Tickets {money(tickets)} · From Stock {money(fromStock)}
                </span>
              )}
            </dt>
            <dd className="text-right text-slate-800">{money(materialsAndBills)}</dd>
            {Math.abs(pettyCash) > 0.005 && (
              <>
                <dt>
                  <Link href="/petty-cash" className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">
                    Petty Cash
                  </Link>
                </dt>
                <dd className="self-center text-right text-slate-800">{money(pettyCash)}</dd>
              </>
            )}
            <dt>Mileage · not in profit</dt>
            <dd className="text-right text-slate-800">{miles.toFixed(1)} mi</dd>
            {perOwnerHour !== null && (
              <>
                <dt>{perHourPhrase.replace(/^\w/, (c) => c.toUpperCase())}</dt>
                <dd className={`text-right ${perOwnerHour >= 0 ? "text-green-700" : "text-red-600"}`}>{money(perOwnerHour)}</dd>
              </>
            )}
          </dl>
        </WhyFold>
      </CardContent>
    </Card>
  );
}
