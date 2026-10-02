import { describe, it, expect } from "vitest";
import {
  PNL_KINDS,
  PNL_KIND_SHAPE,
  PNL_SECTIONS,
  PNL_SECTION_SHAPE,
  PNL_WORDS,
  isBelowNetProfit,
  bucketAmount,
  bucketHalvesWords,
  cogsWords,
  grossMarginPct,
  materialsWithStock,
  overheadWords,
  pnlKeyOfCostTarget,
  pnlLines,
  pnlRow,
  profitAndLoss,
  sayPct,
  type PnlKey,
  type PnlRow,
} from "./profit-and-loss";
import { BUCKET_SECTION, BUSINESS_COST_BUCKETS, bucketsIn } from "@/lib/business-cost-buckets";
import { computeOwnerMoney, ownerMoneyWindow, type OwnerMoneyFigures, type OwnerMoneyInputs } from "./owner-money";

/**
 * THE PROFIT AND LOSS (Erik, 2026-09-28): the accounting industry's own words and order, the same
 * dollars the engine already makes. Every figure here is made up.
 */

const figures = (over: Partial<OwnerMoneyFigures> = {}): OwnerMoneyFigures => {
  const f: OwnerMoneyFigures = {
    received: 10000,
    otherIncome: 250,
    materialsAndBills: 2000,
    crewPay: 1500,
    crewMileagePaid: 40,
    fuel: 300,
    businessCosts: { Auto: 120, "Tools & Supplies": 80, "Phone & Office": 60, "Insurance & Licenses": 200, Fees: 45.5, Other: 10 },
    businessCostsTotal: 515.5,
    processorFees: 25,
    putOnShelf: 150,
    shopStockLost: 20,
    stockMovedOut: 20,
    left: 0,
    ownerHours: 100,
    perOwnerHour: null,
    // THE OWNER'S BUILD TIME IS NOT IN THE SUBTRACTION BELOW, and that is the whole point: the charged
    // line and its contra net to zero inside COGS, so `left` is the same figure whatever this is.
    ownerBuildTimeOnJobs: 0,
    ownerOnSiteHours: 0,
    ownerOfficeHours: 0,
    ownerUncostedBuildTimeHours: 0,
    ownerDraw: 0,
    ...over,
  };
  // The engine's own subtraction, so `left` is always what computeOwnerMoney would say for these lines.
  const c = (n: number) => Math.round(n * 100);
  const bizCents = Object.values(f.businessCosts).reduce((s, v) => s + c(v), 0);
  const leftCents = c(f.received) - c(f.materialsAndBills) - c(f.crewPay) - c(f.crewMileagePaid) - c(f.fuel) - bizCents - c(f.putOnShelf) - c(f.shopStockLost);
  return { ...f, businessCostsTotal: bizCents / 100, left: "left" in over ? over.left! : leftCents / 100 };
};

const at = (rows: PnlRow[], key: PnlKey) => pnlRow(rows, key)!;

describe("the layout: the accounting industry's words, in its order", () => {
  it("Revenue, COGS line by line and Total COGS, Gross Profit and its margin, Overhead line by line and Total Overhead, Net Profit", () => {
    const lines = pnlLines({ otherIncome: true, margin: true });
    expect(lines.map((l) => l.label)).toEqual([
      "Revenue",
      "Other Income (Inside Revenue)",
      "Cost of Goods Sold (COGS)",
      "Materials & Bills",
      "Stock Bought",
      "Stock Lost (Written Off, Counted Short, Returned)",
      "Crew Pay (1099)",
      "Crew Mileage Paid",
      "Total COGS",
      "Gross Profit",
      "Gross Margin %",
      "Overhead",
      "Fuel",
      "Auto",
      "Tools & Supplies",
      "Phone & Office",
      "Insurance & Licenses",
      "Fees",
      "Other",
      "Total Overhead",
      "Net Profit",
    ]);
    expect(lines.map((l) => l.kind)).toEqual([
      "revenue",
      "part",
      "heading",
      "cost", // Materials & Bills
      "cost", // Stock Bought
      "cost", // Stock Lost
      "cost", // Crew Pay (1099)
      "cost", // Crew Mileage Paid
      "total",
      "profit",
      "margin",
      "heading",
      "cost", // Fuel
      "cost", // Auto
      "cost", // Tools & Supplies
      "cost", // Phone & Office
      "cost", // Insurance & Licenses
      "cost", // Fees
      "cost", // Other
      "total",
      "profit",
    ]);
    // Every cost line sits under the heading of its own half, and each half ends in its total.
    const cogsAt = lines.findIndex((l) => l.key === "cogs");
    const totalCogsAt = lines.findIndex((l) => l.key === "total_cogs");
    const overheadAt = lines.findIndex((l) => l.key === "overhead");
    const totalOverheadAt = lines.findIndex((l) => l.key === "total_overhead");
    lines.forEach((l, i) => {
      if (l.kind !== "cost") return;
      if (l.section === "cogs") expect(i > cogsAt && i < totalCogsAt, l.label).toBe(true);
      else expect(i > overheadAt && i < totalOverheadAt, l.label).toBe(true);
    });
  });

  it("the row words are Title Case, and the names are the ones Erik asked for, exactly", () => {
    expect(PNL_WORDS.cogs).toBe("Cost of Goods Sold (COGS)");
    expect(PNL_WORDS.netProfit).toBe("Net Profit");
    expect(PNL_WORDS.stockLost).toBe("Stock Lost (Written Off, Counted Short, Returned)");
    for (const l of pnlLines({ otherIncome: true, margin: true })) {
      // Every word starts with a capital, but "of" and the words inside a parenthesis read as written.
      const words = l.label.replace(/\(.*?\)/g, "").split(/\s+/).filter((w) => /^[a-z]/i.test(w) && w !== "of");
      for (const w of words) expect(w[0], `${l.label}: ${w}`).toBe(w[0].toUpperCase());
    }
  });

  it("Other Income and the margin are there only when a surface asks for them", () => {
    const keys = pnlLines().map((l) => l.key);
    expect(keys).not.toContain("other_income");
    expect(keys).not.toContain("gross_margin");
  });
});

describe("the same dollars, in new places", () => {
  const f = figures();
  const rows = profitAndLoss(f, { otherIncome: true, margin: true });

  it("Total COGS is its lines; Gross Profit is Revenue less it; Total Overhead is its lines; Net Profit is the engine's own figure", () => {
    expect(at(rows, "revenue").cents).toBe(1_000_000);
    expect(at(rows, "other_income").cents).toBe(25_000); // inside Revenue, never added to it
    // 2,000 + 150 + 20 + 1,500 + 40: the job-side lines, and no bucket (Fuel moved out, 2026-09-30)
    expect(at(rows, "total_cogs").cents).toBe(371_000);
    expect(at(rows, "gross_profit").cents).toBe(1_000_000 - 371_000);
    // 300 (Fuel) + 120 + 80 + 60 + 200 + 45.50 + 10: every bucket
    expect(at(rows, "total_overhead").cents).toBe(81_550);
    expect(at(rows, "net_profit").cents).toBe(Math.round(f.left * 100));
    // THE PARITY: Gross Profit less Total Overhead lands on the engine's net, to the cent.
    expect(at(rows, "gross_profit").cents! - at(rows, "total_overhead").cents!).toBe(at(rows, "net_profit").cents);
    expect(at(rows, "net_profit").amount).toBe(5474.5);
  });

  it("each cost line is the engine's own figure, and Fuel is the engine's Fuel line", () => {
    expect(at(rows, "materials").amount).toBe(2000);
    expect(at(rows, "stock_bought").amount).toBe(150);
    expect(at(rows, "stock_lost").amount).toBe(20);
    expect(at(rows, "crew_pay").amount).toBe(1500);
    expect(at(rows, "crew_mileage").amount).toBe(40);
    expect(at(rows, "bucket:Fuel").amount).toBe(300);
    for (const b of BUSINESS_COST_BUCKETS) expect(at(rows, `bucket:${b}`).amount, b).toBe(bucketAmount(f, b));
    expect(bucketAmount(f, "Fees")).toBe(45.5); // Stripe's fee is already inside Fees
    // Headings and the margin carry no money.
    expect(at(rows, "cogs").cents).toBeNull();
    expect(at(rows, "overhead").cents).toBeNull();
    expect(at(rows, "gross_margin").cents).toBeNull();
  });

  it("the owner's time is never a cost: owner hours move no line", () => {
    const more = profitAndLoss(figures({ ownerHours: 400, perOwnerHour: 1 }), { otherIncome: true, margin: true });
    expect(more).toEqual(rows);
    expect(pnlLines({ otherIncome: true, margin: true }).some((l) => /hour/i.test(l.label))).toBe(false);
  });

  it("stock bought inside Materials & Bills (the card and the chart): the same totals, one line fewer", () => {
    const folded = profitAndLoss(f, { stockInMaterials: true });
    expect(pnlRow(folded, "stock_bought")).toBeUndefined();
    expect(at(folded, "materials").amount).toBe(materialsWithStock(f));
    expect(at(folded, "materials").amount).toBe(2150);
    for (const k of ["revenue", "total_cogs", "gross_profit", "total_overhead", "net_profit"] as const) expect(at(folded, k).cents, k).toBe(at(rows, k).cents);
  });

  it("a write-off month: Stock Bought gives back what Stock Lost takes, and nothing below moves", () => {
    const writeOff = figures({ putOnShelf: -36.93, shopStockLost: 36.93 });
    const plain = figures({ putOnShelf: 0, shopStockLost: 0 });
    const a = profitAndLoss(writeOff);
    const b = profitAndLoss(plain);
    for (const k of ["total_cogs", "gross_profit", "net_profit"] as const) expect(at(a, k).cents, k).toBe(at(b, k).cents);
  });
});

describe("Gross Margin %, where a percent fits", () => {
  it("Gross Profit as a percent of Revenue, one decimal", () => {
    const rows = profitAndLoss(figures(), { margin: true });
    expect(at(rows, "gross_margin").pct).toBe(62.9); // 6,290 of 10,000
    expect(grossMarginPct(417_000, 176_250)).toBe(42.3);
    expect(grossMarginPct(300_000, 100_000)).toBe(33.3);
  });

  it("a loss reads negative; no Revenue (or less than none) has no margin at all, never 0% or a divide by zero", () => {
    expect(grossMarginPct(100_000, -12_500)).toBe(-12.5);
    expect(grossMarginPct(0, -5_000)).toBeNull();
    expect(grossMarginPct(-3_000, -5_000)).toBeNull();
    expect(Object.is(grossMarginPct(100_000, -4), 0)).toBe(true); // never "-0.0%"
    const none = profitAndLoss(figures({ received: 0, otherIncome: 0 }), { margin: true });
    expect(at(none, "gross_margin").pct).toBeNull();
  });

  it("said the way a person reads it", () => {
    expect(sayPct(42.3)).toBe("42.3%");
    expect(sayPct(-12.5)).toBe("−12.5%");
    expect(sayPct(0)).toBe("0.0%");
  });
});

describe("the owner's switch: an office viewer the owner hasn't shared Owner's Draw with", () => {
  it("gets the cost rows one by one under their two headings: no Revenue, no totals, no Gross Profit or margin, no Net Profit", () => {
    const lines = pnlLines({ otherIncome: true, margin: true, showOwner: false });
    expect(lines.map((l) => l.label)).toEqual([
      "Cost of Goods Sold (COGS)",
      "Materials & Bills",
      "Stock Bought",
      "Stock Lost (Written Off, Counted Short, Returned)",
      "Crew Pay (1099)",
      "Crew Mileage Paid",
      "Overhead",
      "Fuel",
      "Auto",
      "Tools & Supplies",
      "Phone & Office",
      "Insurance & Licenses",
      "Fees",
      "Other",
    ]);
    expect(lines.every((l) => !l.ownerOnly)).toBe(true);
    expect(lines.every((l) => l.kind === "heading" || l.kind === "cost")).toBe(true);
  });

  it("what it leaves out is exactly the owner's lines", () => {
    const owner = pnlLines({ otherIncome: true, margin: true });
    expect(owner.filter((l) => l.ownerOnly).map((l) => l.key)).toEqual(["revenue", "other_income", "total_cogs", "gross_profit", "gross_margin", "total_overhead", "net_profit"]);
    // No figure the office gets is Revenue, a total or a profit.
    const f = figures();
    const office = profitAndLoss(f, { otherIncome: true, margin: true, showOwner: false });
    const theirs = new Set(office.map((r) => r.cents).filter((c): c is number => c != null));
    const own = profitAndLoss(f, { otherIncome: true, margin: true });
    for (const k of ["revenue", "total_cogs", "gross_profit", "total_overhead", "net_profit"] as const) expect(theirs.has(at(own, k).cents!), k).toBe(false);
  });
});

describe("the COGS/Overhead split is data (BUCKET_SECTION), not an if", () => {
  it("every bucket is Overhead (Erik moved Fuel there on 2026-09-30); each bucket is on the profit and loss exactly once", () => {
    expect(BUCKET_SECTION.Fuel).toBe("overhead");
    expect(bucketsIn("cogs")).toEqual([]);
    expect(bucketsIn("overhead")).toEqual(["Fuel", "Auto", "Tools & Supplies", "Phone & Office", "Insurance & Licenses", "Fees", "Other"]);
    const lines = pnlLines();
    for (const b of BUSINESS_COST_BUCKETS) {
      const mine = lines.filter((l) => l.key === `bucket:${b}`);
      expect(mine, b).toHaveLength(1);
      expect(mine[0].section, b).toBe(BUCKET_SECTION[b]);
    }
  });

  it("move a bucket in the data and it moves on the profit and loss, totals and all, with Net Profit where it was", () => {
    const f = figures();
    const before = profitAndLoss(f);
    const section = BUCKET_SECTION as Record<string, "cogs" | "overhead">;
    section.Auto = "cogs";
    try {
      const after = profitAndLoss(f);
      expect(pnlRow(after, "bucket:Auto")!.section).toBe("cogs");
      expect(at(after, "total_cogs").cents).toBe(at(before, "total_cogs").cents! + 12_000);
      expect(at(after, "total_overhead").cents).toBe(at(before, "total_overhead").cents! - 12_000);
      expect(at(after, "gross_profit").cents).toBe(at(before, "gross_profit").cents! - 12_000);
      expect(at(after, "net_profit").cents).toBe(at(before, "net_profit").cents);
      expect(cogsWords()).toContain("Auto");
      expect(overheadWords()).not.toContain("Auto");
    } finally {
      section.Auto = "overhead";
    }
    expect(profitAndLoss(f)).toEqual(before);
  });

  it("the sentences name the lines from the data", () => {
    expect(cogsWords()).toBe("Materials & Bills, Stock Bought, Stock Lost, Crew Pay (1099) and Crew Mileage Paid");
    expect(cogsWords({ stockInMaterials: true })).toBe("Materials & Bills, Stock Lost, Crew Pay (1099) and Crew Mileage Paid");
    expect(overheadWords()).toBe("Fuel, Auto, Tools & Supplies, Phone & Office, Insurance & Licenses, Fees and Other");
  });

  /**
   * A HALF WITH NO BUCKET IN IT IS A SENTENCE, NEVER A GAP. COGS holds no bucket at all now, and
   * Nort's get_bill description built its sentence by joining bucketsIn("cogs") itself: the day Fuel
   * moved, a model was being told "on the company's profit and loss  are in Cost of Goods Sold
   * (COGS) and the rest in Overhead". bucketHalvesWords is the one way to say the split.
   */
  it("the split as a sentence: every bucket in one half reads as that, with no empty list joined into it", () => {
    expect(bucketHalvesWords()).toBe("every bucket is in Overhead");
    const section = BUCKET_SECTION as Record<string, "cogs" | "overhead">;
    try {
      section.Fuel = "cogs";
      expect(bucketHalvesWords()).toBe("Fuel is in Cost of Goods Sold (COGS) and the rest in Overhead");
      section.Auto = "cogs";
      expect(bucketHalvesWords()).toBe("Fuel and Auto are in Cost of Goods Sold (COGS) and the rest in Overhead");
      for (const b of BUSINESS_COST_BUCKETS) section[b] = "cogs";
      expect(bucketHalvesWords()).toBe("every bucket is in Cost of Goods Sold (COGS)");
    } finally {
      for (const b of BUSINESS_COST_BUCKETS) section[b] = "overhead";
    }
    expect(bucketHalvesWords()).toBe("every bucket is in Overhead");
    // However it reads, it is one sentence: no double space where a list was, no dangling verb.
    expect(bucketHalvesWords()).not.toMatch(/\s{2,}|^\s|\s$/);
  });

  it("every cost line the engine writes lands on a line of the profit and loss", () => {
    const keys = new Set(pnlLines().map((l) => l.key));
    for (const to of ["materials", "stock", "stock_lost", ...BUSINESS_COST_BUCKETS] as const) expect(keys.has(pnlKeyOfCostTarget(to)), to).toBe(true);
    expect(pnlKeyOfCostTarget("stock")).toBe("stock_bought");
    expect(pnlKeyOfCostTarget("Fuel")).toBe("bucket:Fuel");
  });

  it("a chip's name where the row's is longer than a chip holds", () => {
    const short = new Map(pnlLines().map((l) => [l.key, l.short]));
    expect(short.get("stock_lost")).toBe("Stock Lost");
    expect(short.get("total_overhead")).toBe("Overhead");
    expect(short.get("net_profit")).toBe("Net Profit");
  });
});

describe("on the engine's own figures, month by month: Net Profit is computeOwnerMoney's net to the cent", () => {
  // A made-up company's year: payments (one voided, one with a card fee), a refund, a bank deposit
  // filed as Other Income, job tickets (one with a roll put into stock), a purchase order, job and
  // business petty cash, every business bucket, a write-off, a crew member's hours and a mileage
  // settlement, and the owner's own hours.
  const TZ = "America/Denver";
  const TODAY = "2026-09-20";
  const noJob = (id: string, amount: number, day: string, category: string) => ({ id, job_id: null, amount, bill_date: day, created_at: `${day}T18:00:00Z`, category, status: "paid" });
  const inputs: OwnerMoneyInputs = {
    payments: [
      { amount: 4200, paid_at: "2026-07-08T18:00:00Z", processor_fee: 121.8, stripe_payment_intent: "pi_1", invoices: { status: "paid" } },
      { amount: 3100.55, paid_at: "2026-08-19T18:00:00Z", processor_fee: null, stripe_payment_intent: null, invoices: { status: "paid" } },
      { amount: 900, paid_at: "2026-08-21T18:00:00Z", processor_fee: null, stripe_payment_intent: null, invoices: { status: "void" } },
      { amount: 2750, paid_at: "2026-09-03T18:00:00Z", processor_fee: null, stripe_payment_intent: null, invoices: { status: "paid" } },
    ],
    refunds: [{ amount: 212.4, created_at: "2026-09-05T18:00:00Z" }],
    otherIncome: [{ amount: 310, posted_on: "2026-08-02" }],
    bills: [
      { id: "b1", job_id: "j1", amount: 1480.25, bill_date: "2026-07-10", created_at: "2026-07-10T18:00:00Z", category: "Receipt", status: "paid" },
      { id: "b2", job_id: "j2", amount: 655.1, bill_date: "2026-08-12", created_at: "2026-08-12T18:00:00Z", category: "Receipt", status: "paid" },
      noJob("f1", 88.4, "2026-07-14", "Fuel"),
      noJob("f2", 94.15, "2026-08-14", "gas"),
      noJob("a1", 412, "2026-08-02", "Auto"),
      noJob("t1", 57.99, "2026-07-22", "Tools & Supplies"),
      noJob("p1", 95, "2026-09-01", "Phone & Office"),
      noJob("i1", 640, "2026-07-01", "Insurance & Licenses"),
      noJob("fe1", 35, "2026-09-02", "Fees"),
      noJob("o1", 19.5, "2026-09-09", ""),
    ],
    pos: [{ id: "po1", job_id: "j2", total: 240, status: "sent", ordered_at: "2026-09-10T18:00:00Z", created_at: "2026-09-10T18:00:00Z" }],
    pettyCash: [
      { job_id: "j1", amount: 23.75, kind: "expense", category: null, tx_date: "2026-07-11", created_at: "2026-07-11T18:00:00Z" },
      { job_id: null, amount: 14, kind: "expense", category: "Other", tx_date: "2026-08-30", created_at: "2026-08-30T18:00:00Z" },
      { job_id: null, amount: 200, kind: "replenish", category: null, tx_date: "2026-08-30", created_at: "2026-08-30T18:00:00Z" },
    ],
    entries: [
      { id: "e1", profile_id: "crew", status: "closed", clock_in: "2026-07-09T14:00:00Z", clock_out: "2026-07-09T22:00:00Z", lunch_minutes: 0, rate_override: null, paid_at: null },
      { id: "e2", profile_id: "crew", status: "closed", clock_in: "2026-08-20T14:00:00Z", clock_out: "2026-08-20T20:30:00Z", lunch_minutes: 30, rate_override: null, paid_at: null },
      { id: "e3", profile_id: "boss", status: "closed", clock_in: "2026-08-20T14:00:00Z", clock_out: "2026-08-21T00:00:00Z", lunch_minutes: 0, rate_override: null, paid_at: null },
    ],
    runs: [{ profile_id: "crew", kind: "mileage", period_start: "2026-08-01", period_end: "2026-08-15", gross: 0, mileage_amount: 41.25, created_at: "2026-08-16T18:00:00Z" }],
    payPayments: [],
    creditMemos: [],
    supplierAliases: [],
    people: new Map([
      ["crew", { name: "Casey Crew", paidByDraw: false, hourlyRate: 36 }],
      ["boss", { name: "Robin Boss", paidByDraw: true, hourlyRate: 0 }],
    ]),
    recordsStart: "2026-07-01",
    shelfLots: [{ lot_id: "L1", bill_id: "b1", cost: 300, cost_left: 250, live: true }],
    shelfMoves: [{ id: "m1", lot_id: "L1", kind: "write_off", cost: 50, created_at: "2026-09-12T18:00:00Z" }],
  };
  const year = computeOwnerMoney(inputs, ownerMoneyWindow("this_year", TODAY), TZ, TODAY);

  it("holds for every month and the year, every layout", () => {
    const sets = [year.totals, ...year.months];
    for (const f of sets) {
      for (const opts of [
        {},
        { stockInMaterials: true },
        { otherIncome: true, margin: true },
        // AND WITH THE OWNER'S TWO SECTIONS ON (0373). Every identity above has to hold identically:
        // the build-time pair nets to zero inside COGS, and the draw is below the line in a section the
        // shape says is not subtracted, so no sum can reach it.
        { otherIncome: true, margin: true, ownerBuildTime: true, ownerDraw: true },
      ]) {
        const rows = profitAndLoss(f, opts);
        const costs = rows.filter((r) => r.kind === "cost");
        const sum = (section: "cogs" | "overhead") => costs.filter((r) => r.section === section).reduce((s, r) => s + r.cents!, 0);
        expect(at(rows, "net_profit").cents).toBe(Math.round(f.left * 100));
        expect(at(rows, "revenue").cents).toBe(Math.round(f.received * 100));
        expect(at(rows, "total_cogs").cents).toBe(sum("cogs"));
        expect(at(rows, "total_overhead").cents).toBe(sum("overhead"));
        expect(at(rows, "gross_profit").cents).toBe(at(rows, "revenue").cents! - at(rows, "total_cogs").cents!);
        expect(at(rows, "gross_profit").cents! - at(rows, "total_overhead").cents!).toBe(at(rows, "net_profit").cents);
        // Overhead is what the card called Business Costs PLUS Fuel, which the engine keeps on its own
        // line; COGS plus it is every cost the engine counted.
        expect(at(rows, "total_overhead").cents).toBe(Math.round(f.businessCostsTotal * 100) + Math.round(f.fuel * 100));
      }
    }
  });

  it("the fixture moves money on every line (a check that the parity isn't passing on zeros)", () => {
    const rows = profitAndLoss(year.totals, { otherIncome: true, margin: true });
    for (const r of rows.filter((x) => x.kind === "cost" || x.kind === "part")) expect(Math.abs(r.cents!), r.label).toBeGreaterThan(0);
    expect(year.totals.ownerHours).toBe(10); // the owner's hours: counted as hours, in no line
    expect(at(rows, "gross_margin").pct).not.toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ALLOCATION NETS TO ZERO: NET PROFIT MUST NOT MOVE BY ONE CENT (0373).
 *
 * This is the test the whole change stands on. Erik is right that his build time is a direct cost, and
 * standard practice is right that a sole proprietor cannot DEDUCT his own labour - the business is not
 * separate from him, so every dollar of profit is already his personal income on Schedule C and there is
 * no owner wage expense. Both hold at once only because the amount is charged inside COGS and booked
 * straight back on a contra line immediately under it.
 *
 * If Net Profit moves when the allocation is switched on, THE ALLOCATION IS WRONG and his tax figure is
 * wrong with it. So: the same figures, with the allocation off and then on at a real amount, and every
 * line from Total COGS down asserted identical to the cent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("the owner's build time: charged inside COGS, booked straight back, Net Profit unchanged", () => {
  const off = figures({ ownerBuildTimeOnJobs: 0, ownerOnSiteHours: 0 });
  // 41 hours at a $65 cost rate. NOT his $125 bill rate: at the bill rate his labour earns zero margin,
  // which is the exact defect 0286 was written to fix.
  const on = figures({ ownerBuildTimeOnJobs: 2665, ownerOnSiteHours: 41 });
  const OPTS = { otherIncome: true, margin: true, ownerBuildTime: true, ownerDraw: true } as const;

  it("NET PROFIT IS IDENTICAL, before he sets a rate and after", () => {
    const before = profitAndLoss(off, OPTS);
    const after = profitAndLoss(on, OPTS);
    expect(at(after, "net_profit").cents).toBe(at(before, "net_profit").cents);
    // And it is still the engine's own `left`, read straight off it: never re-added here.
    expect(at(after, "net_profit").cents).toBe(Math.round(on.left * 100));
    expect(on.left).toBe(off.left);
  });

  it("so are Total COGS, Gross Profit and Gross Margin % - the pair nets inside the section", () => {
    const before = profitAndLoss(off, OPTS);
    const after = profitAndLoss(on, OPTS);
    for (const key of ["total_cogs", "gross_profit", "total_overhead", "revenue"] as PnlKey[]) {
      expect(at(after, key).cents, key).toBe(at(before, key).cents);
    }
    expect(at(after, "gross_margin").pct).toBe(at(before, "gross_margin").pct);
  });

  it("the money IS on the sheet: charged on its own line, and the contra is exactly its negative", () => {
    const rows = profitAndLoss(on, OPTS);
    expect(at(rows, "owner_build_time").cents).toBe(266_500);
    expect(at(rows, "owner_build_time_contra").cents).toBe(-266_500);
    expect(at(rows, "owner_build_time").cents! + at(rows, "owner_build_time_contra").cents!).toBe(0);
    // Both INSIDE COGS, and the contra immediately after the charge, so a reader sees it net out.
    expect(at(rows, "owner_build_time").section).toBe("cogs");
    expect(at(rows, "owner_build_time_contra").section).toBe("cogs");
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf("owner_build_time_contra")).toBe(keys.indexOf("owner_build_time") + 1);
    expect(keys.indexOf("owner_build_time_contra")).toBeLessThan(keys.indexOf("total_cogs"));
  });

  it("BOTH LINES OR NEITHER: one switch builds the pair, and the pair is marked as netting", () => {
    expect(pnlLines({ ownerBuildTime: true }).filter((l) => l.netting).map((l) => [l.key, l.netting])).toEqual([
      ["owner_build_time", "charged"],
      ["owner_build_time_contra", "contra"],
    ]);
    // Off, neither is there - never one of them.
    expect(pnlLines({}).filter((l) => l.netting)).toEqual([]);
    // Every `charged` line has exactly one `contra` in the same section, whatever the layout.
    for (const opts of [{ ownerBuildTime: true }, { ownerBuildTime: true, stockInMaterials: true }, { ownerBuildTime: true, margin: true }]) {
      const lines = pnlLines(opts);
      const charged = lines.filter((l) => l.netting === "charged");
      const contra = lines.filter((l) => l.netting === "contra");
      expect(charged).toHaveLength(contra.length);
      for (const c of charged) expect(contra.some((x) => x.section === c.section)).toBe(true);
    }
  });

  it("ANY netting pair sums to zero on ANY figures, so the netting is a property and not a fixture", () => {
    for (const cents of [0, 1, 99, 266_500, 123_456_789, -5000]) {
      const f = figures({ ownerBuildTimeOnJobs: cents / 100 });
      const lines = pnlLines({ ownerBuildTime: true, margin: true });
      const netted = lines.filter((l) => l.netting).reduce((s, l) => s + (l.cents(f) ?? 0), 0);
      expect(netted, `${cents}`).toBe(0);
      // And the section's total is what it would be with no pair at all.
      const withPair = profitAndLoss(f, { ownerBuildTime: true, margin: true });
      const without = profitAndLoss(f, { margin: true });
      expect(at(withPair, "total_cogs").cents).toBe(at(without, "total_cogs").cents);
      expect(at(withPair, "net_profit").cents).toBe(at(without, "net_profit").cents);
    }
  });

  it("OWNER'S DRAW is below the line, in no total, and never subtracted", () => {
    const f = figures({ ownerDraw: 4000 });
    const rows = profitAndLoss(f, OPTS);
    const draw = at(rows, "owner_draw");
    expect(draw.label).toBe("Owner's Draw");
    expect(draw.cents).toBe(400_000);
    expect(draw.kind).toBe("equity");
    expect(isBelowNetProfit(draw.kind)).toBe(true);
    expect(PNL_SECTION_SHAPE[draw.section!].subtracted).toBe(false);
    // AFTER the bottom line, and the bottom line does not know it exists.
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf("owner_draw")).toBeGreaterThan(keys.indexOf("net_profit"));
    expect(at(rows, "net_profit").cents).toBe(at(profitAndLoss(figures({ ownerDraw: 0 }), OPTS), "net_profit").cents);
    // A draw bigger than the whole profit still subtracts nothing: it is equity, not an expense.
    const huge = profitAndLoss(figures({ ownerDraw: 999_999 }), OPTS);
    expect(at(huge, "net_profit").cents).toBe(at(rows, "net_profit").cents);
    expect(at(huge, "total_overhead").cents).toBe(at(rows, "total_overhead").cents);
  });

  it("the office never sees the owner's build time, its contra, or his draw", () => {
    // profit-and-loss promises an office viewer nothing that is a subtraction away from a bottom line
    // they cannot see. A contra with no total to net it against would break that promise exactly.
    const office = pnlLines({ ...OPTS, showOwner: false }).map((l) => l.key);
    for (const key of ["owner_build_time", "owner_build_time_contra", "owner_draw"]) expect(office, key).not.toContain(key);
  });

  it("the shape is typed: a section says where it sits and whether it is subtracted", () => {
    expect(PNL_SECTIONS).toEqual(["cogs", "overhead", "equity"]);
    expect(PNL_SECTION_SHAPE.equity).toEqual({ where: "below_net_profit", subtracted: false, heading: false, total: false });
    for (const s of ["cogs", "overhead"] as const) expect(PNL_SECTION_SHAPE[s].subtracted, s).toBe(true);
    // And every KIND says how it is weighted, so neither surface can fail open on one it has not heard
    // of: the card used to render an unknown kind as NOTHING and the accountant's Summary as a BOLD
    // TOTAL, and a bold Owner's Draw under Net Profit is the worst outcome available here.
    for (const k of PNL_KINDS) {
      expect(PNL_KIND_SHAPE[k], k).toBeTruthy();
      expect(["heading", "line", "strong"], k).toContain(PNL_KIND_SHAPE[k].weight);
    }
    expect(PNL_KIND_SHAPE.equity.weight).toBe("line"); // NEVER "strong": it must not look like a total
    expect(PNL_KIND_SHAPE.total.weight).toBe("strong");
    // Every kind the layout can emit is one the Record knows.
    const emitted = new Set(pnlLines({ ...OPTS }).map((l) => l.kind));
    for (const k of emitted) expect(PNL_KINDS, k).toContain(k);
  });
});
