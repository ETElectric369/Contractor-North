import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CHART_FONT_PX,
  buildMoneyChartData,
  compactMoney,
  defaultSeriesOn,
  drawnMonth,
  emptyChartSentence,
  labelWidth,
  layoutMoneyChart,
  monthAxisLabels,
  monthRangeLabel,
  niceScale,
  parseStoredSeries,
  toggleSeries,
  type MoneyChartMonth,
  type MoneySeriesKey,
} from "@/lib/analytics/money-chart";
import { computeOwnerMoney, ownerMoneyChartWindow, type OwnerMoney, type OwnerMoneyMonth } from "@/lib/analytics/owner-money";
import { BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";
import { MoneyChartSvg } from "@/app/(app)/analytics/money-chart-svg";

const TODAY = "2026-09-24";

/** A month row the way computeOwnerMoney shapes it; only the money lines matter here. */
const row = (month: string, f: Partial<OwnerMoneyMonth> = {}): OwnerMoneyMonth => {
  const received = f.received ?? 0;
  const materialsAndBills = f.materialsAndBills ?? 0;
  const crewPay = f.crewPay ?? 0;
  const crewMileagePaid = f.crewMileagePaid ?? 0;
  const businessCostsTotal = f.businessCostsTotal ?? 0;
  const putOnShelf = f.putOnShelf ?? 0;
  const shopStockLost = f.shopStockLost ?? 0;
  return {
    month,
    received,
    materialsAndBills,
    crewPay,
    crewMileagePaid,
    businessCosts: Object.fromEntries(BUSINESS_COST_BUCKETS.map((b) => [b, 0])) as OwnerMoneyMonth["businessCosts"],
    businessCostsTotal,
    processorFees: 0,
    putOnShelf,
    shopStockLost,
    left: Math.round((received - materialsAndBills - crewPay - crewMileagePaid - businessCostsTotal - putOnShelf - shopStockLost) * 100) / 100,
    ownerHours: 0,
    perOwnerHour: null,
  };
};
const money = (months: OwnerMoneyMonth[]): OwnerMoney => ({
  window: ownerMoneyChartWindow(TODAY),
  totals: row("total"),
  months,
  caveats: [],
  owners: [],
  onShelfNow: 0,
});

/** ET's shape, 2026: nothing Oct-Mar, two cost-only months, then money. */
const etYear = () =>
  money([
    ...["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"].map((m) => row(m)),
    row("2026-04", { businessCostsTotal: 47.44 }),
    row("2026-05", { businessCostsTotal: 138.62 }),
    row("2026-06", { received: 12503.98, materialsAndBills: 4655.36, crewPay: 2660 }),
    row("2026-07", { received: 20754.81, materialsAndBills: 3308.41, crewPay: 2597.2 }),
    row("2026-08", { received: 19132.53, materialsAndBills: 4934.23, crewPay: 2716 }),
    row("2026-09", { received: 20516.56, materialsAndBills: 3985.73, crewPay: 3375.2 }),
  ]);

describe("compactMoney: the figure on a bar", () => {
  it("$780 under $1,000, one decimal under $10k, whole k above, M for millions", () => {
    expect(compactMoney(780)).toBe("$780");
    expect(compactMoney(4213)).toBe("$4.2k");
    expect(compactMoney(4000)).toBe("$4k");
    expect(compactMoney(20754.81)).toBe("$21k");
    expect(compactMoney(999.6)).toBe("$1k");
    expect(compactMoney(1_200_000)).toBe("$1.2M");
    expect(compactMoney(0)).toBe("$0");
  });
  it("a negative month reads negative, with a real minus sign", () => {
    expect(compactMoney(-47.44)).toBe("−$47");
    expect(compactMoney(-138.62)).toBe("−$139");
    expect(compactMoney(-12500)).toBe("−$13k");
  });
});

describe("niceScale: round y ticks", () => {
  it("ET's months: $0 / $10k / $20k / $30k, with a sliver below zero for the -$139 month", () => {
    const s = niceScale(-138.62, 20754.81);
    expect(s.ticks).toEqual([0, 10000, 20000, 30000]);
    expect(s.lo).toBe(-138.62);
    expect(s.hi).toBe(30000);
  });
  it("3 to 5 round ticks, the top at or above the biggest bar, for any size of year", () => {
    for (const max of [1, 99, 780, 4213, 9999, 10000, 21000, 48000, 125000, 999999, 2_400_000]) {
      const s = niceScale(0, max);
      expect(s.ticks.length).toBeGreaterThanOrEqual(3);
      expect(s.ticks.length).toBeLessThanOrEqual(5);
      expect(s.ticks[0]).toBe(0);
      expect(s.hi).toBeGreaterThanOrEqual(max);
      const step = s.ticks[1] - s.ticks[0];
      expect(Number((step / Math.pow(10, Math.floor(Math.log10(step)))).toFixed(2))).toBeOneOf([1, 2, 2.5, 5]);
    }
  });
  it("a real loss gets its own negative tick", () => {
    const s = niceScale(-6000, 20000);
    expect(s.ticks).toEqual([-10000, 0, 10000, 20000]);
  });
  it("nothing at all: one zero tick", () => {
    expect(niceScale(0, 0)).toEqual({ ticks: [0], lo: 0, hi: 0 });
  });
});

const chartMonths = (vals: [string, number, number][]): MoneyChartMonth[] =>
  vals.map(([month, collected, left]) => ({ month, values: { collected, left } }));

describe("layoutMoneyChart: the geometry", () => {
  const both: MoneySeriesKey[] = ["collected", "left"];

  it("bar heights are proportional to the money: $21k is about 5x $4k", () => {
    const l = layoutMoneyChart(chartMonths([["2026-07", 21000, 4000]]), both);
    const [c, left] = l.groups[0].bars;
    expect(c.h / left.h).toBeCloseTo(21000 / 4000, 2);
    expect(c.h).toBeGreaterThan(50);
    expect(c.y + c.h).toBeCloseTo(l.zeroY, 5); // both grow from the one zero line
    expect(left.y + left.h).toBeCloseTo(l.zeroY, 5);
  });

  it("a negative month draws BELOW the zero line, labelled in the negative, never clamped to 0", () => {
    const l = layoutMoneyChart(chartMonths([["2026-05", 0, -138.62], ["2026-07", 20754.81, 14849.2]]), both);
    const neg = l.groups[0].bars[1];
    expect(neg.y).toBeCloseTo(l.zeroY, 5);
    expect(neg.h).toBeGreaterThanOrEqual(2); // tiny, but drawn
    expect(neg.path).not.toBeNull();
    expect(neg.label).toBe("−$139");
    expect(neg.labelY).toBeGreaterThan(l.zeroY);
    expect(l.monthY).toBeGreaterThan(neg.labelY); // the month name sits under the figure
  });

  it("a $0 value draws no bar and no figure, and its month keeps its slot and name", () => {
    const l = layoutMoneyChart(chartMonths([["2026-06", 0, 0], ["2026-07", 21000, 4000]]), both);
    expect(l.groups).toHaveLength(2);
    expect(l.groups[0].short).toBe("Jun");
    for (const b of l.groups[0].bars) {
      expect(b.h).toBe(0);
      expect(b.path).toBeNull();
      expect(b.label).toBeNull();
    }
  });

  it("figures never overlap: two bars of the same height step one figure up a line", () => {
    const l = layoutMoneyChart(chartMonths([["2026-07", 20000, 19900]]), both);
    const [a, b] = l.groups[0].bars;
    expect(Math.abs(a.labelY - b.labelY)).toBeGreaterThanOrEqual(11);
    // ...and every figure stays inside the chart's box.
    for (const g of l.groups) for (const bar of g.bars) if (bar.label) expect(bar.labelY - CHART_FONT_PX).toBeGreaterThanOrEqual(0);
  });

  it("PHONE: 6 months x 2 bars fit a 375px screen with 10px figures, no sideways scroll", () => {
    const data = buildMoneyChartData(etYear(), { ownerFigures: true, leftLabel: "Left For You" });
    const l = layoutMoneyChart(data.months, both);
    // 375 - the page's 16px gutters - the card's border - the plot's 12px padding each side.
    const room = 375 - 32 - 2 - 24;
    expect(l.groups).toHaveLength(6);
    expect(l.axisWidth + l.minPlotWidth).toBeLessThanOrEqual(room);
    expect(CHART_FONT_PX).toBeGreaterThanOrEqual(10);
    // Twelve months with every series on do not fit, so the plot scrolls inside its own box.
    const all = layoutMoneyChart(
      Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, values: { collected: 1, left: 1, materials: 1, crewPay: 1, business: 1 } })),
      ["collected", "left", "materials", "crewPay", "business"],
    );
    expect(all.minPlotWidth).toBeGreaterThan(room);
  });
});

describe("month labels", () => {
  it("Apr through Sep in one year: month names only", () => {
    expect(monthAxisLabels(["2026-04", "2026-05", "2026-06"])).toEqual([
      { short: "Apr", year: null },
      { short: "May", year: null },
      { short: "Jun", year: null },
    ]);
  });
  it("a range that crosses a year names the year on its first month and on January", () => {
    const l = monthAxisLabels(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(l.map((x) => x.year)).toEqual(["2025", null, "2026", null]);
  });
  it("January always carries its year", () => {
    expect(monthAxisLabels(["2026-01", "2026-02"])[0]).toEqual({ short: "Jan", year: "2026" });
  });
  it("the card's range", () => {
    expect(monthRangeLabel(["2026-04", "2026-09"])).toBe("Apr – Sep 2026");
    expect(monthRangeLabel(["2025-10", "2026-09"])).toBe("Oct 2025 – Sep 2026");
    expect(monthRangeLabel(["2026-09"])).toBe("Sep 2026");
    expect(monthRangeLabel([])).toBeNull();
  });
});

describe("buildMoneyChartData: what this viewer's chart holds", () => {
  it("trims the leading empty months: ET shows Apr through Sep, not six empty slots", () => {
    const d = buildMoneyChartData(etYear(), { ownerFigures: true, leftLabel: "Left For You" });
    expect(d.months.map((m) => m.month)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(d.months[0].values).toMatchObject({ collected: 0, left: -47.44, business: 47.44 });
  });

  it("a $0 month after the first keeps its slot", () => {
    const d = buildMoneyChartData(money([row("2026-07", { received: 100 }), row("2026-08"), row("2026-09", { received: 50 })]), {
      ownerFigures: true,
      leftLabel: "Left For You",
    });
    expect(d.months.map((m) => m.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("the owner gets every series, Collected and Left on by default; the Left series speaks the viewer's register", () => {
    const d = buildMoneyChartData(etYear(), { ownerFigures: true, leftLabel: "Left For Erik" });
    expect(d.series.map((s) => s.key)).toEqual(["collected", "left", "materials", "crewPay", "business"]);
    expect(d.series.find((s) => s.key === "left")!.label).toBe("Left For Erik");
    expect(defaultSeriesOn(d.series)).toEqual(["collected", "left"]);
  });

  it("Crew Mileage is offered only when the months hold some", () => {
    const m = etYear();
    m.months[9] = row("2026-07", { received: 20754.81, crewMileagePaid: 62.5 });
    expect(buildMoneyChartData(m, { ownerFigures: true, leftLabel: "Left For You" }).series.map((s) => s.key)).toContain("mileage");
  });

  it("OFFICE, NOT ALLOWED: Collected only, and no owner figure is anywhere in the data", () => {
    const d = buildMoneyChartData(etYear(), { ownerFigures: false, leftLabel: "Left For Erik" });
    expect(d.series.map((s) => s.key)).toEqual(["collected"]);
    for (const m of d.months) expect(Object.keys(m.values)).toEqual(["collected"]);
    // Trimmed on Collected alone, so even the months cannot hint that April and May had costs.
    expect(d.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    const json = JSON.stringify(d);
    for (const secret of ["Left", "14849.2", "4655.36", "2660", "47.44", "materials", "crewPay"]) expect(json).not.toContain(secret);
  });

  it("a company with no money yet has no months (the card says so in a sentence)", () => {
    const empty = computeOwnerMoney(
      { payments: [], refunds: [], bills: [], pos: [], pettyCash: [], entries: [], runs: [], payPayments: [], creditMemos: [], people: new Map(), recordsStart: null },
      ownerMoneyChartWindow(TODAY),
      "America/Los_Angeles",
      TODAY,
    );
    expect(buildMoneyChartData(empty, { ownerFigures: true, leftLabel: "Left For You" }).months).toEqual([]);
  });
});

describe("toggles", () => {
  const all: MoneySeriesKey[] = ["collected", "left", "materials", "crewPay", "business"];
  it("turning one on adds its bar in the fixed order; turning one off removes it", () => {
    expect(toggleSeries(["collected", "left"], "crewPay", all)).toEqual(["collected", "left", "crewPay"]);
    expect(toggleSeries(["crewPay", "collected"], "materials", all)).toEqual(["collected", "materials", "crewPay"]);
    expect(toggleSeries(["collected", "left"], "collected", all)).toEqual(["left"]);
  });
  it("AT LEAST ONE STAYS ON: the last one cannot be turned off", () => {
    const on: MoneySeriesKey[] = ["left"];
    expect(toggleSeries(on, "left", all)).toBe(on);
  });
  it("a series this viewer does not have cannot be turned on", () => {
    expect(toggleSeries(["collected"], "left", ["collected"])).toEqual(["collected"]);
  });
  it("the remembered choice is read back safely", () => {
    const d = buildMoneyChartData(etYear(), { ownerFigures: true, leftLabel: "Left For You" });
    expect(parseStoredSeries('["collected","crewPay"]', d.series)).toEqual(["collected", "crewPay"]);
    expect(parseStoredSeries("not json", d.series)).toEqual(["collected", "left"]);
    expect(parseStoredSeries("[]", d.series)).toEqual(["collected", "left"]);
    expect(parseStoredSeries(null, d.series)).toEqual(["collected", "left"]);
    // An office viewer whose browser remembers the owner's chips still gets Collected only.
    const office = buildMoneyChartData(etYear(), { ownerFigures: false, leftLabel: "Left For Erik" });
    expect(parseStoredSeries('["left","materials"]', office.series)).toEqual(["collected"]);
  });
});

describe("MoneyChartSvg: the markup", () => {
  const render = (months: MoneyChartMonth[], on: MoneySeriesKey[], selected: string | null = null) => {
    const d = buildMoneyChartData(etYear(), { ownerFigures: true, leftLabel: "Left For You" });
    const series = d.series.filter((s) => on.includes(s.key));
    return renderToStaticMarkup(
      createElement(MoneyChartSvg, { layout: layoutMoneyChart(months, on), months, series, selected, ariaLabel: "Money by Month" }),
    );
  };
  const heights = (html: string) =>
    [...html.matchAll(/data-series="(\w+)" data-value="([-\d.]+)" data-height="([\d.]+)"/g)].map((m) => ({ key: m[1], value: Number(m[2]), h: Number(m[3]) }));

  it("draws every bar to scale with a non-zero height, and prints its figure", () => {
    const html = render(chartMonths([["2026-07", 21000, 4000]]), ["collected", "left"]);
    const [c, l] = heights(html);
    expect(c).toMatchObject({ key: "collected", value: 21000 });
    expect(l).toMatchObject({ key: "left", value: 4000 });
    expect(c.h).toBeGreaterThan(0);
    expect(l.h).toBeGreaterThan(0);
    expect(c.h / l.h).toBeCloseTo(5.25, 1);
    expect(html).toContain(">$21k<");
    expect(html).toContain(">$4k<");
    expect(html).toContain('role="img"');
    expect(html).toContain('class="fill-brand"');
    expect(html).toContain('class="fill-green-600"');
  });

  it("ET's six months: every figure printed, the negative ones below zero, a hidden table with the exact numbers", () => {
    const d = buildMoneyChartData(etYear(), { ownerFigures: true, leftLabel: "Left For You" });
    const html = render(d.months, ["collected", "left"]);
    for (const f of ["−$47", "−$139", "$13k", "$5.2k", "$21k", "$15k", "$19k", "$11k", "$13k"]) expect(html).toContain(`>${f}<`);
    expect(heights(html).filter((b) => b.value < 0).every((b) => b.h >= 2)).toBe(true);
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("$20,754.81");
    expect(html).toContain("-$47.44");
    // One real button per month, pressed state on the selected one.
    expect(html.match(/<button/g)).toHaveLength(6);
  });

  it("a selected month is marked pressed and the others step back", () => {
    const d = buildMoneyChartData(etYear(), { ownerFigures: true, leftLabel: "Left For You" });
    const html = render(d.months, ["collected", "left"], "2026-08");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true" aria-label="August 2026: Collected \$19,132\.53, Left For You \$11,482\.30"/);
    expect(html.match(/opacity-40/g)).toHaveLength(5);
  });

  it("a $0 month has no bar but keeps its column and its button", () => {
    const html = render(chartMonths([["2026-06", 0, 0], ["2026-07", 21000, 4000]]), ["collected", "left"]);
    expect(html).toContain('data-month="2026-06"');
    expect(heights(html)).toHaveLength(2);
    expect(html.match(/<button/g)).toHaveLength(2);
  });
});

describe("review fixes (feat/money-chart-0924)", () => {
  const owner = () => buildMoneyChartData(etYear(), { ownerFigures: true, leftLabel: "Left For You" });

  it("a ?w= month the chart does not draw is not selected: the page falls back to the segment", () => {
    expect(drawnMonth("2026-08", owner())).toBe("2026-08");
    expect(drawnMonth("2025-11", owner())).toBeNull(); // valid on the server, but before ET's trimmed start
    expect(drawnMonth(null, owner())).toBeNull();
    expect(drawnMonth("2026-08", null)).toBeNull();
    // An office viewer's Collected-only chart starts in June, so the owner's April link selects nothing.
    expect(drawnMonth("2026-04", buildMoneyChartData(etYear(), { ownerFigures: false, leftLabel: "Left For Erik" }))).toBeNull();
  });

  it("...and the chart itself never fades every month for a month it does not draw", () => {
    const d = owner();
    const on: MoneySeriesKey[] = ["collected", "left"];
    const html = renderToStaticMarkup(
      createElement(MoneyChartSvg, {
        layout: layoutMoneyChart(d.months, on),
        months: d.months,
        series: d.series.filter((s) => on.includes(s.key)),
        selected: "2025-11",
        ariaLabel: "Money by Month",
      }),
    );
    expect(html).not.toContain("opacity-40");
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("a tiny chart keeps whole-dollar ticks, and every tick reads differently", () => {
    for (const [lo, hi] of [
      [0, 1.23],
      [0, 1],
      [0, 3],
      [0, 7.5],
      [0, 10],
      [-0.3, 1.23],
      [0, 0.4],
    ]) {
      const s = niceScale(lo, hi);
      expect(s.ticks.length).toBeGreaterThanOrEqual(3);
      expect(s.ticks.length).toBeLessThanOrEqual(5);
      for (const t of s.ticks) expect(Number.isInteger(t)).toBe(true);
      const labels = s.ticks.map(compactMoney);
      expect(new Set(labels).size).toBe(labels.length);
      expect(s.hi).toBeGreaterThanOrEqual(hi);
    }
    expect(niceScale(0, 1.23).ticks).toEqual([0, 1, 2]);
    expect(niceScale(0, 10).ticks).toEqual([0, 5, 10]);
  });

  it("a figure under $10 keeps its cents; a -30¢ month never reads $0", () => {
    expect(compactMoney(1.23)).toBe("$1.23");
    expect(compactMoney(-0.3)).toBe("−$0.30");
    expect(compactMoney(0.3)).toBe("$0.30");
    expect(compactMoney(5)).toBe("$5");
    expect(compactMoney(0.001)).toBe("$0");
    expect(compactMoney(-47.44)).toBe("−$47");
  });

  it("the empty chart says 'nothing yet' only when nothing was ever received", () => {
    const start = ownerMoneyChartWindow(TODAY).start; // 2025-10-01
    expect(emptyChartSentence(null, start)).toBe("Nothing received yet. Your first payment will show up here.");
    expect(emptyChartSentence("2025-06-10", start)).toBe("Nothing received in the last 12 months.");
    expect(emptyChartSentence("2026-06-11", start)).toBe("Nothing received yet. Your first payment will show up here.");
  });

  it("a cost series that is $0 in every month shown gets no chip (a solo owner has no Crew Pay chip)", () => {
    const solo = money([row("2026-07", { received: 5000, materialsAndBills: 900 }), row("2026-08", { received: 4000, businessCostsTotal: 120 })]);
    const d = buildMoneyChartData(solo, { ownerFigures: true, leftLabel: "Left For You" });
    expect(d.series.map((s) => s.key)).toEqual(["collected", "left", "materials", "business"]);
    for (const m of d.months) expect(Object.keys(m.values)).not.toContain("crewPay");
    // Collected and Left are always offered, even with no cost at all.
    const plain = money([row("2026-08", { received: 4000 })]);
    expect(buildMoneyChartData(plain, { ownerFigures: true, leftLabel: "Left For You" }).series.map((s) => s.key)).toEqual(["collected", "left"]);
  });

  it("every value on is $0: the frame keeps its full height and says so", () => {
    const costsOnly = chartMonths([["2026-04", 0, -47.44], ["2026-05", 0, -138.62]]);
    const normal = layoutMoneyChart(chartMonths([["2026-07", 21000, 4000]]), ["collected", "left"]);
    const flat = layoutMoneyChart(costsOnly, ["collected"]);
    expect(flat.flat).toBe(true);
    expect(normal.flat).toBe(false);
    expect(flat.height).toBeGreaterThanOrEqual(normal.height - 20);
    const d = owner();
    const html = renderToStaticMarkup(
      createElement(MoneyChartSvg, { layout: flat, months: costsOnly, series: d.series.filter((s) => s.key === "collected"), selected: null, ariaLabel: "x" }),
    );
    expect(html).toContain("Collected is $0 in every month shown.");
  });

  it("EDGES: every figure lies inside the plot, ET with four series on (Erik's toggles) and a month-to-date loss", () => {
    const within = (l: ReturnType<typeof layoutMoneyChart>) => {
      for (const [gi, g] of l.groups.entries()) {
        const centre = l.padLeft + gi * l.minGroupWidth + l.minGroupWidth / 2;
        for (const b of g.bars) {
          if (!b.label) continue;
          const half = (labelWidth(b.label) * 1.1) / 2; // the real font runs a little wider than the estimate
          expect(centre + b.labelX - half).toBeGreaterThanOrEqual(0);
          expect(centre + b.labelX + half).toBeLessThanOrEqual(l.minPlotWidth);
        }
      }
    };
    const d = owner();
    const four = layoutMoneyChart(d.months, ["collected", "left", "materials", "crewPay"]);
    expect(four.padRight).toBeGreaterThan(0); // Sep's Crew Pay "$3.4k" needs room past the last group
    within(four);
    within(layoutMoneyChart(d.months, ["collected", "left"]));
    // Seven months, the current one a month-to-date loss: "−$1.2k" on the last Left bar.
    const seven = chartMonths([
      ["2026-04", 0, -47.44],
      ["2026-05", 0, -138.62],
      ["2026-06", 12503.98, 5188.62],
      ["2026-07", 20754.81, 14849.2],
      ["2026-08", 19132.53, 11482.3],
      ["2026-09", 20516.56, 13155.63],
      ["2026-10", 0, -1200],
    ]);
    const l7 = layoutMoneyChart(seven, ["collected", "left"]);
    within(l7);
    // The rendered plot carries the room: the groups sit between it.
    const html = renderToStaticMarkup(
      createElement(MoneyChartSvg, { layout: four, months: d.months, series: d.series.filter((s) => s.key !== "business"), selected: null, ariaLabel: "x" }),
    );
    expect(html).toContain(`padding-right:${four.padRight}px`);
    expect(html).toContain(`right:${four.padRight}px`);
  });

  it("PHONE: ET's six months x 2 bars still fit 375px with the edge room", () => {
    const l = layoutMoneyChart(owner().months, ["collected", "left"]);
    expect(l.axisWidth + l.minPlotWidth).toBeLessThanOrEqual(375 - 32 - 2 - 24);
  });

  it("small chart text reads at slate-500 or darker, and a picked month dims only the other months' bars", () => {
    const d = owner();
    const on: MoneySeriesKey[] = ["collected", "left"];
    const html = renderToStaticMarkup(
      createElement(MoneyChartSvg, { layout: layoutMoneyChart(d.months, on), months: d.months, series: d.series.filter((s) => on.includes(s.key)), selected: "2026-08", ariaLabel: "x" }),
    );
    expect(html).not.toContain("slate-400");
    // The dim wraps bars only: no figure <text> sits inside an opacity-40 group.
    for (const m of html.matchAll(/<g class="[^"]*opacity-40">([\s\S]*?)<\/g>/g)) expect(m[1]).not.toContain("<text");
  });
});
