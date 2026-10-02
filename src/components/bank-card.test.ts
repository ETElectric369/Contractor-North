import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BankView } from "@/lib/bank-download";
import type { FuelTrend } from "@/lib/analytics/fuel-trend";

/**
 * THE BANK CARD AND THE FUEL CARD, RENDERED (2026-09-27). The headline, one bar for where the money
 * went, one row per merchant with the guess first and nothing picked, Apply / Set Aside; every button
 * Title Case and 44px tall. The fuel card: one number, 13 bars a thumb wide. Made-up figures only.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/app/(app)/bills/bank-actions", () => ({ applyBankDownload: vi.fn(), undoBankDownload: vi.fn(), swapBankDownload: vi.fn(), setBankAccount: vi.fn(), forgetBankRule: vi.fn() }));
vi.mock("@/app/(app)/organize/paperwork-actions", () => ({ keepPaperwork: vi.fn() }));

import { BankCard, livePicks, othersFor, toneOf } from "./bank-card";
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
      guess: "cost:Fuel",
      buttons: [
        { id: "cost:Fuel", label: "Fuel" },
        { id: "cost:Auto", label: "Auto" },
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
  otherOutSingle: [
    { id: "draw", label: "Owner's Draw" },
    { id: "job:job-1", label: "On 41 Larkspur · J-054 — Marla Finch" },
  ],
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
    // The guess is marked, and NOT picked: no button is pressed until a person taps.
    expect(html).not.toContain('aria-pressed="true"');
    const labels = buttons(html).map((b) => b.text);
    expect(labels.slice(0, 4)).toEqual(["Fuel Guess", "Auto", "Personal", "Other…"]);
    expect(labels).toContain("On INV-1001 Guess");
    expect(labels).toContain("Pay Pat Crew Guess");
    expect(text).toContain("A button marked Guess is the app's guess.");
    expect(text).not.toContain("No guess");
    expect(labels).toContain("Apply");
    expect(labels).toContain("Set Aside");
    // "Not Now" means nothing here: a pick is cleared by tapping it again.
    expect(labels).not.toContain("Not Now");
    for (const b of buttons(html)) {
      expect(titleCase(b.text.replace("…", ""))).toBe(true);
      expect(b.markup).toMatch(/h-11|min-h-11/);
    }
  });

  it("a long answer wraps inside the card, still a thumb tall", () => {
    const html = render({ ...VIEW, rows: [{ ...VIEW.rows[2], buttons: [{ id: "supplier:x", label: "Pay Westfield Electrical Supply Company (Anytown Branch)" }] }] });
    const b = buttons(html).find((x) => x.text.startsWith("Pay Westfield"))!;
    expect(b.markup).toMatch(/whitespace-normal/);
    expect(b.markup).toMatch(/min-h-11/);
    expect(b.markup).toMatch(/max-w-full/);
    expect(b.markup).not.toMatch(/whitespace-nowrap/);
  });

  it("a row with no guess says so, and none of its buttons is called one", () => {
    const html = render({ ...VIEW, rows: [{ ...VIEW.rows[0], guess: null, buttons: [{ id: "personal", label: "Personal" }, { id: "draw", label: "Owner's Draw" }] }] });
    expect(textOf(html)).toContain("No guess");
    expect(html).not.toMatch(/>Guess</);
  });

  /**
   * A BANK LINE CAN GO ON A JOB (0375), and only where there is one line to put on it: the job answer
   * is in the Other… list of a row that is ONE line, and in no quick button (there is no way to guess
   * WHICH job). A row holding three of a merchant's fills gets the shared list, with no job in it.
   */
  it("a row that is one line gets the job in its Other… list; a merchant's several lines do not, and no quick button guesses one", () => {
    const [shell, deposit, check] = VIEW.rows;
    expect(othersFor(check, VIEW).map((o) => o.id)).toContain("job:job-1");
    expect(othersFor(shell, VIEW).map((o) => o.id)).not.toContain("job:job-1");
    // A deposit's own list (the invoices open for its money) is the one it brings.
    expect(othersFor({ ...deposit, others: [{ id: "invoice:inv-1", label: "On INV-1001 · $1,275.00 open" }] }, VIEW).map((o) => o.id)).toEqual(["invoice:inv-1"]);
    // The job is said as the place, the number AND who — never a bare number (Erik).
    const job = othersFor(check, VIEW).find((o) => o.id === "job:job-1")!;
    expect(job.label).toBe("On 41 Larkspur · J-054 — Marla Finch");
    expect(job.label).not.toMatch(/^On J-\d+$/);
    // No button on the card guesses a job: a job is picked on purpose, from the list.
    expect(buttons(render(VIEW)).every((b) => !b.text.includes("J-054"))).toBe(true);
  });

  it("a problem is said, with Set Aside; no Apply", () => {
    const text = textOf(render({ ...VIEW, problem: "Sorting a bank download needs one database update first. It is waiting here and nothing was changed." }));
    expect(text).toContain("needs one database update");
    expect(text).not.toContain("Apply");
    expect(text).toContain("Set Aside");
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
    expect(text).toContain("9% of revenue · avg fill $76 · 38 fills");
    const bars = buttons(html);
    expect(bars).toHaveLength(13);
    for (const b of bars) expect(b.markup).toContain("min-w-11");
    expect(text).toContain("312"); // this week's figure on its bar
    expect(html).toContain("border-dashed"); // the average line
    // It counts the Fuel bucket (0362), and says so; Auto is not in it.
    expect(text).toContain("Counts every business cost filed as Fuel");
    expect(text).toContain("Truck repairs and parts are Auto, not in it.");
    expect(text).not.toContain("Gas & Truck");
  });

  it("draws fuel in the one Fuel colour the chart and the bank card use", () => {
    const html = renderToStaticMarkup(createElement(FuelTrendCard, { trend }));
    expect(html).toContain("bg-pink-800");
    expect(toneOf("fuel")).toBe("bg-pink-800");
  });
});

describe("a pick on a row that left the card", () => {
  it("is never sent: Apply sends only the rows on the card now", () => {
    const picks = { "out:shell": "cost:Fuel", "line:abc": "other_income" };
    // The books changed: the deposit matched, its row is gone.
    const rows = VIEW.rows.filter((r) => r.id !== "line:abc");
    expect(livePicks(picks, rows)).toEqual({ "out:shell": "cost:Fuel" });
    expect(livePicks(picks, VIEW.rows)).toEqual(picks);
  });
});

describe("where the money went: one colour per segment", () => {
  it("no two segments share a colour", () => {
    const keys = ["fuel", "business", "materials", "suppliers", "crew", "draw", "cash_out", "not_cost", "personal", "books", "need", "other"];
    expect(new Set(keys.map(toneOf)).size).toBe(keys.length);
  });
});
