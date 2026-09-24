import type { OwnerMoney } from "@/lib/analytics/owner-money";

/**
 * MONEY BY MONTH: the chart at the top of /analytics (Erik, 2026-09-24: "Money collected this month
 * with months and numbers with side by side bar graphs ... i need visual and so do most all
 * contractors").
 *
 * Every figure comes from computeOwnerMoney's per-month rows, the same rows the Left For You card
 * below it totals, so the chart and the card can never disagree. This file is the pure half: which
 * series exist for this viewer, which months to draw, the y scale, and where every bar and label
 * goes. The SVG component only draws what this returns, which is what lets the tests check the
 * geometry without a browser.
 */

// ── Series ───────────────────────────────────────────────────────────────────

export type MoneySeriesKey = "collected" | "left" | "materials" | "crewPay" | "mileage" | "business";

export type MoneySeries = {
  key: MoneySeriesKey;
  /** Title Case: it is the chip's label and the legend at once. */
  label: string;
  /** Tailwind classes, spelled out whole so the compiler finds them. Colour follows the series,
   *  never its position: turning one on or off never repaints the others. */
  fill: string;
  swatch: string;
  defaultOn: boolean;
};

/** Fixed order: the bars in a month read left to right in this order whichever are on. The palette
 *  was run through the dataviz validator: every adjacent pair clears colour-blind separation, and
 *  every bar also carries its figure, so identity is never colour alone. */
const SERIES: Record<MoneySeriesKey, Omit<MoneySeries, "key" | "label"> & { label: string }> = {
  collected: { label: "Collected", fill: "fill-brand", swatch: "bg-brand", defaultOn: true },
  left: { label: "Owner's Draw", fill: "fill-green-600", swatch: "bg-green-600", defaultOn: true },
  materials: { label: "Materials & Bills", fill: "fill-indigo-500", swatch: "bg-indigo-500", defaultOn: false },
  crewPay: { label: "Crew Pay", fill: "fill-amber-600", swatch: "bg-amber-600", defaultOn: false },
  mileage: { label: "Crew Mileage", fill: "fill-sky-600", swatch: "bg-sky-600", defaultOn: false },
  business: { label: "Business Costs", fill: "fill-pink-500", swatch: "bg-pink-500", defaultOn: false },
};
export const MONEY_SERIES_ORDER: MoneySeriesKey[] = ["collected", "left", "materials", "crewPay", "mileage", "business"];

export type MoneyChartMonth = { month: string; values: Partial<Record<MoneySeriesKey, number>> };
export type MoneyChartData = { series: MoneySeries[]; months: MoneyChartMonth[] };

const tiny = (v: number | undefined) => !v || Math.abs(v) < 0.005;

/**
 * What this viewer's chart holds. `ownerFigures` is the page's existing visibility answer (the
 * owner, or office staff while "Office Can See This" is on). Without it the chart is Collected ONLY:
 * the other series are not hidden in the browser, they are never put in the data, so nothing about
 * the owner's figures reaches an office viewer the owner has not allowed.
 *
 * A COST series (Materials & Bills, Crew Pay, Crew Mileage, Business Costs) is offered only when some
 * month on the chart holds some, the way the card only prints a line when there is one: a solo owner
 * with no crew never gets a Crew Pay chip that would draw nothing. Crew Mileage is its own series (the
 * two-bucket law: never folded into crew pay). Collected and Left are always offered to the owner.
 *
 * Leading months where nothing came in or went out are trimmed, so a company whose books start in
 * April shows April onward, not six empty slots. A $0 month AFTER the first one keeps its slot.
 */
export function buildMoneyChartData(money: OwnerMoney, opts: { ownerFigures: boolean; leftLabel: string }): MoneyChartData {
  const allowed: MoneySeriesKey[] = opts.ownerFigures ? MONEY_SERIES_ORDER : ["collected"];
  const valueOf = (m: OwnerMoney["months"][number], k: MoneySeriesKey): number => {
    switch (k) {
      case "collected":
        return m.received;
      case "left":
        return m.left;
      case "materials":
        return m.materialsAndBills;
      case "crewPay":
        return m.crewPay;
      case "mileage":
        return m.crewMileagePaid;
      case "business":
        return m.businessCostsTotal;
    }
  };
  // What decides "nothing happened" is every money line the viewer may see. For the owner that is
  // received and every cost (left is their difference); for a Collected-only viewer it is received
  // alone, so even the trim cannot hint that a month had costs.
  const first = money.months.findIndex((m) => allowed.some((k) => !tiny(valueOf(m, k))));
  const shown = first < 0 ? [] : money.months.slice(first);
  const keys = allowed.filter((k) => k === "collected" || k === "left" || shown.some((m) => !tiny(valueOf(m, k))));
  const series = keys.map((key) => ({ key, ...SERIES[key], label: key === "left" ? opts.leftLabel : SERIES[key].label }));
  const months = shown.map((m) => ({
    month: m.month,
    values: Object.fromEntries(keys.map((k) => [k, valueOf(m, k)])) as Partial<Record<MoneySeriesKey, number>>,
  }));
  return { series, months };
}

/**
 * The month the chart may show as selected: the one asked for (?w=, already validated against the
 * 12 months on the server) only when the chart DRAWS it. A month before the trimmed start (a bookmark,
 * a hand-typed URL, a link from the owner to an office viewer whose Collected-only chart starts later)
 * would otherwise select nothing and fade every bar, while the card below printed a month of $0s from
 * before the books began. Not drawn means not selected: the page falls back to the segment.
 */
export function drawnMonth<M extends string>(month: M | null | undefined, data: MoneyChartData | null): M | null {
  if (!month || !data) return null;
  return data.months.some((m) => m.month === month) ? month : null;
}

/** The one sentence an empty chart says. "Nothing received yet" only when no payment was ever
 *  received: a company whose money came in before the chart's 12 months (dormant, seasonal) has
 *  received something, just not lately. `firstPaymentDay` is the org-local day of the first payment
 *  ever, `chartStart` the first day of the chart's 12 months. */
export function emptyChartSentence(firstPaymentDay: string | null | undefined, chartStart: string): string {
  return firstPaymentDay && firstPaymentDay < chartStart
    ? "Nothing received in the last 12 months."
    : "Nothing received yet. Your first payment will show up here.";
}

// ── Toggles ──────────────────────────────────────────────────────────────────

export const MONEY_CHART_STORAGE_KEY = "cn.analytics.moneyByMonth.series.v1";

export function defaultSeriesOn(series: MoneySeries[]): MoneySeriesKey[] {
  const on = series.filter((s) => s.defaultOn).map((s) => s.key);
  return on.length ? on : series.slice(0, 1).map((s) => s.key);
}

/** Flip one series. AT LEAST ONE STAYS ON: turning off the last one is refused (returns the same
 *  list), because an empty chart reads as "no money", which is false. Order is the fixed series
 *  order, never click order, so a bar never changes place. */
export function toggleSeries(on: MoneySeriesKey[], key: MoneySeriesKey, available: MoneySeriesKey[]): MoneySeriesKey[] {
  const set = new Set(on.filter((k) => available.includes(k)));
  if (set.has(key)) {
    if (set.size <= 1) return on;
    set.delete(key);
  } else if (available.includes(key)) {
    set.add(key);
  }
  return MONEY_SERIES_ORDER.filter((k) => set.has(k));
}

/** A remembered choice, read back safely: unknown or unavailable keys are dropped, and anything
 *  that leaves nothing on falls back to the defaults. */
export function parseStoredSeries(raw: string | null | undefined, series: MoneySeries[]): MoneySeriesKey[] {
  const available = series.map((s) => s.key);
  try {
    const arr = JSON.parse(String(raw ?? "null"));
    if (Array.isArray(arr)) {
      const keep = MONEY_SERIES_ORDER.filter((k) => available.includes(k) && arr.includes(k));
      if (keep.length) return keep;
    }
  } catch {
    // fall through to the defaults
  }
  return defaultSeriesOn(series);
}

// ── Words and numbers ────────────────────────────────────────────────────────

const MINUS = "−";
const oneDecimal = (n: number) => {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/** A bar's figure: "$780" under $1,000, "$4.2k", "$21k", "$1.2M". Negative reads "−$47". Under $10
 *  a figure that is not whole dollars keeps its cents ("$1.23", "−$0.30"): rounding there would print
 *  a -30¢ month as "$0" and a $1.23 test charge as "$1". */
export function compactMoney(v: number): string {
  const a = Math.abs(v);
  if (a < 0.005) return "$0";
  const sign = v < 0 ? MINUS : "";
  if (a < 9.995 && Math.abs(a - Math.round(a)) >= 0.005) return `${sign}$${a.toFixed(2)}`;
  if (a < 999.5) return `${sign}$${Math.round(a)}`;
  if (a < 9950) return `${sign}$${oneDecimal(a / 1000)}k`;
  if (a < 999_500) return `${sign}$${Math.round(a / 1000)}k`;
  return `${sign}$${oneDecimal(a / 1_000_000)}M`;
}

/** "Apr" under each month; the year on a second line on January, and on the first month when the
 *  range crosses a year, so a reader always knows which year the bars are in once it matters. */
export function monthAxisLabels(months: string[]): { short: string; year: string | null }[] {
  const crosses = months.length > 1 && months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  return months.map((m, i) => ({
    short: new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    year: m.slice(5, 7) === "01" || (i === 0 && crosses) ? m.slice(0, 4) : null,
  }));
}

/** The card's subtitle: "Apr – Sep 2026", "Oct 2025 – Sep 2026", "Sep 2026", or null for none. */
export function monthRangeLabel(months: string[]): string | null {
  if (!months.length) return null;
  const short = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const a = months[0];
  const b = months[months.length - 1];
  if (a === b) return `${short(a)} ${a.slice(0, 4)}`;
  return a.slice(0, 4) === b.slice(0, 4) ? `${short(a)} – ${short(b)} ${b.slice(0, 4)}` : `${short(a)} ${a.slice(0, 4)} – ${short(b)} ${b.slice(0, 4)}`;
}

// ── Scale ────────────────────────────────────────────────────────────────────

/**
 * Round y ticks: 0 and multiples of a 1/2/2.5/5 step, 3 to 5 of them, the top one at or above the
 * biggest bar. A negative tick is drawn only when the most negative bar reaches a quarter of a step:
 * a -$139 month against $21k bars gets a sliver of room below zero (enough for its bar and label),
 * not a -$10k gridline that squashes every other bar.
 *
 * Every step is WHOLE DOLLARS: the tick labels print whole dollars, so a 50¢ or $2.50 step put two
 * gridlines both labelled "$1", or $7.50 labelled "$8", on a chart whose only money is a $1.23 charge.
 */
export function niceScale(min: number, max: number): { ticks: number[]; lo: number; hi: number } {
  const lo0 = Math.min(0, min);
  const hi0 = Math.max(0, max);
  if (hi0 - lo0 < 0.005) return { ticks: [0], lo: 0, hi: 0 };
  const span = hi0 - lo0;
  let mag = Math.max(1, Math.pow(10, Math.floor(Math.log10(span / 4))));
  for (let guard = 0; guard < 12; guard++, mag *= 10) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * mag;
      if (!Number.isInteger(step)) continue;
      let nPos = Math.ceil(hi0 / step - 1e-9);
      const nNeg = -lo0 >= step / 4 ? Math.ceil(-lo0 / step - 1e-9) : 0;
      // A $1 step under a chart of $1 or less would leave two ticks; three reads as a scale.
      if (nPos === 1 && nNeg === 0) nPos = 2;
      const count = nPos + nNeg + 1;
      if (count > 5) continue;
      const ticks: number[] = [];
      for (let i = -nNeg; i <= nPos; i++) ticks.push(Math.round(i * step * 100) / 100 + 0); // + 0: never -0
      return { ticks, lo: nNeg ? -nNeg * step : lo0, hi: nPos * step };
    }
  }
  return { ticks: [0, hi0], lo: lo0, hi: hi0 };
}

// ── Layout ───────────────────────────────────────────────────────────────────

export const CHART_FONT_PX = 10;
const LINE = 11; // a 10px label's line
const PLOT_H = 168; // px for the value domain (lo..hi)
const GAP = 2; // surface gap between touching bars
const GROUP_PAD = 8; // air between month groups at the tightest width
const MIN_BAR_PX = 2; // a non-zero bar is never thinner than this: tiny is drawn, never hidden

/** How much wider than labelWidth a figure may really draw (the app's font runs a few percent wider
 *  than the estimate) plus its white halo, when deciding whether it fits inside the plot's edge. */
const EDGE_SLACK = 1.1;
const HALO_PX = 2;

/** Width of a figure at 10px with tabular numerals, a little generous so labels never touch. */
export function labelWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch === "." ? 3 : ch === "k" ? 5.2 : ch === "M" ? 8 : ch === MINUS ? 6 : 5.8;
  return w + 1;
}

export type BarGeom = {
  key: MoneySeriesKey;
  value: number;
  /** Left edge, px from the group's centre. */
  x: number;
  w: number;
  /** Top of the bar and its height, px. h = 0 means no bar (a $0 month). */
  y: number;
  h: number;
  label: string | null;
  /** The figure's centre (px from the group's centre) and baseline. */
  labelX: number;
  labelY: number;
  /** Rounded end: the data end is rounded, the baseline end square. */
  path: string | null;
};
export type GroupGeom = { month: string; short: string; year: string | null; bars: BarGeom[] };
export type ChartLayout = {
  height: number;
  zeroY: number;
  ticks: { value: number; y: number; label: string }[];
  groups: GroupGeom[];
  barWidth: number;
  /** The narrowest a month group may be before labels would collide; the plot scrolls below it. */
  minGroupWidth: number;
  /** The narrowest the whole plot may be: every group at its narrowest, plus the edge room. */
  minPlotWidth: number;
  /** Room left of the first group and right of the last, px, so the outermost figures are never cut
   *  off by the scroller's edge (a scroller clips what overflows it, and that part can never be
   *  scrolled into view). The groups are laid out between the two. */
  padLeft: number;
  padRight: number;
  /** True when every value that is on is $0: the frame keeps its full height and says so. */
  flat: boolean;
  axisWidth: number;
  monthY: number;
  yearY: number;
};

/** A bar as a path: 4px rounded at the data end (top for money in, bottom for a negative month),
 *  square where it meets zero. */
export function barPath(x: number, y: number, w: number, h: number, negative: boolean): string {
  const r = Math.min(4, w / 2, h);
  const f = (n: number) => Math.round(n * 100) / 100;
  if (!negative) {
    return `M${f(x)} ${f(y + h)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(y + h)}Z`;
  }
  return `M${f(x)} ${f(y)}V${f(y + h - r)}Q${f(x)} ${f(y + h)} ${f(x + r)} ${f(y + h)}H${f(x + w - r)}Q${f(x + w)} ${f(y + h)} ${f(x + w)} ${f(y + h - r)}V${f(y)}Z`;
}

/**
 * Where everything goes. Bars grow from one zero line; each carries its figure just above its top
 * (or just below a negative bar). Where two figures would overlap (two bars of nearly the same
 * height side by side), the later one steps up a line instead of printing on top of the first, and
 * the chart grows headroom for it rather than clipping it. Month groups are laid out at their
 * narrowest width here; the SVG places groups by percentage, so a wider card only adds air.
 */
export function layoutMoneyChart(months: MoneyChartMonth[], on: MoneySeriesKey[]): ChartLayout {
  const n = Math.max(1, on.length);
  const barWidth = n <= 3 ? 18 : 14;
  const groupBars = n * barWidth + (n - 1) * GAP;
  const minGroupWidth = groupBars + GROUP_PAD;
  const axisLabels = monthAxisLabels(months.map((m) => m.month));

  const values = months.flatMap((m) => on.map((k) => m.values[k] ?? 0));
  const scale = niceScale(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 0);
  const hasNeg = values.some((v) => v < -0.005);
  const tickLabels = scale.ticks.map(compactMoney);
  const axisWidth = Math.ceil(Math.max(...tickLabels.map(labelWidth), 16)) + 6;

  // Every value that is on is $0 (Collected alone over months that only had costs): no scale to
  // speak of, but the frame keeps its height, with its zero line at the bottom, rather than
  // collapsing to a strip, and the card says why it is empty.
  const flat = !(scale.hi - scale.lo > 0);

  let top = LINE + 4;
  let out: ChartLayout | null = null;
  for (let pass = 0; pass < 4; pass++) {
    const k = flat ? 0 : PLOT_H / (scale.hi - scale.lo);
    const zeroY = flat ? top + PLOT_H : top + scale.hi * k;
    const plotBottom = flat ? zeroY : top + (scale.hi - scale.lo) * k;
    const placed: { x: number; y: number; w: number; neg: boolean }[] = [];
    let minTop = Infinity;
    let maxBottom = plotBottom;

    const groups: GroupGeom[] = months.map((m, gi) => {
      const bars = on.map((key, bi): BarGeom => {
        const value = m.values[key] ?? 0;
        const x = -groupBars / 2 + bi * (barWidth + GAP);
        const cx = x + barWidth / 2;
        if (tiny(value)) return { key, value, x, w: barWidth, y: zeroY, h: 0, label: null, labelX: cx, labelY: zeroY, path: null };
        const neg = value < 0;
        const h = Math.max(MIN_BAR_PX, Math.abs(value) * k);
        const y = neg ? zeroY : zeroY - h;
        const label = compactMoney(value);
        const w = labelWidth(label);
        let labelY = neg ? y + h + LINE - 1 : y - 3;
        // Step clear of any figure already placed that this one would overlap.
        const absX = gi * minGroupWidth + cx;
        for (let guard = 0; guard < 12; guard++) {
          const hit = placed.find((p) => Math.abs(p.x - absX) < (p.w + w) / 2 + 1 && Math.abs(p.y - labelY) < LINE);
          if (!hit) break;
          labelY = neg ? hit.y + LINE : hit.y - LINE;
        }
        placed.push({ x: absX, y: labelY, w, neg });
        minTop = Math.min(minTop, labelY - (CHART_FONT_PX - 1));
        maxBottom = Math.max(maxBottom, labelY + 3, y + h);
        return { key, value, x, w: barWidth, y, h, label, labelX: cx, labelY, path: barPath(x, y, barWidth, h, neg) };
      });
      return { month: m.month, short: axisLabels[gi].short, year: axisLabels[gi].year, bars };
    });

    const monthY = Math.max(plotBottom, maxBottom) + (hasNeg ? 4 : 0) + LINE + 3;
    const anyYear = axisLabels.some((a) => a.year);
    const yearY = monthY + LINE;
    // The edge room: how far any figure reaches past the plot's left or right edge with every group
    // at its narrowest (the tightest it is ever drawn; a wider card only moves the outer groups in).
    const groupsWidth = Math.max(1, months.length) * minGroupWidth;
    let padLeft = 0;
    let padRight = 0;
    groups.forEach((g, gi) => {
      const centre = gi * minGroupWidth + minGroupWidth / 2;
      for (const b of g.bars) {
        if (!b.label) continue;
        const half = (labelWidth(b.label) * EDGE_SLACK) / 2 + HALO_PX;
        padLeft = Math.max(padLeft, -(centre + b.labelX - half));
        padRight = Math.max(padRight, centre + b.labelX + half - groupsWidth);
      }
    });
    padLeft = Math.ceil(padLeft);
    padRight = Math.ceil(padRight);
    out = {
      height: Math.ceil((anyYear ? yearY : monthY) + 5),
      zeroY,
      ticks: scale.ticks.map((v, i) => ({ value: v, y: zeroY - v * k, label: tickLabels[i] })),
      groups,
      barWidth,
      minGroupWidth,
      minPlotWidth: groupsWidth + padLeft + padRight,
      padLeft,
      padRight,
      flat,
      axisWidth,
      monthY,
      yearY,
    };
    // Every figure must sit inside the chart: grow the headroom and lay out again if one pokes out.
    if (minTop >= 1) break;
    top += Math.ceil(1 - minTop);
  }
  return out!;
}
