import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { WhyFold } from "@/components/why-fold";
import { formatCurrency, formatDuration } from "@/lib/utils";
import { buildTimeNotCostedSentence } from "@/lib/build-time-cost";

const money = (n: number) => formatCurrency(n);
const cents = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * PROFIT IN ONE LINE (W1-23), at the bottom of the Costs tab so what is OPEN still leads it. "Profit
 * $X · Y%" in green or red, or "Nothing Collected Yet · Spent $Z" while nothing has come in (never a
 * made-up 0%). The Why? fold holds the rows the old seven-to-ten figure strip spread across the
 * card, and one thin bar the width of what was collected, split into where it went.
 *
 * THE MATH IS NOT DONE HERE: profit and margin arrive from the page exactly as it works them out
 * (collected − all labour − live orders − bills − petty cash; the same as /analytics and Nort), and
 * every row is a figure the page already had. Materials & Bills is the live orders and the bills as ONE
 * figure (materialCost + billsCost to the cent, the same as Analytics), and the mileage is miles only,
 * never in profit.
 *
 * THE OWNER'S BUILD TIME IS A COST OF THIS JOB (Erik, 2026-10-01), on its own row, in dollars - it used
 * to be hours with no figure beside them (0286), which made every job he worked read more profitable
 * than it was, and he works most of the hours. It is still never a WAGE: nothing pays him for it, and
 * the company's profit and loss books the same amount straight back so his tax figure is untouched.
 * Until he sets a cost rate the row says so in words and the profit is exactly what it was.
 */
export function ProfitLine({
  collected,
  crewLabor,
  crewHours,
  ownerHours,
  ownerCost,
  uncostedOwnerHours,
  ownerHoursLabel,
  ownerWho,
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
  /** CREW labour only: the owner's build time is its own row below it. */
  crewLabor: number;
  crewHours: number;
  ownerHours: number;
  /** What the owner's hours on this job cost, at his cost rate. $0 while no rate is set. */
  ownerCost: number;
  /** His hours here with no cost rate behind them: said in words, never costed at $0 in silence. */
  uncostedOwnerHours: number;
  ownerHoursLabel: string;
  /** "you" / "Erik" / "the owners": whose build time the sentence is about. */
  ownerWho: string;
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
  // THE OWNER'S BUILD TIME IS PART OF WHAT THIS JOB SPENT. Left out, the bar's segments would not add
  // up to the profit printed above it, because the page's own profit subtracts it.
  const spent = cents(crewLabor + ownerCost + materialsAndBills + pettyCash);
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
              aria-label={`${money(collected)} collected: crew labor ${money(crewLabor)}${ownerCost > 0.005 ? `, ${ownerHoursLabel} build time ${money(ownerCost)}` : ""}, materials and bills ${money(materialsAndBills)}${pettyCash ? `, petty cash ${money(pettyCash)}` : ""}, ${loss ? `a loss of ${money(-profit)}` : `profit ${money(profit)}`}`}
            >
              <div className="h-full bg-slate-500" style={{ width: pct(crewLabor) }} />
              {/* THE OWNER'S BUILD TIME, its own segment (slate-600, darker than crew's slate-500 so the
                  two read apart without colour alone carrying it: the row below names the figure). */}
              {ownerCost > 0.005 && <div className="h-full bg-slate-600" style={{ width: pct(ownerCost) }} />}
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
                {/* BUILD TIME, WITH ITS DOLLARS (Erik, 2026-10-01). The hours stay in the row name, so
                    the figure is always read against the time it bought. No rate set yet: the hours
                    alone, and the sentence under the list says why there is no figure. */}
                <dt>
                  {ownerHoursLabel} · {formatDuration(ownerHours)}
                </dt>
                <dd className="text-right text-slate-800">{uncostedOwnerHours >= ownerHours ? "—" : money(ownerCost)}</dd>
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
          {/* NOTHING SILENT, AND NO GUESSED RATE. His hours are a cost of this job, but nobody has said
              what an hour of his build time costs, so this job's profit is reading HIGH by whatever it
              turns out to be - said plainly, with the box that fixes it. */}
          {uncostedOwnerHours > 0.005 && (
            <p className="mt-2 max-w-md text-xs text-slate-500">
              {buildTimeNotCostedSentence(uncostedOwnerHours, ownerWho)} This job&apos;s profit reads high until then.
            </p>
          )}
        </WhyFold>
      </CardContent>
    </Card>
  );
}
