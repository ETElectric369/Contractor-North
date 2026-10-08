import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
vi.mock("@/app/(app)/bills/bank-actions", () => ({ applyBankDownload: vi.fn(), undoBankDownload: vi.fn(), swapBankDownload: vi.fn(), setBankAccount: vi.fn(), forgetBankRule: vi.fn(), reanswerBankLine: vi.fn() }));
vi.mock("@/app/(app)/organize/paperwork-actions", () => ({ keepPaperwork: vi.fn() }));

import { BankCard, changeChoicesFor, livePicks, othersFor, rowsAnswered, toneOf } from "./bank-card";
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
        { id: "draw", label: "Owner's Draw" },
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
    // ONE SEGMENT FOR WHAT THE OWNER TOOK OUT (0380): Personal was a second one beside it.
    { key: "draw", label: "Owner's Draw", cents: 272000 },
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
  appliedLines: 0,
  swapped: false,
  canSwap: false,
  askAccount: false,
  rules: [{ id: "r1", label: "SHELL → Fuel ($40.00 to $140.00)", n: 26 }],
  sortedLines: [],
  sortedMore: 0,
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
    expect(text).toContain("Owner's Draw $2,720.00");
    expect(text).toContain("SHELL 123 ANYTOWN 3 charges · $288.45");
    // The guess is marked, and NOT picked: no button is pressed until a person taps.
    expect(html).not.toContain('aria-pressed="true"');
    const labels = buttons(html).map((b) => b.text);
    expect(labels.slice(0, 4)).toEqual(["Fuel Guess", "Auto", "Owner's Draw", "Other…"]);
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
    const html = render({ ...VIEW, rows: [{ ...VIEW.rows[0], guess: null, buttons: [{ id: "draw", label: "Owner's Draw" }, { id: "cost:Fuel", label: "Fuel" }] }] });
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

  /**
   * ── THE WAY OUT IS DRAWN IN EVERY STATE, THIS ONE INCLUDED (review, 2026-10-03) ─────────────
   *
   * "Done: Nothing New" used to REPLACE the Set Aside / Delete pair, so the one state a second download
   * of an overlapping month lands in had no Delete and no sentence saying where the paper goes — which
   * is the very thing Erik could not find, in the shape it most often arrives. One put-away door still,
   * not two: the door's words change, the pair does not.
   */
  it("the same month downloaded again: nothing to Apply, and the paper can still be binned", () => {
    const html = render({ ...VIEW, rows: [], counts: { ...VIEW.counts, matched: 0, ruled: 0, needRows: 0, needLines: 0 }, headline: "Bank ••1234 · Aug 26–Sep 25 · 118 already in North · nothing needs you" });
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Done: Nothing New");
    expect(labels).toContain("Delete");
    expect(labels).not.toContain("Apply");
    // One door that puts it away, never two that archive the same paper in different words.
    expect(labels).not.toContain("Set Aside");
    expect(labels.filter((l) => l === "Done: Nothing New")).toHaveLength(1);
    // And where it goes is said ON the card, not only in the toast after the tap.
    expect(textOf(html)).toContain("keeps it in Organize, under Archive");
  });

  /**
   * ── DELETE SAYS WHAT COMES OFF THE BOOKS (review, 2026-10-03) ──────────────────────────────
   *
   * Delete runs `undoBankCore` first, so on a PART-APPLIED download it deletes the bills and the invoice
   * payments Apply wrote and voids the supplier and crew payments — while the confirm said "nothing it
   * would have changed is written". Apply 30 of 40, tap Delete to bin the leftovers, and the customer's
   * payments came off with no word until the toast afterwards.
   */
  it("a part-applied download: the card says Delete also takes back what Apply wrote", () => {
    const html = render({ ...VIEW, appliedSaid: "Applied Sep 27: 30 lines counted.", canUndo: true, appliedLines: 30 });
    const text = textOf(html);
    expect(text).toContain("everything it already wrote comes off: the 30 lines it counted, with their bills and payments");
    // The plain line is still the plain line when nothing has been written.
    expect(textOf(render(VIEW))).not.toContain("already wrote comes off");
  });

  it("the confirm itself carries the sentence, so it is read BEFORE the deed", () => {
    const src = readFileSync(join(process.cwd(), "src/components/not-now-or-delete.tsx"), "utf8");
    // One confirm, built from the clause the card hands in — never a fixed string for every state.
    expect(src).toContain("const tail = clause || \"nothing it would have changed is written\";");
    expect(src).toContain("confirm(`Delete this ${what}? It goes for good, with its file, and ${tail}.`)");
    const card = readFileSync(join(process.cwd(), "src/components/bank-card.tsx"), "utf8");
    expect(card).toContain("alsoTakesBack={");
    expect(card).toContain("view?.appliedLines ?? 0");
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

  /**
   * CHANGE ANSWER (2026-10-07): every line a pass counted is listed under it, folded, each with the
   * answer it holds and one door to change it. The picker is the card's own Other… list for a line of
   * that direction, less the payment answers and the answer it already has.
   */
  it("after a pass, every counted line is listed with Change Answer, and the picker offers no payment answer", () => {
    const counted: BankView = {
      ...VIEW,
      appliedSaid: "Applied Sep 27: 2 lines counted.",
      canUndo: true,
      appliedLines: 2,
      otherOutSingle: [
        { id: "cost:Auto", label: "Auto" },
        { id: "draw", label: "Owner's Draw" },
        { id: "supplier:acct-1", label: "Pay Contractor Supply" },
        { id: "crew:pat", label: "Pay Pat Crew" },
        { id: "job:job-1", label: "On 41 Larkspur · J-054 — Marla Finch" },
      ],
      otherInSingle: [
        { id: "invoice:inv-1", label: "On INV-1001" },
        { id: "other_income", label: "Other Income" },
        { id: "not_income", label: "Already Counted Or Not Income" },
        { id: "owner_in", label: "Owner's Money In" },
        { id: "cost:Fuel", label: "Refund: Fuel" },
      ],
      sortedLines: [
        { id: "l1", day: "Sep 5", title: "Check 1043", money: "$640.00", direction: "out", answer: "Pay Pat Crew", by: "Answered By You", current: "crew:pat" },
        { id: "l2", day: "Sep 3", title: "TRANSFER FROM 9876", money: "$5,000.00", direction: "in", answer: "Already Counted Or Not Income", by: "Answered By You", current: "not_income" },
      ],
      sortedMore: 0,
    };
    const html = render(counted);
    const text = textOf(html);
    expect(text).toContain("Sorted Lines");
    expect(text).toContain("Check 1043 $640.00");
    expect(text).toContain("Pay Pat Crew Answered By You");
    // UNDER THE APPLIED PASS, where what was counted is said.
    expect(html.indexOf("Applied Sep 27")).toBeLessThan(html.indexOf("Sorted Lines"));
    const doors = buttons(html).filter((b) => b.text === "Change Answer");
    expect(doors).toHaveLength(2);
    for (const b of doors) expect(b.markup).toMatch(/h-11|min-h-11/);
    // Money out: the buckets, the draw and a job; never a supplier or crew pay, never what it holds.
    expect(changeChoicesFor(counted.sortedLines[0], counted).map((o) => o.id)).toEqual(["cost:Auto", "draw", "job:job-1"]);
    // Money in: the money-in words and a bucket's refund; never an invoice, never what it holds.
    expect(changeChoicesFor(counted.sortedLines[1], counted).map((o) => o.id)).toEqual(["other_income", "owner_in", "cost:Fuel"]);
    // A card with nothing counted draws no list at all; a read that failed says so.
    expect(textOf(render(VIEW))).not.toContain("Sorted Lines");
    expect(textOf(render({ ...counted, sortedLines: [], sortedProblem: "The lines this download counted couldn't be read just now, so none can be changed here. Refresh the page." }))).toContain(
      "couldn't be read just now",
    );
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

/**
 * A MERCHANT'S ROW OPENS (2026-10-07): a row holding three of a merchant's lines draws "3 Charges",
 * and open, each line takes its own answer under its own id, with the longer Other… list (a job
 * among them). Closed, the row is as it was: the same four buttons first, nothing pressed.
 */
describe("a row that opens", () => {
  const LINES = [
    { id: "line:aaaaaaaaaaaaaaa1", day: "Sep 2", title: "SHELL 123 ANYTOWN", money: "$88.45" },
    { id: "line:aaaaaaaaaaaaaaa2", day: "Sep 9", title: "SHELL 123 ANYTOWN", money: "$100.00" },
    { id: "line:aaaaaaaaaaaaaaa3", day: "Sep 16", title: "SHELL 123 ANYTOWN", money: "$100.00" },
  ];
  const withLines = (): BankView => ({ ...VIEW, rows: [{ ...VIEW.rows[0], lines: LINES }, ...VIEW.rows.slice(1)] });

  it("draws the open control after Other…, closed, a thumb tall and Title Case; a row of one line draws none", () => {
    const html = render(withLines());
    const labels = buttons(html).map((b) => b.text);
    expect(labels.slice(0, 5)).toEqual(["Fuel Guess", "Auto", "Owner's Draw", "Other…", "3 Charges"]);
    const control = buttons(html).find((b) => b.text === "3 Charges")!;
    expect(control.markup).toContain('aria-expanded="false"');
    expect(control.markup).toMatch(/h-11|min-h-11/);
    // Closed, the lines are not drawn: no line's day is on the card.
    expect(textOf(html)).not.toContain("Sep 9");
    for (const b of buttons(html)) expect(titleCase(b.text.replace("…", ""))).toBe(true);
    // The rows of one line draw no control.
    expect(labels.filter((l) => /Charges|Deposits/.test(l))).toEqual(["3 Charges"]);
    expect(buttons(render(VIEW)).some((b) => /Charges|Deposits/.test(b.text))).toBe(false);
  });

  it("keeps a line's pick while its row is on the card, and counts a row answered only by the row or by every line", () => {
    const rows = withLines().rows;
    const picks = { "out:shell": "cost:Fuel", [LINES[0].id]: "job:job-1", "line:abc": "other_income", "line:gone1234567890": "draw" };
    expect(livePicks(picks, rows)).toEqual({ "out:shell": "cost:Fuel", [LINES[0].id]: "job:job-1", "line:abc": "other_income" });
    // The row gone, its line's pick goes with it.
    expect(livePicks(picks, rows.slice(1))).toEqual({ "line:abc": "other_income" });
    // One line of three answered: the row is partly answered - Apply has work, and the row waits.
    expect(rowsAnswered({ [LINES[0].id]: "job:job-1" }, rows)).toEqual({ answered: 0, partly: 1 });
    // Every line answered, or the row itself: answered.
    expect(rowsAnswered(Object.fromEntries(LINES.map((l) => [l.id, "cost:Fuel"])), rows)).toEqual({ answered: 1, partly: 0 });
    expect(rowsAnswered({ "out:shell": "cost:Fuel", [LINES[1].id]: "job:job-1" }, rows)).toEqual({ answered: 1, partly: 0 });
    expect(rowsAnswered({ "line:abc": "other_income" }, rows)).toEqual({ answered: 1, partly: 0 });
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
    const keys = ["fuel", "business", "materials", "suppliers", "crew", "draw", "cash_out", "not_cost", "books", "need", "other"];
    expect(new Set(keys.map(toneOf)).size).toBe(keys.length);
  });
});
