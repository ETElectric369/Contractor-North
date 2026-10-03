import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BankView } from "@/lib/bank-download";
import type { ChannelRow } from "@/lib/bank-money-in";
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
/** A channel row as the pure function returns one: a why is its CLAUSES, joined - carried apart so a line
 *  that prefixes them can leave one out whole instead of slicing the word that carries it. */
const chRow = (r: Omit<ChannelRow, "why">): ChannelRow => ({ ...r, why: r.whyParts.join(" ") });

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
  // WHERE THE MONEY CAME IN: invented figures of the shape bank-money-in.ts returns - a channel that
  // reaches the account, one that only reaches it after its fee, one that is still in the app, cash that
  // never reaches it at all, and payments nobody said the method of.
  channels: {
    rows: [
      chRow({ key: "check", label: "Check", fate: "as_itself", recordedCents: 2_536_711, expectedCents: 2_536_711, namedCents: null, whyParts: ["Expect all of it here, a few days after it was paid."] }),
      chRow({
        key: "card",
        label: "Card",
        fate: "net_of_fee",
        recordedCents: 1_775_163,
        expectedCents: 1_722_855,
        namedCents: 1_722_855,
        whyParts: ["A payout lands days later: $17,228.55 after $523.08 of fees.", "The statement names exactly that much."],
      }),
      chRow({ key: "venmo", label: "Venmo", fate: "when_swept", recordedCents: 1_638_411, expectedCents: 1_638_411, namedCents: 0, whyParts: ["Sits in Venmo until somebody moves it to the bank.", "Nothing on the statement names Venmo."] }),
      chRow({ key: "cash", label: "Cash", fate: "never_banked", recordedCents: 645_135, expectedCents: 0, namedCents: null, whyParts: ["Cash never reaches the bank. Its receipts are already costs."] }),
      chRow({ key: "not_said", label: "Not Said How It Was Paid", fate: "unsaid", recordedCents: 41_000, expectedCents: null, namedCents: null, whyParts: ["Nobody wrote down how these were paid, so there is no saying where they land."] }),
    ],
    recordedCents: 6_636_420,
    expectedCents: 5_897_977,
    reachedCents: 3_423_956,
    unsaidCents: 41_000,
    unnamedCents: 1_701_101,
    say: "$24,740.21 of what you were paid hasn't reached this account. $16,384.11 of it may still be in Venmo \u2014 the statement doesn't say it was moved to the bank.",
  },
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
  /**
   * WHERE YOUR MONEY CAME IN (0376's lane), the block above the rows: one line per way of being paid,
   * what was paid and what should reach THIS account, then the one sentence. It is what makes most of
   * the rows below it stop mattering, so it is drawn before them.
   */
  it("says how he was paid and what should reach this account, above the rows", () => {
    const text = textOf(render(VIEW));
    expect(text).toContain("How You Were Paid");
    // AND BOTH COLUMNS ARE NAMED. The rows drew two bare dollar figures - "Check $25,367.11 $25,367.11" -
    // with nothing saying which was paid and which should reach here, and the darker of the two could be
    // read as Reached It. The headings the block's own sketch has always shown are now drawn.
    expect(text).toContain("How You Were Paid Paid Should Reach Here");
    expect(text).toContain("Check $25,367.11 $25,367.11");
    // A CARD IS ITSELF LESS ITS FEE, and the row says so where he reads the figure.
    expect(text).toContain("Card $17,751.63 $17,228.55");
    expect(text).toContain("A payout lands days later: $17,228.55 after $523.08 of fees.");
    // CASH IS A STATEMENT, NOT A ROW TO BALANCE.
    expect(text).toContain("Cash $6,451.35 $0.00");
    expect(text).toContain("Cash never reaches the bank.");
    // A FIGURE THAT COULD NOT BE WORKED OUT SHOWS A DASH, never a 0 this card made up - and says why.
    expect(text).toContain("Not Said How It Was Paid $410.00 \u2014");
    expect(text).toContain("Nobody wrote down how these were paid");
    // THE TWO TOTALS, the deposits that say nothing, and THE ONE SENTENCE leading with the figure.
    expect(text).toContain("Should Reach Here $58,979.77");
    expect(text).toContain("Reached It $34,239.56");
    expect(text).toContain("Deposits That Don't Say Which $17,011.01");
    expect(text).toContain(VIEW.channels!.say);
    // It is ABOVE the rows and above the where-it-went bar.
    const html = render(VIEW);
    expect(html.indexOf("How You Were Paid")).toBeLessThan(html.indexOf("Where $3,685.00 Went"));
    expect(html.indexOf("How You Were Paid")).toBeLessThan(html.indexOf("SHELL 123 ANYTOWN"));
  });

  it("draws no block at all when there is nothing worked out to say", () => {
    // The card an office viewer the owner keeps owner money from is handed has channels null, and a block
    // of dashes would be a dead end. Nothing of it reaches the markup either.
    const text = textOf(render({ ...VIEW, channels: null }));
    expect(text).not.toContain("How You Were Paid");
    expect(text).not.toContain("Should Reach Here");
  });

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
    // DELETE IS ON THE CARD, AND BOTH DOORS SAY WHERE THE PAPER GOES (2026-10-03). Erik dropped a
    // statement, wanted to bin it, and could not: this row draws no menu, so Set Aside was the only way
    // out and it archived the download with no word on the card about where it went.
    expect(labels).toContain("Delete");
    expect(text).toContain("Set Aside keeps it in Organize, under Archive");
    expect(text).toContain("Delete removes it and its file for good");
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

  it("a problem is said, with Set Aside and Delete; no Apply", () => {
    const html = render({ ...VIEW, problem: "Sorting a bank download needs one database update first. It is waiting here and nothing was changed." });
    const text = textOf(html);
    expect(text).toContain("needs one database update");
    expect(text).not.toContain("Apply");
    expect(text).toContain("Set Aside");
    // A DOWNLOAD HE CANNOT ANSWER IS STILL ONE HE CAN BIN: the way out is drawn in every state.
    expect(buttons(html).map((b) => b.text)).toContain("Delete");
  });

  it("the same month downloaded again: nothing to Apply, one tap puts it away", () => {
    const html = render({ ...VIEW, rows: [], counts: { ...VIEW.counts, matched: 0, ruled: 0, needRows: 0, needLines: 0 }, headline: "Bank ••1234 · Aug 26–Sep 25 · 118 already in North · nothing needs you" });
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Done: Nothing New");
    expect(labels).not.toContain("Apply");
  });

  /**
   * A SCANNED STATEMENT'S CARD SAYS WHAT CHECKED THE READ (2026-10-02). Its lines are a model's
   * transcription of a picture, and the only thing that makes them safe to look at is the statement's
   * own printed figures. Whether those agreed — or whether the paper printed none at all — has to be in
   * front of him HERE, beside Apply, and not only in the line under the button he dropped it at.
   */
  it("a scanned statement's card carries what the arithmetic found, beside Apply", () => {
    const agreed = textOf(render({ ...VIEW, readSaid: "Held against the statement's own printed figures: the money going out and the money coming in agree to the cent." }));
    expect(agreed).toContain("agree to the cent");
    const nothing = textOf(render({ ...VIEW, readSaid: "This statement prints no totals to hold the read against, so NOTHING here checked it: every line is the reader's word." }));
    expect(nothing).toContain("NOTHING here checked it");
    // A DOWNLOAD IS ARITHMETIC END TO END and carries no such line, so the card says nothing extra.
    expect(textOf(render(VIEW))).not.toContain("checked it");
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
