import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BankView } from "@/lib/bank-download";
import type { FuelTrend } from "@/lib/analytics/fuel-trend";

/**
 * THE BANK CARD AND THE FUEL CARD, RENDERED (2026-09-27). The headline, one bar for where the money
 * went, one row per merchant with the guess first and nothing picked, Apply / Not Now; every button
 * Title Case and 44px tall. The fuel card: one number, 13 bars a thumb wide. Made-up figures only.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/app/(app)/bills/bank-actions", () => ({ applyBankDownload: vi.fn(), undoBankDownload: vi.fn(), swapBankDownload: vi.fn(), setBankAccount: vi.fn(), forgetBankRule: vi.fn() }));
vi.mock("@/app/(app)/organize/paperwork-actions", () => ({ keepPaperwork: vi.fn() }));

import { BankCard } from "./bank-card";
import { FuelTrendCard } from "@/app/(app)/analytics/fuel-trend-card";

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], text: textOf(m[0]) }));
const titleCase = (s: string) => s.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w));

const VIEW: BankView = {
  headline: "Bank ••1234 · Aug 26–Sep 25 · 96 sorted · 17 already in North · 3 need you",
  fingerprint: "fp",
  counts: { lines: 118, already: 17, matched: 70, ruled: 26, needLines: 5, needRows: 3 },
  rows: [
    {
      id: "out:shell",
      title: "SHELL 123 ANYTOWN",
      money: "3 charges · $288.45",
      dates: "Sep 2–Sep 16",
      direction: "out",
      single: false,
      guess: "cost:Gas & Truck:fuel",
      buttons: [
        { id: "cost:Gas & Truck:fuel", label: "Fuel" },
        { id: "cost:Gas & Truck:truck", label: "Truck" },
        { id: "personal", label: "Personal" },
      ],
    },
    {
      id: "line:abc",
      title: "Deposit Sep 4",
      money: "$1,275.00",
      dates: "Sep 4",
      direction: "in",
      single: true,
      guess: "invoice:inv-1",
      buttons: [
        { id: "invoice:inv-1", label: "On INV-1001" },
        { id: "other_income", label: "Other Income" },
        { id: "not_income", label: "Not Income" },
      ],
    },
    { id: "line:def", title: "Check 1043", money: "$640.00", dates: "Sep 5", direction: "out", single: true, guess: "crew:pat", buttons: [{ id: "crew:pat", label: "Pay Pat Crew" }] },
  ],
  otherOut: [{ id: "draw", label: "Owner's Draw" }],
  otherIn: [{ id: "other_income", label: "Other Income" }],
  otherInSingle: [{ id: "invoice:inv-1", label: "On INV-1001" }],
  flow: [
    { key: "fuel", label: "Fuel", cents: 96500 },
    { key: "draw", label: "Owner's Draw", cents: 250000 },
    { key: "personal", label: "Personal", cents: 22000 },
  ],
  inCents: 1200000,
  outCents: 368500,
  sorted: [{ label: "Payments Already Recorded", n: 12, cents: 900000 }],
  skipped: [],
  appliedSaid: null,
  canUndo: false,
  swapped: false,
  canSwap: false,
  askAccount: false,
  rules: [{ id: "r1", label: "SHELL → Fuel ($40.00 to $140.00)", n: 26 }],
  problem: null,
};

const render = (view: BankView | null) => renderToStaticMarkup(createElement(BankCard, { itemId: "i1", view, run: () => {}, busy: null, working: false }));

describe("the bank card", () => {
  it("leads with the one line, draws where the money went, and asks one row per merchant", () => {
    const html = render(VIEW);
    const text = textOf(html);
    expect(text).toContain(VIEW.headline);
    expect(text).toContain("Where $3,685.00 Went");
    expect(text).toContain("Owner's Draw $2,500.00");
    expect(text).toContain("SHELL 123 ANYTOWN 3 charges · $288.45");
    // The guess is first and NOT picked: no button is pressed until a person taps.
    expect(html).not.toContain('aria-pressed="true"');
    const labels = buttons(html).map((b) => b.text);
    expect(labels.slice(0, 4)).toEqual(["Fuel", "Truck", "Personal", "Other…"]);
    expect(labels).toContain("On INV-1001");
    expect(labels).toContain("Pay Pat Crew");
    expect(labels).toContain("Apply");
    expect(labels).toContain("Not Now");
    for (const b of buttons(html)) {
      expect(titleCase(b.text.replace("…", ""))).toBe(true);
      expect(b.markup).toMatch(/h-11|min-h-11/);
    }
  });

  it("a problem is said, with Not Now; no Apply", () => {
    const text = textOf(render({ ...VIEW, problem: "Sorting a bank download needs one database update first. It is waiting here and nothing was changed." }));
    expect(text).toContain("needs one database update");
    expect(text).not.toContain("Apply");
    expect(text).toContain("Not Now");
  });

  it("the same month downloaded again: nothing to Apply, one tap puts it away", () => {
    const html = render({ ...VIEW, rows: [], counts: { ...VIEW.counts, matched: 0, ruled: 0, needRows: 0, needLines: 0 }, headline: "Bank ••1234 · Aug 26–Sep 25 · 118 already in North · nothing needs you" });
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Done: Nothing New");
    expect(labels).not.toContain("Apply");
  });

  it("after a pass, it says what was counted and offers Undo", () => {
    const text = textOf(render({ ...VIEW, appliedSaid: "Applied Sep 27: 96 lines counted. 5 lines left for later are not counted yet.", canUndo: true }));
    expect(text).toContain("5 lines left for later are not counted yet");
    expect(text).toContain("Undo This Download");
  });
});

describe("the fuel card", () => {
  const trend: FuelTrend = {
    weeks: Array.from({ length: 13 }, (_, i) => ({
      start: new Date(Date.UTC(2026, 5, 29 + 7 * i)).toISOString().slice(0, 10),
      end: new Date(Date.UTC(2026, 5, 35 + 7 * i)).toISOString().slice(0, 10),
      cents: i === 12 ? 31200 : 25000 + i * 100,
      fills: 3,
    })),
    weeksCounted: 13,
    totalCents: 360000,
    fills: 38,
    avgWeekCents: 31400,
    avgFillCents: 7600,
    moneyInCents: 3200000,
    sharePct: 9,
    hasFuel: true,
  };

  it("one number a week, 13 bars a thumb wide with their figures, and the one line under them", () => {
    const html = renderToStaticMarkup(createElement(FuelTrendCard, { trend }));
    const text = textOf(html);
    expect(text).toContain("$314 / week");
    expect(text).toContain("9% of money in · avg fill $76 · 38 fills");
    const bars = buttons(html);
    expect(bars).toHaveLength(13);
    for (const b of bars) expect(b.markup).toContain("min-w-11");
    expect(text).toContain("312"); // this week's figure on its bar
    expect(html).toContain("border-dashed"); // the average line
  });
});
