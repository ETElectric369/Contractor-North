import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ setOfficeSeesOwnerMoney: vi.fn() }));

import { LeftForCard } from "./left-for-card";
import { computeOwnerMoney, ownerMoneyWindow, type OwnerMoney, type OwnerMoneyInputs } from "@/lib/analytics/owner-money";
import { pnlRow, profitAndLoss } from "@/lib/analytics/profit-and-loss";
import { BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";
import { ownerRegister } from "@/lib/owner-draw";

/**
 * THE OWNER'S DRAW CARD, READ AS A PROFIT AND LOSS (Erik, 2026-09-28: "the tried and true old school
 * simple wording and formatting of the accounting industry"), with Fuel on its own line, in its own
 * colour (Erik, 2026-09-27: "lets make fuel stand out"), at the top of Overhead (Erik, 2026-09-30:
 * "lets move fuel to overhead above Auto and take out of COGS"). Made-up figures only.
 */
const TZ = "America/Los_Angeles";
const TODAY = "2026-09-24";
const noJob = (id: string, amount: number, category: string, day = "2026-08-12") => ({ id, job_id: null, amount, bill_date: day, created_at: `${day}T18:00:00Z`, category, status: "paid" });
const inputs: OwnerMoneyInputs = {
  payments: [{ amount: 1000, paid_at: "2026-08-20T18:00:00Z", processor_fee: null, stripe_payment_intent: null, invoices: { status: "paid" } }],
  refunds: [],
  bills: [noJob("f1", 150.25, "Fuel"), noJob("a1", 80, "Auto"), noJob("o1", 20, "Other")],
  pos: [],
  pettyCash: [],
  entries: [],
  runs: [],
  payPayments: [],
  creditMemos: [],
  supplierAliases: [],
  people: new Map(),
  recordsStart: "2026-06-01",
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const render = (money: OwnerMoney, viewer = "owner-1") =>
  renderToStaticMarkup(
    createElement(LeftForCard, {
      money,
      problem: null,
      voice: ownerRegister([{ id: "owner-1", name: "Pat Owner" }], viewer),
      windowKey: "2026-08",
      viewerIsOwner: false,
      officeSees: true,
    }),
  );
/** The labels in `want`, each found after the one before it: the card says them in this order. */
const inOrder = (t: string, want: string[]) => {
  let from = 0;
  for (const w of want) {
    const i = t.indexOf(w, from);
    expect(i, `"${w}" after position ${from}`).toBeGreaterThanOrEqual(0);
    from = i + w.length;
  }
};

describe("the Owner's Draw card is a profit and loss", () => {
  const money = computeOwnerMoney(inputs, ownerMoneyWindow("2026-08", TODAY), TZ, TODAY);
  const html = render(money);
  const t = text(html);

  it("reads top to bottom in the accounting industry's order and words", () => {
    inOrder(t, [
      "Revenue $1,000.00",
      "Cost of Goods Sold (COGS)",
      "Materials & Bills $0.00",
      "Crew Pay (1099) $0.00",
      "Total COGS $0.00",
      "Gross Profit $1,000.00",
      "Gross Margin % 100.0%",
      "Overhead",
      "Fuel −$150.25",
      "Auto −$80.00",
      "Other −$20.00",
      "Total Overhead −$250.25",
      "Net Profit $749.75",
      "Before income tax. Ask your accountant how much to set aside.",
    ]);
    // The old words are gone.
    for (const old of ["Received", "Business Costs", "Shop Stock Lost", "Crew Mileage "]) expect(t).not.toContain(old);
  });

  it("Fuel is the first Overhead line, in the Fuel colour, and COGS holds no bucket at all", () => {
    expect(money.totals.fuel).toBe(150.25);
    expect(html).toContain("bg-pink-800");
    const cogs = t.slice(t.indexOf("Cost of Goods Sold (COGS)"), t.indexOf("Total COGS"));
    expect(cogs).not.toMatch(/\bFuel\b/);
    const overhead = t.slice(t.indexOf("Gross Margin %"), t.indexOf("Total Overhead"));
    // Fuel reads above Auto, the list's own order (BUCKET_SECTION, 2026-09-30).
    inOrder(overhead, ["Fuel −$150.25", "Auto −$80.00", "Other −$20.00"]);
    // NO BUCKET IS DRAWN IN THE COGS HALF: whichever ones the window has money in, every one of them
    // is below the Overhead heading.
    const overheadAt = t.indexOf("Overhead", t.indexOf("Total COGS"));
    for (const b of BUSINESS_COST_BUCKETS) {
      const i = t.indexOf(b);
      if (i >= 0) expect(i, b).toBeGreaterThan(overheadAt);
    }
    expect(t).not.toContain("Gas & Truck");
    // A bucket with no money in the window is not a row ($0.00 lines would bury the ones that count).
    expect(overhead).not.toContain("Phone & Office");
  });

  it("the same money: Revenue less COGS is Gross Profit, less Overhead is Net Profit, the engine's own figure", () => {
    expect(money.totals.left).toBe(749.75);
    const rows = profitAndLoss(money.totals);
    // No cost in COGS in this window, so Gross Profit is all of Revenue and every cost is Overhead.
    expect(pnlRow(rows, "gross_profit")!.amount).toBe(1000);
    expect(pnlRow(rows, "total_overhead")!.amount).toBe(250.25);
    expect(pnlRow(rows, "gross_profit")!.cents! - pnlRow(rows, "total_overhead")!.cents!).toBe(pnlRow(rows, "net_profit")!.cents);
    expect(pnlRow(rows, "net_profit")!.cents).toBe(Math.round(money.totals.left * 100));
  });
});

describe("what else the card says, and how", () => {
  it("stock bought rides inside Materials & Bills, with the line under the card saying how much; Stock Lost is its own COGS line", () => {
    const withStock: OwnerMoneyInputs = {
      ...inputs,
      bills: [...inputs.bills, { id: "t1", job_id: "j1", amount: 199.48, bill_date: "2026-08-03", created_at: "2026-08-03T18:00:00Z", category: "Receipt", status: "paid" }],
      shelfLots: [{ lot_id: "L1", bill_id: "t1", cost: 180.17, cost_left: 150, live: true }],
      shelfMoves: [{ id: "m1", lot_id: "L1", kind: "write_off", cost: 30.17, created_at: "2026-08-25T18:00:00Z" }],
    };
    const money = computeOwnerMoney(withStock, ownerMoneyWindow("2026-08", TODAY), TZ, TODAY);
    const t = text(render(money));
    // 19.31 of materials + 180.17 into stock - 30.17 written off = 169.31 inside Materials & Bills.
    inOrder(t, ["Materials & Bills −$169.31", "Stock Lost (Written Off, Counted Short, Returned) −$30.17", "Crew Pay (1099)", "Total COGS −$199.48", "Overhead", "Fuel −$150.25"]);
    expect(t).not.toContain("Stock Bought");
    expect(t).toContain("Materials & Bills includes $150.00 of shop stock, counted the month it was bought, less what moved to Stock Lost.");
    expect(t).toContain("Net Profit $550.27");
    expect(money.totals.left).toBe(550.27);
  });

  it("Other Income is said inside Revenue, in the profit and loss's words", () => {
    const money = computeOwnerMoney({ ...inputs, otherIncome: [{ amount: 250, posted_on: "2026-08-02" }] }, ownerMoneyWindow("2026-08", TODAY), TZ, TODAY);
    const t = text(render(money));
    inOrder(t, ["Revenue $1,250.00", "Other Income (Inside Revenue) $250.00", "Cost of Goods Sold (COGS)"]);
    expect(t).toContain("Net Profit $999.75");
  });

  it("crew pay and mileage in the crew's words; Stripe's fee said inside Fees", () => {
    const money = computeOwnerMoney(
      {
        ...inputs,
        payments: [{ amount: 1000, paid_at: "2026-08-20T18:00:00Z", processor_fee: 29.3, stripe_payment_intent: "pi_1", invoices: { status: "paid" } }],
        entries: [{ id: "e1", profile_id: "crew", status: "closed", clock_in: "2026-08-10T15:00:00Z", clock_out: "2026-08-10T23:00:00Z", lunch_minutes: 0, rate_override: null, paid_at: null }],
        runs: [{ profile_id: "crew", kind: "mileage", period_start: "2026-08-01", period_end: "2026-08-15", gross: 0, mileage_amount: 22.5, created_at: "2026-08-16T18:00:00Z" }],
        people: new Map([["crew", { name: "Casey Crew", paidByDraw: false, hourlyRate: 30 }]]),
      },
      ownerMoneyWindow("2026-08", TODAY),
      TZ,
      TODAY,
    );
    const t = text(render(money));
    inOrder(t, ["Crew Pay (1099) −$240.00", "Crew Mileage Paid −$22.50", "Total COGS −$262.50", "Gross Profit $737.50", "Overhead", "Fuel −$150.25", "Fees (includes $29.30 Stripe fees) −$29.30"]);
  });

  it("a loss month: Gross Profit in red, Net Profit in red, and no margin said on no Revenue", () => {
    // Nothing came in, and a $60 job ticket went out: the jobs alone lose money, so Gross Profit is
    // red before Overhead takes the rest. (Fuel is Overhead now, so a fuel-only month would have a
    // Gross Profit of $0.00 and the red would start at the bottom line.)
    const money = computeOwnerMoney(
      { ...inputs, payments: [], bills: [...inputs.bills, { id: "t1", job_id: "j1", amount: 60, bill_date: "2026-08-03", created_at: "2026-08-03T18:00:00Z", category: "Receipt", status: "paid" }] },
      ownerMoneyWindow("2026-08", TODAY),
      TZ,
      TODAY,
    );
    const html = render(money);
    const t = text(html);
    expect(t).toContain("Total COGS −$60.00");
    expect(t).toContain("Gross Profit -$60.00");
    expect(t).not.toContain("Gross Margin %");
    expect(t).toContain("Total Overhead −$250.25");
    expect(t).toContain("Net Profit -$310.25");
    expect(money.totals.left).toBe(-310.25);
    expect(html).toContain("text-red-700");
    expect(html).toContain("text-red-600");
  });

  /**
   * THE EQUITY NOTE, BOTH WAYS ROUND. Built as a branching head plus a shared tail (" taken off Net
   * Profit."), the one-row arm read "Equity, not a cost: it is taken off Net Profit." - the opposite of
   * the law, on the owner's main money card, in the ordinary case where he put no money in. Each sentence
   * is pinned whole here, because the word that was lost was a single "not".
   */
  it("says a draw is NOT taken off Net Profit, with or without money in from the owner", () => {
    const draws = [{ posted_on: "2026-08-14", amount: -500 }];
    const drawOnly = text(render(computeOwnerMoney({ ...inputs, ownerDraws: draws }, ownerMoneyWindow("2026-08", TODAY), TZ, TODAY)));
    inOrder(drawOnly, ["Owner's Draw $500.00", "Equity, not a cost: it is not taken off Net Profit."]);
    // The figure beside it proves the sentence: Net Profit is revenue less the bills, draw or no draw.
    expect(drawOnly).toContain("Net Profit $749.75");
    expect(drawOnly).not.toContain("Equity, not a cost: it is taken off");

    // TWO ROWS, where "neither" carries the negation instead.
    const both = text(
      render(
        computeOwnerMoney(
          { ...inputs, ownerDraws: draws, ownerMoneyIn: [{ posted_on: "2026-08-16", amount: 700 }] },
          ownerMoneyWindow("2026-08", TODAY),
          TZ,
          TODAY,
        ),
      ),
    );
    inOrder(both, ["Owner's Draw $500.00", "Owner's Money In $700.00", "Equity, not costs: neither is taken off Net Profit."]);
    expect(both).toContain("Net Profit $749.75");
  });

  it("still says it when the app can see no draw at all - the default card", () => {
    // ownerDraw is drawn unconditionally, so the one-row arm is what MOST cards print. It said the wrong
    // thing there, at $0.00, and no test looked at the sentence.
    const none = text(render(computeOwnerMoney(inputs, ownerMoneyWindow("2026-08", TODAY), TZ, TODAY)));
    inOrder(none, ["Owner's Draw $0.00", "Equity, not a cost: it is not taken off Net Profit."]);
  });

  it("the owner's hours are hours, said under the bottom line, never a cost line", () => {
    const money = computeOwnerMoney(
      {
        ...inputs,
        entries: [{ id: "o1", profile_id: "owner-1", status: "closed", clock_in: "2026-08-11T15:00:00Z", clock_out: "2026-08-11T23:00:00Z", lunch_minutes: 0, rate_override: null, paid_at: null }],
        people: new Map([["owner-1", { name: "Pat Owner", paidByDraw: true, hourlyRate: 0 }]]),
      },
      ownerMoneyWindow("2026-08", TODAY),
      TZ,
      TODAY,
    );
    const t = text(render(money));
    // The same Net Profit as with no hours at all: the owner's time costs nothing.
    inOrder(t, ["Net Profit $749.75", "about $93.72 for each hour you worked"]);
    expect(t).toContain("Crew Pay (1099) $0.00");
  });
});
