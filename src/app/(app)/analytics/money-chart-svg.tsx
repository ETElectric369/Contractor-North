import { formatCurrency } from "@/lib/utils";
import { monthLongLabel } from "@/lib/analytics/owner-money";
import { CHART_FONT_PX, type ChartLayout, type MoneyChartMonth, type MoneySeries } from "@/lib/analytics/money-chart";

/**
 * The Money by Month plot, drawn as plain inline SVG from layoutMoneyChart's geometry. No hooks and
 * no state: the client wrapper (money-chart-card.tsx) owns the toggles and the month tap and hands
 * this the result, and the tests render it on its own.
 *
 * HOW IT FITS ANY WIDTH WITHOUT SCALING THE TEXT: each month group is positioned by PERCENTAGE of
 * the plot's width (a nested <svg> at x="N%"), while bars and figures inside it are drawn in real
 * pixels around the group's centre. So a phone gets the groups at their narrowest (the plot scrolls
 * sideways inside its own box when even that does not fit), a desktop spreads them across the card,
 * and a 10px figure is 10px everywhere. The y axis sits outside the scroller, so it stays put.
 */
export function MoneyChartSvg({
  layout,
  months,
  series,
  selected,
  hovered,
  ariaLabel,
  onMonthClick,
  onMonthHover,
}: {
  layout: ChartLayout;
  months: MoneyChartMonth[];
  /** The series that are ON, in order. */
  series: MoneySeries[];
  selected: string | null;
  hovered?: string | null;
  ariaLabel: string;
  onMonthClick?: (month: string) => void;
  onMonthHover?: (month: string | null) => void;
}) {
  const n = Math.max(1, layout.groups.length);
  // Selected only when the chart DRAWS that month: a month it does not draw would otherwise fade every
  // bar and press no button (the page clamps it too; this holds for any caller).
  const sel = selected != null && layout.groups.some((g) => g.month === selected) ? selected : null;
  const pct = (i: number) => `${((i + 0.5) / n) * 100}%`;
  const fillOf = new Map(series.map((s) => [s.key, s.fill]));
  const labelOf = new Map(series.map((s) => [s.key, s.label]));
  const exactLine = (m: MoneyChartMonth) =>
    `${monthLongLabel(m.month)}: ${series.map((s) => `${s.label} ${formatCurrency(m.values[s.key] ?? 0)}`).join(", ")}`;
  const halo = { paintOrder: "stroke", stroke: "white", strokeWidth: 3, strokeLinejoin: "round" } as const;

  return (
    <div className="flex">
      {/* The y axis: fixed, outside the scroller. */}
      <svg width={layout.axisWidth} height={layout.height} className="shrink-0 overflow-visible" aria-hidden="true">
        {layout.ticks.map((t) => (
          <text
            key={t.value}
            x={layout.axisWidth - 6}
            y={t.y + 3.5}
            textAnchor="end"
            fontSize={CHART_FONT_PX}
            className="fill-slate-500 tabular-nums"
          >
            {t.label}
          </text>
        ))}
      </svg>

      {/* dir="rtl" starts the scroller at its right end (the most recent month) with no script; the
          content inside is ordinary left-to-right. */}
      <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain" dir="rtl" data-money-chart-scroller="">
        {/* The groups are laid out BETWEEN the edge room (padLeft/padRight), so the first and last
            figures always have somewhere to draw inside the scroller instead of being cut off at
            its edge. The gridlines span the whole width, edge room included. */}
        <div
          dir="ltr"
          className="relative w-full"
          style={{ minWidth: layout.minPlotWidth, height: layout.height, paddingLeft: layout.padLeft, paddingRight: layout.padRight }}
        >
          <svg width="100%" height={layout.height} className="absolute inset-0 block" aria-hidden="true">
            {/* Faint gridlines, then a stronger zero line over them. */}
            {layout.ticks
              .filter((t) => t.value !== 0)
              .map((t) => (
                <line key={t.value} x1="0" x2="100%" y1={t.y} y2={t.y} className="stroke-slate-100" strokeWidth={1} />
              ))}
            <line x1="0" x2="100%" y1={layout.zeroY} y2={layout.zeroY} className="stroke-slate-300" strokeWidth={1} />
          </svg>
          <svg
            width="100%"
            height={layout.height}
            role="img"
            aria-label={ariaLabel}
            className="relative block overflow-visible"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {/* The selected (or hovered) month's column. */}
            {layout.groups.map((g, gi) =>
              g.month === sel || g.month === hovered ? (
                <rect
                  key={`hl-${g.month}`}
                  x={`${(gi / n) * 100}%`}
                  y={0}
                  width={`${100 / n}%`}
                  height={layout.height}
                  rx={6}
                  className={g.month === sel ? "fill-slate-100" : "fill-slate-50"}
                />
              ) : null,
            )}
            {/* The highlighted column covers the zero line underneath; drawn again here over it. */}
            <line x1="0" x2="100%" y1={layout.zeroY} y2={layout.zeroY} className="stroke-slate-300" strokeWidth={1} />

            {layout.groups.map((g, gi) => {
              // Another month is selected: its BARS step back. Its figures stay at full strength, so
              // every number on the chart stays readable while one month is picked.
              const dim = sel != null && g.month !== sel;
              return (
                <svg key={g.month} x={pct(gi)} y={0} width={1} height={layout.height} overflow="visible" data-month={g.month}>
                  <g className={`motion-safe:transition-opacity ${dim ? "opacity-40" : "opacity-100"}`}>
                    {g.bars.map((b) =>
                      b.path ? (
                        <path key={b.key} d={b.path} className={fillOf.get(b.key)} data-series={b.key} data-value={b.value} data-height={b.h.toFixed(2)}>
                          <title>{`${labelOf.get(b.key)}: ${formatCurrency(b.value)}`}</title>
                        </path>
                      ) : null,
                    )}
                  </g>
                  {g.bars.map((b) =>
                    b.label ? (
                      <text
                        key={`l-${b.key}`}
                        x={b.labelX}
                        y={b.labelY}
                        textAnchor="middle"
                        fontSize={CHART_FONT_PX}
                        className="fill-slate-700 font-medium"
                        style={halo}
                      >
                        {b.label}
                      </text>
                    ) : null,
                  )}
                  <text
                    x={0}
                    y={layout.monthY}
                    textAnchor="middle"
                    fontSize={11}
                    className={g.month === sel ? "fill-slate-900 font-semibold" : "fill-slate-500"}
                  >
                    {g.short}
                  </text>
                  {g.year && (
                    <text x={0} y={layout.yearY} textAnchor="middle" fontSize={CHART_FONT_PX} className="fill-slate-500">
                      {g.year}
                    </text>
                  )}
                </svg>
              );
            })}
          </svg>

          {/* Every value that is on is $0: the frame keeps its height and says so in words. */}
          {layout.flat && (
            <p
              className="pointer-events-none absolute inset-x-0 px-4 text-center text-xs text-slate-500"
              style={{ top: Math.max(0, layout.zeroY / 2 - 8) }}
            >
              {series.length === 1
                ? `${series[0].label} is $0 in every month shown.`
                : `${series.map((s) => s.label).join(", ").replace(/, ([^,]*)$/, " and $1")} are $0 in every month shown.`}
            </p>
          )}

          {/* The tap targets: one real button per month, the full height of its column, over the
              groups only (not the edge room). */}
          <div className="absolute inset-y-0 flex" style={{ left: layout.padLeft, right: layout.padRight }}>
            {months.map((m) => (
              <button
                key={m.month}
                type="button"
                aria-pressed={m.month === sel}
                aria-label={exactLine(m)}
                title={exactLine(m)}
                onClick={onMonthClick ? () => onMonthClick(m.month) : undefined}
                onPointerEnter={onMonthHover ? (e) => e.pointerType === "mouse" && onMonthHover(m.month) : undefined}
                onPointerLeave={onMonthHover ? (e) => e.pointerType === "mouse" && onMonthHover(null) : undefined}
                className="min-w-0 flex-1 rounded-md focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
              />
            ))}
          </div>
        </div>
      </div>

      {/* The same numbers as a table, for a screen reader. The WRAPPER is sr-only, not the table: a
          table never shrinks below its content, so an sr-only table widened the page on a phone. */}
      <div className="sr-only">
        <table>
          <caption>Money by Month</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}>
                <th scope="row">{monthLongLabel(m.month)}</th>
                {series.map((s) => (
                  <td key={s.key}>{formatCurrency(m.values[s.key] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
