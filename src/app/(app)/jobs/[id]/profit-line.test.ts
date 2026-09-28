import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfitLine } from "./profit-line";

/**
 * PROFIT IN ONE LINE (W1-23): "Profit $X · Y%" (green or red), or "Nothing Collected Yet · Spent $Z"
 * (never a fake 0%), and the old strip's rows in a Why? fold with one thin bar. The math is the page's
 * own and does not change.
 */
const BASE = {
  collected: 4000,
  crewLabor: 1500,
  crewHours: 20,
  ownerHours: 0,
  ownerHoursLabel: "Your Hours",
  materialsAndBills: 1000,
  shelfTouched: false,
  tickets: 0,
  fromStock: 0,
  pettyCash: 0,
  miles: 42.5,
  profit: 1500,
  margin: 37.5,
  perOwnerHour: null as number | null,
  perHourPhrase: "per hour you worked",
};
const r = (p: Partial<typeof BASE> = {}) => renderToStaticMarkup(createElement(ProfitLine, { ...BASE, ...p }));
const fold = (html: string) => html.slice(html.indexOf("<details"), html.indexOf("</details>"));

describe("the one line", () => {
  it("Profit $X · Y%, green, and the rows folded under Why?", () => {
    const html = r();
    expect(html).toMatch(/text-green-600[^>]*>Profit \$1,500\.00 · 38%</);
    const f = fold(html);
    expect(f).toContain(">Why?<");
    expect(f).toContain("Collected");
    expect(f).toContain("Crew Labor · 20h 0m");
    expect(f).toContain("Materials &amp; Bills");
    expect(f).toContain("Mileage · not in profit");
    expect(f).toContain("42.5 mi");
  });

  it("nothing collected yet: what was spent, never a 0%", () => {
    const html = r({ collected: 0, profit: -2500, margin: 0 });
    expect(html).toContain("Nothing Collected Yet · Spent $2,500.00");
    expect(html).not.toContain("Profit");
    expect(html).not.toContain("0%");
  });

  it("a loss is red, and its bar runs past what was collected in red", () => {
    const html = r({ collected: 2000, profit: -500, margin: -25 });
    expect(html).toMatch(/text-red-600[^>]*>Profit -\$500\.00 · -25%</);
    expect(html).toContain("bg-red-500/80");
    expect(html).toContain("a loss of $500.00");
  });

  it("the bar is the width of what was collected, split into where it went", () => {
    const html = r();
    expect(html).toContain('style="width:37.5%"'); // crew labor 1500 of 4000
    expect(html).toContain('style="width:25%"'); // materials and bills 1000
    expect(html).toMatch(/bg-green-500" style="width:37\.5%"/); // profit 1500
  });
});

describe("the rows that show only when they're real", () => {
  it("the owner's hours (hours, no dollars) and the per-hour figure", () => {
    const html = r({ ownerHours: 12, perOwnerHour: 125 });
    expect(fold(html)).toContain("Your Hours");
    expect(fold(html)).toContain("12h 0m");
    expect(fold(html)).toContain("Per hour you worked");
    expect(fold(html)).toContain("$125.00");
  });

  it("petty cash, only when there is some, is a 44px link to /petty-cash", () => {
    expect(r()).not.toContain("Petty Cash");
    const html = r({ pettyCash: 90, profit: 1410 });
    const link = html.match(/<a [^>]*>Petty Cash<\/a>/)?.[0] ?? "";
    expect(link).toContain('href="/petty-cash"');
    expect(link).toContain("min-h-11");
    expect(html).toContain("$90.00");
  });

  it("stock: the tickets and what came from stock, only when stock touched the job", () => {
    expect(r()).not.toContain("From Stock");
    expect(r({ shelfTouched: true, tickets: 800, fromStock: 200 })).toContain("Tickets $800.00 · From Stock $200.00");
  });
});

describe("the Costs tab (source)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
  it("the math is untouched, and Materials & Bills is the orders and the bills as one figure", () => {
    expect(page).toContain("const profit = revenue - laborCost - materialCost - billsCost - pettyCost;");
    expect(page).toContain("materialsAndBills={Math.round((materialCost + billsCost) * 100) / 100}");
  });
  it("the profit line comes after Receipts & Papers; the purchase-order card only when there is an order", () => {
    expect(page.indexOf("<ProfitLine")).toBeGreaterThan(page.indexOf("<JobDocuments"));
    expect(page).toContain("{(pos ?? []).length > 0 && (");
    expect(page).not.toMatch(/>Margin<\/div>/);
  });
});
