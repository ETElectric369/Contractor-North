import { describe, expect, it } from "vitest";
import { computeFuelTrend, fuelWindow, getFuelTrend, isFuelBill, mondayOf, type FuelBillRow } from "./fuel-trend";

/**
 * THE FUEL TREND'S MATH (2026-09-27). Made-up fuel bills, never a real company's: 13 weeks, Monday
 * to Sunday on the company's own calendar, the average over the weeks the books cover.
 */

const fuel = (day: string, amount: number, over: Partial<FuelBillRow> = {}): FuelBillRow => ({
  amount,
  bill_date: day,
  category: "Fuel",
  job_id: null,
  ...over,
});

const TODAY = "2026-09-27"; // a Sunday

describe("weeks", () => {
  it("start on Monday, and the window is the 13 weeks ending with this one", () => {
    expect(mondayOf("2026-09-27")).toBe("2026-09-21");
    expect(mondayOf("2026-09-21")).toBe("2026-09-21");
    expect(mondayOf("2026-09-22")).toBe("2026-09-21");
    expect(fuelWindow(TODAY)).toEqual({ start: "2026-06-29", end: "2026-09-28" });
  });
});

describe("computeFuelTrend", () => {
  it("adds fuel by week, counts fills, and averages over the finished weeks; this week is drawn, not averaged", () => {
    const rows = [fuel("2026-06-29", 100), fuel("2026-07-05", 50.5), fuel("2026-09-14", 125), fuel("2026-09-21", 75.25)];
    const t = computeFuelTrend(rows, 3500, TODAY);
    expect(t.weeks).toHaveLength(13);
    expect(t.weeks[0]).toEqual({ start: "2026-06-29", end: "2026-07-05", cents: 15050, fills: 2 });
    expect(t.weeks[11]).toEqual({ start: "2026-09-14", end: "2026-09-20", cents: 12500, fills: 1 });
    // This week (Sep 21-27, today the 27th) is still going: its bar is drawn, never averaged.
    expect(t.weeks[12]).toEqual({ start: "2026-09-21", end: "2026-09-27", cents: 7525, fills: 1 });
    expect(t.weeksCounted).toBe(12);
    expect(t.totalCents).toBe(27550);
    expect(t.fills).toBe(3);
    expect(t.avgWeekCents).toBe(Math.round(27550 / 12));
    expect(t.avgFillCents).toBe(Math.round(27550 / 3));
    expect(t.moneyInCents).toBe(350000);
    expect(t.sharePct).toBe(8); // 275.50 of 3,500
    expect(t.hasFuel).toBe(true);
  });

  it("a Monday with nothing yet this week reads the finished weeks' average, not 12/13 of it", () => {
    const rows = Array.from({ length: 12 }, (_, i) => fuel(new Date(Date.UTC(2026, 6, 7 + 7 * i)).toISOString().slice(0, 10), 280));
    const t = computeFuelTrend(rows, 0, "2026-09-28");
    expect(t.weeksCounted).toBe(12);
    expect(t.avgWeekCents).toBe(28000);
  });

  it("weeks past the last bank download aren't averaged: their fuel isn't in yet", () => {
    const rows = [fuel("2026-09-01", 100), fuel("2026-09-08", 100)];
    // The last download reached Sep 13 (a Sunday): Aug 31 - Sep 13 is two weeks, $100 each.
    const t = computeFuelTrend(rows, (from, to) => (from === "2026-08-31" && to === "2026-09-14" ? 2000 : -1), TODAY, "UTC", "2026-09-13");
    expect(t.weeksCounted).toBe(2);
    expect(t.avgWeekCents).toBe(10000);
    expect(t.moneyInCents).toBe(200000);
    expect(t.sharePct).toBe(10);
  });

  it("only the Fuel bucket counts: Auto (the old Gas & Truck), other buckets and job costs are not fuel", () => {
    expect(isFuelBill(fuel("2026-09-01", 1))).toBe(true);
    expect(isFuelBill(fuel("2026-09-01", 1, { category: "Auto" }))).toBe(false);
    // A row 0362 hasn't renamed yet is Auto, never fuel: the old bucket held repairs too.
    expect(isFuelBill(fuel("2026-09-01", 1, { category: "Gas & Truck" }))).toBe(false);
    expect(isFuelBill(fuel("2026-09-01", 1, { category: "Other" }))).toBe(false);
    expect(isFuelBill(fuel("2026-09-01", 1, { job_id: "job-1" }))).toBe(false);
    const t = computeFuelTrend([fuel("2026-09-22", 60), fuel("2026-09-22", 999, { category: "Auto" })], 0, TODAY);
    expect(t.totalCents).toBe(6000);
    expect(t.sharePct).toBeNull(); // no money in: no share, never a divide by zero
  });

  it("averages only over the weeks the books cover, and a refund is money back, not a fill", () => {
    const rows = [fuel("2026-09-01", 100), fuel("2026-09-15", 200), fuel("2026-09-16", -20)];
    const t = computeFuelTrend(rows, (from, to) => (from === "2026-08-31" && to === "2026-09-21" ? 1000 : -1), TODAY);
    expect(t.weeksCounted).toBe(3); // Aug 31 to last week (this week is still going)
    expect(t.totalCents).toBe(28000);
    expect(t.fills).toBe(2);
    expect(t.avgWeekCents).toBe(Math.round(28000 / 3));
    expect(t.moneyInCents).toBe(100000); // money in over the same weeks
    expect(t.sharePct).toBe(28);
  });

  it("fuel older than the window still counts the whole window; fuel outside it is not drawn", () => {
    const t = computeFuelTrend([fuel("2026-01-10", 80), fuel("2026-09-01", 100)], 0, TODAY);
    expect(t.weeksCounted).toBe(12);
    expect(t.totalCents).toBe(10000);
    expect(t.avgWeekCents).toBe(Math.round(10000 / 12));
  });

  it("no fuel: nothing to draw", () => {
    const t = computeFuelTrend([], 5000, TODAY);
    expect(t.hasFuel).toBe(false);
    expect(t.avgWeekCents).toBe(0);
    expect(t.weeksCounted).toBe(0);
  });
});

describe("getFuelTrend: every page, the window's rows, and the first fuel ever", () => {
  /** A PostgREST-shaped fake that cuts every select at 1,000 rows (db-max-rows) and records filters. */
  function fake(tables: Record<string, Record<string, unknown>[]>) {
    return {
      from(table: string) {
        const rows = tables[table] ?? [];
        const filters: ((r: Record<string, unknown>) => boolean)[] = [];
        let order: { col: string; asc: boolean } | null = null;
        let range: [number, number] | null = null;
        let cap = 1000;
        const chain: any = {
          select: () => chain,
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
          is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
          not: (c: string, _op: string, v: unknown) => (filters.push((r) => (r[c] ?? null) !== v), chain),
          gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), chain),
          lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), chain),
          or: (s: string) => {
            const since = /bill_date\.gte\.([0-9-]+)/.exec(s)?.[1] ?? "";
            filters.push((r) => r.bill_date == null || String(r.bill_date) >= since);
            return chain;
          },
          order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), chain),
          range: (a: number, b: number) => ((range = [a, b]), chain),
          limit: (n: number) => ((cap = Math.min(n, 1000)), chain),
          then: (res: any) => {
            let hit = rows.filter((r) => filters.every((f) => f(r)));
            if (order) hit = [...hit].sort((a, b) => (String(a[order!.col]) < String(b[order!.col]) ? -1 : 1) * (order!.asc ? 1 : -1));
            hit = range ? hit.slice(range[0], Math.min(range[1] + 1, range[0] + 1000)) : hit.slice(0, cap);
            return Promise.resolve({ data: hit, error: null }).then(res);
          },
        };
        return chain;
      },
    };
  }

  it("reads the recent weeks even past 1,000 fuel rows, and knows the first week from the earliest", async () => {
    // 1,500 old fills before the window, then $50 every day of the window's first 12 weeks.
    const old = Array.from({ length: 1500 }, (_, i) => ({ id: `o${String(i).padStart(4, "0")}`, ...fuel("2025-01-01", 10) }));
    const recent = Array.from({ length: 84 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}`, ...fuel(new Date(Date.UTC(2026, 5, 29 + i)).toISOString().slice(0, 10), 50) }));
    const t = await getFuelTrend(fake({ bills: [...old, ...recent], payments: [], customer_credits: [], bank_lines: [] }), "UTC", TODAY);
    expect(t).not.toBeNull();
    expect(t!.weeksCounted).toBe(12);
    expect(t!.avgWeekCents).toBe(35000);
    expect(t!.fills).toBe(84);
  });

  it("reads the Fuel bucket, whatever door wrote it, and never Auto or a job's fuel", async () => {
    const t = await getFuelTrend(
      fake({
        bills: [
          { id: "f1", ...fuel("2026-09-08", 100) }, // a bank download's fill-up
          { id: "f2", ...fuel("2026-09-09", 40) }, // a pump receipt filed as Fuel
          { id: "a1", ...fuel("2026-09-09", 500, { category: "Auto" }) },
          { id: "j1", ...fuel("2026-09-09", 70, { job_id: "job-1" }) },
          { id: "s1", ...fuel("2026-09-10", 90), superseded_by_bill_id: "f1" },
        ],
        payments: [],
        customer_credits: [],
        bank_lines: [],
      }),
      "UTC",
      TODAY,
    );
    expect(t!.weeks.reduce((n, w) => n + w.cents, 0)).toBe(14000);
    expect(t!.fills).toBe(2);
  });

  it("money in is the Owner's Draw card's Received: payments and a bank download's Other Income", async () => {
    const rows = [{ id: "f1", ...fuel("2026-09-08", 100) }];
    const t = await getFuelTrend(
      fake({
        bills: rows,
        payments: [{ id: "p1", amount: 600, paid_at: "2026-09-09T18:00:00Z", invoices: { status: "paid" } }],
        customer_credits: [],
        bank_lines: [{ id: "b1", choice: "other_income", amount: 400, posted_on: "2026-09-10" }],
      }),
      "UTC",
      TODAY,
    );
    expect(t!.moneyInCents).toBe(100000);
    expect(t!.sharePct).toBe(10);
  });
});
