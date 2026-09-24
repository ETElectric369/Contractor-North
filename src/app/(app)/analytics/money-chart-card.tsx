"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { monthLongLabel, type OwnerMoneySegmentKey } from "@/lib/analytics/owner-money";
import {
  MONEY_CHART_STORAGE_KEY,
  defaultSeriesOn,
  layoutMoneyChart,
  monthRangeLabel,
  parseStoredSeries,
  toggleSeries,
  type MoneyChartData,
  type MoneySeriesKey,
} from "@/lib/analytics/money-chart";
import { MoneyChartSvg } from "./money-chart-svg";

/**
 * MONEY BY MONTH: the first card on /analytics. For each month, Collected and Left For You side by
 * side, each bar drawn to scale with its figure on it, and chips that add the cost lines as more
 * bars in the same group (never stacked, so every bar reads against the same axis).
 *
 * Tapping a month shows that month in the Left For You card right below (?w=YYYY-MM, validated on
 * the server); tapping it again goes back to the segment it was tapped from. The exact figures of
 * the hovered or selected month read out under the chips.
 *
 * `data` is already cut to what this viewer may see (buildMoneyChartData): an office viewer the owner
 * has not allowed gets Collected only, with no chips, and a month tap stays on this card.
 */
export function MoneyChartCard({
  data,
  problem,
  selectedMonth,
  segment,
  linkMonths,
  emptyLine = "Nothing received yet. Your first payment will show up here.",
}: {
  data: MoneyChartData | null;
  problem: string | null;
  selectedMonth: string | null;
  segment: OwnerMoneySegmentKey;
  /** True when the Left For You card is below to show a tapped month. */
  linkMonths: boolean;
  /** What an empty chart says (emptyChartSentence): "nothing yet" only when no payment ever came in. */
  emptyLine?: string;
}) {
  const router = useRouter();
  // The card below is re-read on the server after a month tap; until it arrives the chart already
  // shows the new month, so the wait is SAID (the not-silent rule), never left to look settled.
  const [pending, startNav] = useTransition();
  const [refused, setRefused] = useState(false);
  const series = useMemo(() => data?.series ?? [], [data]);
  const available = useMemo(() => series.map((s) => s.key), [series]);
  const [on, setOn] = useState<MoneySeriesKey[]>(() => defaultSeriesOn(series));
  const [selected, setSelected] = useState<string | null>(selectedMonth);
  const [hovered, setHovered] = useState<string | null>(null);

  // The remembered chips, after first paint (the server rendered the defaults). Browser storage can
  // throw or come back empty in a private window: the defaults stand, nothing breaks.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(MONEY_CHART_STORAGE_KEY);
    } catch {
      raw = null;
    }
    if (raw != null) setOn(parseStoredSeries(raw, series));
  }, [series]);

  // A navigation (a segment chosen on the card, Back) moves the selection with the URL.
  useEffect(() => setSelected(selectedMonth), [selectedMonth]);

  // A refused tap (the last chip on) says why on screen for a moment: a tooltip never shows on a phone.
  useEffect(() => {
    if (!refused) return;
    const t = window.setTimeout(() => setRefused(false), 2500);
    return () => window.clearTimeout(t);
  }, [refused]);

  function flip(key: MoneySeriesKey) {
    const next = toggleSeries(on, key, available);
    if (next === on) {
      setRefused(true);
      return;
    }
    setRefused(false);
    setOn(next);
    try {
      window.localStorage.setItem(MONEY_CHART_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not remembered this time; the chart still changed.
    }
  }

  function tapMonth(month: string) {
    const next = selected === month ? null : month;
    setSelected(next);
    if (!linkMonths) return;
    const href = next ? `/analytics?w=${next}&from=${segment}` : `/analytics?w=${segment}`;
    startNav(() => router.push(href, { scroll: false }));
  }

  const onSeries = useMemo(() => series.filter((s) => on.includes(s.key)), [series, on]);
  const months = useMemo(() => data?.months ?? [], [data]);
  const layout = useMemo(() => layoutMoneyChart(months, onSeries.map((s) => s.key)), [months, onSeries]);
  const readoutMonth = months.find((m) => m.month === (hovered ?? selected));
  // The readout's room is reserved for its LONGEST line (the longest month name and each series'
  // widest figure), so a tap or hover that fills it never pushes the bars down under the finger.
  const readoutSizer = useMemo(
    () =>
      onSeries.map((s) => {
        const widest = months.map((m) => formatCurrency(m.values[s.key] ?? 0)).reduce((a, b) => (b.length > a.length ? b : a), "");
        return `${s.label} ${widest}`;
      }),
    [months, onSeries],
  );
  const range = monthRangeLabel(months.map((m) => m.month));
  const ariaLabel = `Money by Month, ${range ? range.replace("\u2013", "to") : "no months yet"}. ${onSeries.map((s) => s.label).join(" and ")} for each month. ${months
    .map((m) => `${monthLongLabel(m.month)}: ${onSeries.map((s) => `${s.label} ${formatCurrency(m.values[s.key] ?? 0)}`).join(", ")}`)
    .join(". ")}`;

  return (
    <Card className="mb-6">
      <div className="border-b border-slate-100 px-4 pb-3 pt-3 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 className="text-sm font-semibold text-slate-900">Money by Month</h2>
          {/* One status line, in the header so it never moves the chart: the wait for the card
              below after a month tap, a refused chip tap, or the months shown. */}
          <span className="text-xs text-slate-500" aria-live="polite">
            {pending ? "Loading the card below…" : refused ? "At least one stays on" : range}
          </span>
        </div>
        {/* No chips over an empty or failed chart: they would switch nothing on screen. */}
        {series.length > 1 && months.length > 0 && !problem && (
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Show on the chart">
            {series.map((s) => {
              const pressed = on.includes(s.key);
              const last = pressed && on.length === 1;
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={pressed}
                  aria-disabled={last || undefined}
                  title={last ? "At least one stays on" : undefined}
                  onClick={() => flip(s.key)}
                  className={`inline-flex min-h-[44px] items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors ${
                    pressed ? "border-slate-300 bg-white text-slate-900 shadow-sm" : "border-slate-200 bg-slate-50 text-slate-500 hover:text-slate-700"
                  } ${last ? "cursor-default" : ""}`}
                >
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${s.swatch} ${pressed ? "" : "opacity-40"}`} aria-hidden="true" />
                  {s.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-3 pb-3 pt-3 sm:px-5">
        {problem || !data ? (
          <div className="py-6">
            <p className="text-sm text-slate-600">
              No chart right now because {problem ?? "the records could not be read"}. Nothing changed. Tap Reload to try again.
            </p>
            <a href="/analytics" className="mt-2 inline-flex min-h-[44px] items-center text-sm font-medium text-brand">
              Reload
            </a>
          </div>
        ) : months.length === 0 ? (
          <div className="relative flex h-40 items-center justify-center border-b border-slate-300">
            <p className="px-4 text-center text-sm text-slate-500">{emptyLine}</p>
          </div>
        ) : (
          <>
            {/* Two layers in one grid cell: an invisible copy of the longest readout holds the height
                at every width, the live readout draws over it. */}
            <div className="mb-1 grid text-xs tabular-nums">
              <p className="invisible col-start-1 row-start-1" aria-hidden="true">
                <span className="whitespace-nowrap font-semibold">September 2026</span>
                {readoutSizer.map((t) => (
                  <Fragment key={t}>
                    {" · "}
                    <span className="whitespace-nowrap">{t}</span>
                  </Fragment>
                ))}
              </p>
              <p className="col-start-1 row-start-1 text-slate-600" aria-live="polite">
                {readoutMonth ? (
                  <>
                    <span className="whitespace-nowrap font-semibold text-slate-900">{monthLongLabel(readoutMonth.month)}</span>
                    {/* The separator sits OUTSIDE each no-wrap figure, so the line breaks between
                        figures on a phone instead of running off the card. */}
                    {onSeries.map((s) => (
                      <Fragment key={s.key}>
                        {" · "}
                        <span className="whitespace-nowrap">
                          {s.label} {formatCurrency(readoutMonth.values[s.key] ?? 0)}
                        </span>
                      </Fragment>
                    ))}
                  </>
                ) : (
                  <span className="text-slate-500">{linkMonths ? "Tap a month to see it in the card below." : "Tap a month for its exact figures."}</span>
                )}
              </p>
            </div>
            <MoneyChartSvg
              layout={layout}
              months={months}
              series={onSeries}
              selected={selected}
              hovered={hovered}
              ariaLabel={ariaLabel}
              onMonthClick={tapMonth}
              onMonthHover={setHovered}
            />
          </>
        )}
      </div>
    </Card>
  );
}
