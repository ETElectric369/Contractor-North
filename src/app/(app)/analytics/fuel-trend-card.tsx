"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { weekLabel, type FuelTrend } from "@/lib/analytics/fuel-trend";

/**
 * FUEL, BY THE WEEK (Erik, 2026-09-27): one number, what fuel costs a week, and the last 13 weeks
 * as bars with their figures on them and a dashed line at the average. Tapping a week puts that
 * week in the headline; tapping it again goes back to the average. One line under the bars: fuel
 * as a share of money in, the average fill, how many fills.
 *
 * AT 375px every week is a 44px column (a thumb's width) and the row scrolls sideways inside the
 * card, starting at this week. Identity is never colour alone: one series, named by the title, and
 * every bar carries its figure. Fuel is pink-800 wherever it is drawn (this card, Money by Month's
 * Fuel bars, the bank card's Where The Money Went).
 */

const PLOT = 112; // px the tallest bar may use

/** Whole dollars: "$314", the way a person says a weekly figure. */
const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${Math.abs(Math.round(cents / 100)).toLocaleString("en-US")}`;

export function FuelTrendCard({ trend }: { trend: FuelTrend }) {
  const [picked, setPicked] = useState<string | null>(null);
  const max = Math.max(1, ...trend.weeks.map((w) => w.cents), trend.avgWeekCents);
  const week = picked ? trend.weeks.find((w) => w.start === picked) ?? null : null;
  const heightOf = (c: number) => Math.max(c > 0 ? 3 : 0, Math.round((Math.max(0, c) / max) * PLOT));
  const avgY = heightOf(trend.avgWeekCents);
  const facts = [
    trend.sharePct !== null ? `${trend.sharePct}% of money in` : null,
    trend.fills ? `avg fill ${dollars(trend.avgFillCents)}` : null,
    `${trend.fills} ${trend.fills === 1 ? "fill" : "fills"}`,
  ].filter(Boolean);

  return (
    <Card className="mb-6 p-4" aria-label="Fuel by week">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Fuel</h2>
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="inline-block w-4 border-t border-dashed border-slate-500" aria-hidden="true" /> Average · Last {trend.weeksCounted || trend.weeks.length} Weeks
        </span>
      </div>
      <p className="mt-1 text-3xl font-bold tabular-nums text-slate-900" aria-live="polite">
        {week ? dollars(week.cents) : dollars(trend.avgWeekCents)}
        <span className="ml-1 text-base font-medium text-slate-500">{week ? `Week Of ${weekLabel(week.start)}` : "/ week"}</span>
      </p>

      <div className="mt-3 overflow-x-auto overscroll-x-contain" dir="rtl">
        {/* w-max: the row is as wide as its 13 columns, so in the right-to-left scroller every week
            is reachable and the newest shows first. */}
        <div dir="ltr" className="relative flex w-max min-w-full items-end gap-0.5" style={{ height: PLOT + 36 }}>
          {/* The average, dashed, across every week. */}
          {trend.avgWeekCents > 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-500"
              style={{ bottom: 18 + avgY }}
              aria-hidden="true"
            />
          )}
          {trend.weeks.map((w) => {
            const on = picked === w.start;
            const dim = picked !== null && !on;
            return (
              <button
                key={w.start}
                type="button"
                onClick={() => setPicked(on ? null : w.start)}
                aria-pressed={on}
                title={`Week of ${weekLabel(w.start)}: ${formatCurrency(w.cents / 100)} in ${w.fills} ${w.fills === 1 ? "fill" : "fills"}`}
                className="relative flex min-w-11 flex-1 flex-col items-center justify-end rounded-md pb-0 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                style={{ height: PLOT + 36 }}
              >
                <span className={`rounded bg-white px-0.5 text-[10px] font-medium tabular-nums ${dim ? "text-slate-400" : "text-slate-700"}`}>
                  {w.cents ? Math.round(w.cents / 100).toLocaleString("en-US") : ""}
                </span>
                <span
                  className={`mt-0.5 block w-6 rounded-t-[4px] ${on ? "bg-pink-900" : "bg-pink-800"} ${dim ? "opacity-40" : ""}`}
                  style={{ height: heightOf(w.cents) }}
                />
                <span className="mt-1 h-3.5 text-[10px] leading-3 text-slate-500">{`${Number(w.start.slice(5, 7))}/${Number(w.start.slice(8, 10))}`}</span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-sm text-slate-600">{facts.join(" · ")}</p>
      {/* WHAT IT COUNTS, said: every business cost in the Fuel bucket (0362), however it came in:
          a bank download's fill-ups, a pump receipt filed as Fuel, petty cash, a cost added by hand. */}
      <p className="mt-1 text-xs text-slate-500">Counts every business cost filed as Fuel: bank download fill-ups, pump receipts, petty cash and costs added by hand. Truck repairs and parts are Auto, not in it.</p>
    </Card>
  );
}
