import { describe, it, expect } from "vitest";
import {
  OWNER_MONEY_WINDOWS,
  allocateCents,
  chartMonthKeys,
  computeOwnerMoney,
  costFigure,
  countedNotPaidLine,
  getOwnerMoney,
  getOwnerMoneyViews,
  notCountedLine,
  ownerMoneyChartWindow,
  ownerMoneyReadSpan,
  ownerMoneyWindow,
  supplierDocsNoBillCovers,
  parseOwnerMoneyMonthKey,
  resolveOwnerMoneySelection,
  windowInsideSpan,
  windowLabel,
  windowMonths,
  type OwnerMoney,
  type OwnerMoneyFigures,
  type OwnerMoneyInputs,
  type OwnerMoneyPerson,
} from "@/lib/analytics/owner-money";
import { computeRevenueTrend } from "@/lib/analytics/money-metrics";
import { balanceForPerson } from "@/lib/payroll-math";
import { BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";

const TZ = "America/Los_Angeles";
const TODAY = "2026-09-24";
const YEAR = ownerMoneyWindow("this_year", TODAY);

const ERIK = "erik";
const BRIAN = "brian";
const JIMMY = "jimmy";
const people = new Map<string, OwnerMoneyPerson>([
  [ERIK, { name: "Erik Taylor", paidByDraw: true, hourlyRate: 0 }],
  [BRIAN, { name: "Brian Taylor", paidByDraw: false, hourlyRate: 40 }],
  [JIMMY, { name: "Jimmy Santoliva", paidByDraw: false, hourlyRate: 50 }],
]);
const profilesOf = (id: string) => {
  const p = people.get(id)!;
  return { full_name: p.name, hourly_rate: p.hourlyRate, paid_by_draw: p.paidByDraw };
};

/** A closed shift: `hours` long, starting 8 AM Pacific (15:00Z in summer) on `day`. */
const shift = (id: string, pid: string, day: string, hours: number, extra: Record<string, unknown> = {}) => {
  const clock_in = `${day}T15:00:00.000Z`;
  const clock_out = new Date(Date.parse(clock_in) + hours * 3_600_000).toISOString();
  return { id, profile_id: pid, status: "closed", clock_in, clock_out, lunch_minutes: 0, rate_override: null, paid_at: null, profiles: profilesOf(pid), ...extra };
};
const payment = (amount: number, paid_at: string, extra: Record<string, unknown> = {}) => ({
  amount,
  paid_at,
  processor_fee: null,
  stripe_payment_intent: null,
  invoices: { status: "paid" },
  ...extra,
});

const base = (): OwnerMoneyInputs => ({
  payments: [],
  refunds: [],
  bills: [],
  pos: [],
  pettyCash: [],
  entries: [],
  runs: [],
  payPayments: [],
  creditMemos: [],
  people,
  recordsStart: null,
});

const cents = (n: number) => Math.round(n * 100);
const bizTotal = (f: OwnerMoneyFigures) => BUSINESS_COST_BUCKETS.reduce((s, b) => s + cents(f.businessCosts[b]), 0);
/** THE INVARIANT, in cents: received = materials + crew pay + mileage + business costs + left. */
const holds = (f: OwnerMoneyFigures) =>
  cents(f.received) ===
  cents(f.materialsAndBills) + cents(f.crewPay) + cents(f.crewMileagePaid) + cents(f.businessCostsTotal) + cents(f.left);

/** A realistic ET-shaped year, small enough to check by hand. */
const yearInputs = (): OwnerMoneyInputs => ({
  ...base(),
  payments: [
    payment(1350, "2026-09-04T19:00:00Z"), // INV-076, check
    payment(450, "2026-09-04T20:00:00Z"), // INV-075, cash
    payment(3437.5, "2026-08-20T18:00:00Z", { processor_fee: 99.99, stripe_payment_intent: "pi_1" }), // card, fee known
    payment(160, "2026-09-21T18:00:00Z"), // INV-077 voluntary fee check
    payment(500.01, "2026-07-15T18:00:00Z", { stripe_payment_intent: "pi_2" }), // card, fee NOT known yet
    payment(999, "2026-07-02T18:00:00Z", { invoices: { status: "void" } }), // voided: no cash
  ],
  refunds: [{ amount: 100.33, created_at: "2026-08-25T18:00:00Z" }],
  bills: [
    { id: "b1", job_id: "J1", amount: 289.17, bill_date: "2026-08-03", created_at: "2026-08-05T00:00:00Z", category: "Receipt", status: "paid" },
    { id: "b2", job_id: "J1", amount: 95.27, bill_date: "2026-08-03", created_at: "2026-08-05T00:00:00Z", category: "Receipt", status: "paid", superseded_by_bill_id: "b1" },
    { id: "b3", job_id: null, amount: 138.62, bill_date: "2026-07-09", created_at: "2026-07-09T00:00:00Z", category: "Fuel", status: "paid" },
    { id: "b4", job_id: null, amount: 47.44, bill_date: null, created_at: "2026-09-02T02:00:00Z", category: "", status: "unpaid" }, // Sep 1 evening Pacific
    { id: "b5", job_id: "J2", amount: 379.35, bill_date: "2026-06-10", created_at: "2026-09-24T00:00:00Z", category: "Receipt", status: "unpaid", po_id: "po1" },
  ],
  pos: [
    { id: "po1", job_id: "J2", total: 500, status: "sent", ordered_at: "2026-06-09T18:00:00Z", created_at: "2026-06-09T18:00:00Z" }, // 379.35 billed → 120.65 left
    { id: "po2", job_id: "J1", total: 80, status: "cancelled", ordered_at: null, created_at: "2026-08-01T18:00:00Z" }, // cancelled: never a cost (livePurchaseOrders)
  ],
  pettyCash: [
    { job_id: "J1", amount: 54.11, kind: "expense", category: "Materials", tx_date: "2026-08-12", created_at: "2026-08-12T18:00:00Z" },
    { job_id: null, amount: 20, kind: "expense", category: "Tools", tx_date: "2026-08-12", created_at: "2026-08-12T18:00:00Z" },
    { job_id: null, amount: 300, kind: "replenish", category: null, tx_date: "2026-08-12", created_at: "2026-08-12T18:00:00Z" },
  ],
  entries: [
    shift("e1", ERIK, "2026-08-10", 8),
    shift("e2", ERIK, "2026-09-02", 7.5),
    shift("b-jul", BRIAN, "2026-07-20", 8),
    shift("b-aug", BRIAN, "2026-08-11", 6, { rate_override: 45 }),
    shift("j-sep", JIMMY, "2026-09-03", 7),
  ],
  runs: [{ profile_id: BRIAN, kind: "mileage", period_start: "2026-08-03", period_end: "2026-08-17", gross: 0, mileage_amount: 62.5, created_at: "2026-08-20T18:00:00Z" }],
});

describe("computeOwnerMoney: what is left for the owner", () => {
  const m = computeOwnerMoney(yearInputs(), YEAR, TZ, TODAY);

  it("covers Jan through the current month, and the months sum to the total", () => {
    expect(m.months.map((x) => x.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    const fields = ["received", "materialsAndBills", "crewPay", "crewMileagePaid", "businessCostsTotal", "processorFees", "left"] as const;
    for (const f of fields) expect(m.months.reduce((s, x) => s + cents(x[f]), 0)).toBe(cents(m.totals[f]));
    for (const b of BUSINESS_COST_BUCKETS) expect(m.months.reduce((s, x) => s + cents(x.businessCosts[b]), 0)).toBe(cents(m.totals.businessCosts[b]));
    expect(m.months.reduce((s, x) => s + x.ownerHours * 100, 0)).toBe(Math.round(m.totals.ownerHours * 100));
  });

  it("THE INVARIANT holds to the cent, every month and in total", () => {
    for (const x of m.months) {
      expect(holds(x)).toBe(true);
      expect(cents(x.businessCostsTotal)).toBe(bizTotal(x));
    }
    expect(holds(m.totals)).toBe(true);
  });

  it("received is payments net of voided invoices and refunds, by the day received", () => {
    // 1350 + 450 + 3437.50 + 160 + 500.01 - 100.33; the $999 on a voided invoice is not cash.
    expect(m.totals.received).toBe(5797.18);
    expect(m.months.find((x) => x.month === "2026-08")!.received).toBe(3337.17);
  });

  it("materials & bills are the job-cost inputs: live job bills, live POs, job petty cash", () => {
    // 289.17 (b1) + 379.35 (b5, Jun 10 bill date) + 120.65 (po1 remainder) + 54.11 (job petty cash).
    // b2 is superseded (a duplicate) and po2 was cancelled: neither is a cost.
    expect(m.totals.materialsAndBills).toBe(843.28);
    expect(m.months.find((x) => x.month === "2026-06")!.materialsAndBills).toBe(500); // on their own dates
  });

  it("a superseded bill never counts, anywhere", () => {
    const withoutDupe = computeOwnerMoney({ ...yearInputs(), bills: yearInputs().bills.filter((b) => b.id !== "b2") }, YEAR, TZ, TODAY);
    expect(withoutDupe.totals).toEqual(m.totals);
  });

  it("a no-job bill lands in its bucket; blank is Other; petty cash with no job too; a refill is not a cost", () => {
    expect(m.totals.businessCosts["Gas & Truck"]).toBe(138.62); // "Fuel" → Gas & Truck
    expect(m.totals.businessCosts.Other).toBe(47.44);
    expect(m.totals.businessCosts["Tools & Supplies"]).toBe(20);
    expect(m.months.find((x) => x.month === "2026-09")!.businessCosts.Other).toBe(47.44); // created_at read in Pacific
  });

  it("Stripe's real fee lands in Fees; a NULL fee is UNKNOWN, reported, and never $0", () => {
    expect(m.totals.processorFees).toBe(99.99);
    expect(m.totals.businessCosts.Fees).toBe(99.99);
    expect(m.caveats).toContainEqual({ kind: "unknown_fees", count: 1 });
    expect(notCountedLine(m)).toContain("card fees on 1 payment Stripe has not reported yet");
  });

  it("crew pay is what the crew EARNED for the month worked; the owner is never in it", () => {
    // Brian: 8 h x $40 (Jul) + 6 h x $45 override (Aug) = 320 + 270; Jimmy 7 h x $50 (Sep) = 350.
    expect(m.totals.crewPay).toBe(940);
    expect(m.months.find((x) => x.month === "2026-07")!.crewPay).toBe(320);
    expect(m.months.find((x) => x.month === "2026-08")!.crewPay).toBe(270);
  });

  it("mileage stays on its own line: the typed settlement, never inside crew pay", () => {
    expect(m.totals.crewMileagePaid).toBe(62.5);
    expect(m.months.find((x) => x.month === "2026-08")!.crewMileagePaid).toBe(62.5);
    expect(m.totals.crewPay).toBe(940); // unchanged by it
  });

  it("the owner's hours are counted and give the per-hour figure", () => {
    expect(m.totals.ownerHours).toBe(15.5);
    expect(m.totals.perOwnerHour).toBe(Math.round((m.totals.left / 15.5) * 100) / 100);
    expect(m.owners).toEqual([{ id: ERIK, name: "Erik Taylor" }]);
    expect(m.months.find((x) => x.month === "2026-01")!.perOwnerHour).toBeNull();
  });

  it("left, by hand", () => {
    // 5797.18 - 843.28 - 940 - 62.50 - (138.62 + 47.44 + 20 + 99.99) = 3645.35
    expect(m.totals.left).toBe(3645.35);
  });

  it("says what is counted though not paid yet", () => {
    // Brian's $590 and Jimmy's $350 are earned and nothing has been handed over; b4 and b5 are unpaid.
    expect(countedNotPaidLine(m)).toBe("Counted, though not paid yet: $940.00 of crew pay and $426.79 of supplier bills.");
  });
});

describe("received is /analytics' Collected, by construction", () => {
  it("equals computeRevenueTrend's 12-month figure over the same 12 months", () => {
    const inp = yearInputs();
    const trend = computeRevenueTrend(inp.payments, inp.refunds, TODAY, TZ);
    const twelve = { key: "this_year" as const, label: "12 months", start: "2025-10-01", end: "2026-10-01" };
    const m = computeOwnerMoney(inp, twelve, TZ, TODAY);
    expect(m.totals.received).toBe(trend.collected12);
  });

  it("a payment on an invoice with no job still counts", () => {
    const m = computeOwnerMoney({ ...base(), payments: [payment(200, "2026-09-10T18:00:00Z", { invoices: { status: "paid", job_id: null } })] }, YEAR, TZ, TODAY);
    expect(m.totals.received).toBe(200);
  });

  it("a 6 PM Pacific payment on Jun 30 is a June payment", () => {
    const m = computeOwnerMoney({ ...base(), payments: [payment(10, "2026-07-01T01:00:00Z")] }, YEAR, TZ, TODAY);
    expect(m.months.find((x) => x.month === "2026-06")!.received).toBe(10);
  });
});

describe("THE FROZEN-GROSS RULE: a locked period keeps its frozen pay and splits over its months", () => {
  // Brian's real Jun 22 to Jul 6 period: $1,300.00 frozen for 32.5 h at $40. It straddles June and
  // July. Since then he got a raise to $45: the lock must still read $1,300 (forward-only), split
  // by where the hours fell.
  const peopleRaised = new Map(people);
  peopleRaised.set(BRIAN, { name: "Brian Taylor", paidByDraw: false, hourlyRate: 45 });
  const raised = (e: any) => ({ ...e, profiles: { ...e.profiles, hourly_rate: 45 } });
  const locked = [
    raised(shift("l1", BRIAN, "2026-06-24", 8, { paid_at: "2026-07-18T02:00:00Z" })),
    raised(shift("l2", BRIAN, "2026-06-29", 8, { paid_at: "2026-07-18T02:00:00Z" })),
    raised(shift("l3", BRIAN, "2026-07-01", 8.5, { paid_at: "2026-07-18T02:00:00Z" })),
    raised(shift("l4", BRIAN, "2026-07-02", 8, { paid_at: "2026-07-18T02:00:00Z" })),
  ];
  const unlocked = [raised(shift("u1", BRIAN, "2026-07-20", 5))];
  const inputs: OwnerMoneyInputs = {
    ...base(),
    people: peopleRaised,
    entries: [...locked, ...unlocked],
    runs: [{ profile_id: BRIAN, kind: "base", period_start: "2026-06-22", period_end: "2026-07-06", gross: 1300, hours: 32.5, created_at: "2026-07-18T02:00:00Z" }],
  };
  const m = computeOwnerMoney(inputs, YEAR, TZ, TODAY);

  it("June gets the June hours' share of the frozen $1,300, July the rest plus the live hours", () => {
    // 16 of 32.5 hours in June: 1300 x 16/32.5 = 640.00; July 660.00 frozen + 5 h x $45 live.
    expect(m.months.find((x) => x.month === "2026-06")!.crewPay).toBe(640);
    expect(m.months.find((x) => x.month === "2026-07")!.crewPay).toBe(660 + 225);
  });

  it("the months sum to the total, which is the Pay board's Earned for him over that span", () => {
    const board = balanceForPerson({
      profileId: BRIAN,
      name: "Brian Taylor",
      entries: inputs.entries,
      lockedRuns: [{ period_start: "2026-06-22", period_end: "2026-07-06", gross: 1300 }],
      payments: [],
      tz: TZ,
      fallbackRate: 45,
    });
    expect(board.earned).toBe(1525);
    expect(m.totals.crewPay).toBe(board.earned);
    expect(m.months.reduce((s, x) => s + cents(x.crewPay), 0)).toBe(cents(board.earned));
  });

  it("an awkward split still adds to the frozen cent: $1,000.01 over three months", () => {
    const three: OwnerMoneyInputs = {
      ...base(),
      entries: [
        shift("a", BRIAN, "2026-03-30", 1, { paid_at: "x" }),
        shift("b", BRIAN, "2026-04-15", 1, { paid_at: "x" }),
        shift("c", BRIAN, "2026-05-02", 1, { paid_at: "x" }),
      ],
      runs: [{ profile_id: BRIAN, kind: "base", period_start: "2026-03-30", period_end: "2026-05-04", gross: 1000.01, created_at: "2026-05-05T00:00:00Z" }],
    };
    const out = computeOwnerMoney(three, YEAR, TZ, TODAY);
    expect(out.totals.crewPay).toBe(1000.01);
    expect(out.months.filter((x) => x.crewPay > 0).map((x) => x.crewPay).sort()).toEqual([333.33, 333.34, 333.34].sort());
  });

  it("a locked period with none of its shifts in view lands whole in the month it starts", () => {
    const out = computeOwnerMoney(
      { ...base(), runs: [{ profile_id: BRIAN, kind: "base", period_start: "2026-06-08", period_end: "2026-06-22", gross: 1360, created_at: "2026-07-04T05:27:27Z" }] },
      YEAR,
      TZ,
      TODAY,
    );
    expect(out.months.find((x) => x.month === "2026-06")!.crewPay).toBe(1360);
  });

  it("an owner's old run and shifts are never crew pay", () => {
    const out = computeOwnerMoney(
      {
        ...base(),
        entries: [shift("o", ERIK, "2026-06-10", 8, { paid_at: "x" })],
        runs: [{ profile_id: ERIK, kind: "base", period_start: "2026-06-08", period_end: "2026-06-22", gross: 1000, created_at: "2026-06-23T00:00:00Z" }],
      },
      YEAR,
      TZ,
      TODAY,
    );
    expect(out.totals.crewPay).toBe(0);
    expect(out.totals.ownerHours).toBe(8);
  });
});

describe("caveats: each only when it applies", () => {
  it("nothing at all says nothing", () => {
    const m = computeOwnerMoney(base(), YEAR, TZ, TODAY);
    expect(m.caveats).toEqual([]);
    expect(notCountedLine(m)).toBeNull();
    expect(countedNotPaidLine(m)).toBeNull();
    expect(windowLabel(m)).toBe("This Year");
  });

  it("credit memos are named with their total, never subtracted", () => {
    const withMemo = computeOwnerMoney({ ...yearInputs(), creditMemos: [{ total: -115.33, invoice_date: "2026-09-22" }, { total: 82.1, invoice_date: "2026-09-22" }] }, YEAR, TZ, TODAY);
    const without = computeOwnerMoney(yearInputs(), YEAR, TZ, TODAY);
    expect(withMemo.caveats).toContainEqual({ kind: "credit_memos", count: 2, total: 197.43 });
    expect(withMemo.totals.left).toBe(without.totals.left);
    expect(notCountedLine(withMemo)).toContain("$197.43 of supplier credit memos (2)");
  });

  it("a credit memo a bill covers is counted in materials once, never also named as not counted", () => {
    // The 518 Crater Lake shape: each CED memo is a negative bill on J-046, tied to its memo.
    const docs = supplierDocsNoBillCovers([
      { id: "m1", kind: "credit_memo", total: -115.33, invoice_date: "2026-09-22", bill_supplier_invoices: [{ id: "t1" }] },
      { id: "m2", kind: "credit_memo", total: -82.1, invoice_date: "2026-09-22", bill_supplier_invoices: [{ id: "t2" }] },
      { id: "m3", kind: "credit_memo", total: -10, invoice_date: "2026-09-22", bill_supplier_invoices: [] },
      { id: "s1", kind: "service_charge", total: 20.14, invoice_date: "2026-08-10", bill_supplier_invoices: [{ id: "t3" }] },
      { id: "s2", kind: "service_charge", total: 5, invoice_date: "2026-08-10" },
    ]);
    expect(docs.creditMemos.map((d) => d.id)).toEqual(["m3"]);
    expect(docs.unbilledServiceCharges.map((d) => d.id)).toEqual(["s2"]);

    const memoBills = [
      { id: "cm1", job_id: "J-046", amount: -115.33, bill_date: "2026-09-22", created_at: "2026-09-22T18:00:00Z", category: "Invoice", status: "unpaid" },
      { id: "cm2", job_id: "J-046", amount: -82.1, bill_date: "2026-09-22", created_at: "2026-09-22T18:00:00Z", category: "Invoice", status: "unpaid" },
    ];
    const without = computeOwnerMoney(yearInputs(), YEAR, TZ, TODAY);
    const covered = computeOwnerMoney(
      { ...yearInputs(), bills: [...yearInputs().bills, ...memoBills], creditMemos: supplierDocsNoBillCovers([
        { id: "m1", kind: "credit_memo", total: -115.33, invoice_date: "2026-09-22", bill_supplier_invoices: [{ id: "t1" }] },
        { id: "m2", kind: "credit_memo", total: -82.1, invoice_date: "2026-09-22", bill_supplier_invoices: [{ id: "t2" }] },
      ]).creditMemos },
      YEAR, TZ, TODAY,
    );
    expect(covered.totals.materialsAndBills).toBe(Math.round((without.totals.materialsAndBills - 197.43) * 100) / 100);
    expect(covered.caveats.find((c) => c.kind === "credit_memos")).toBeUndefined();
    expect(notCountedLine(covered) ?? "").not.toContain("credit memo");
  });

  it("a supplier late charge no bill covers is named, never guessed into a bucket", () => {
    const m = computeOwnerMoney({ ...base(), unbilledServiceCharges: [{ total: 20.14, invoice_date: "2026-08-10" }, { total: 40.28, invoice_date: "2025-12-10" }] }, YEAR, TZ, TODAY);
    expect(m.caveats).toContainEqual({ kind: "service_charges", count: 1, total: 20.14 });
    expect(m.totals.businessCosts.Fees).toBe(0);
    expect(notCountedLine(m)).toBe("Not counted: $20.14 of supplier late charges not filed as bills (1).");
  });

  it("a running shift is said, and its hours are not counted", () => {
    const open = { ...shift("open", BRIAN, "2026-09-24", 1), clock_out: null, status: "open" };
    const m = computeOwnerMoney({ ...base(), entries: [open] }, YEAR, TZ, TODAY);
    expect(m.caveats).toContainEqual({ kind: "open_shifts", count: 1 });
    expect(m.totals.crewPay).toBe(0);
  });

  it("records that start after Jan 1 are named in the window label", () => {
    const m = computeOwnerMoney({ ...base(), recordsStart: "2026-06-11" }, YEAR, TZ, TODAY);
    expect(windowLabel(m)).toBe("This Year (records start Jun 11)");
  });

  it("crew owed is the Pay board's figure: earned minus what was handed over", () => {
    const m = computeOwnerMoney(
      { ...base(), entries: [shift("x", BRIAN, "2026-09-01", 10)], payPayments: [{ id: "p", profile_id: BRIAN, amount: 150, paid_on: "2026-09-05", method: "cash" }] },
      YEAR,
      TZ,
      TODAY,
    );
    expect(m.caveats).toContainEqual({ kind: "crew_owed", total: 250 });
    expect(m.totals.crewPay).toBe(400); // counted in full either way
  });
});

describe("crew owed names only THIS window's unpaid crew pay", () => {
  // Brian at $40: 10 unpaid hours in August, 50 in September, nothing handed over yet.
  const sept = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"].map((d, i) => shift(`s${i}`, BRIAN, d, 10));
  const hours = (): OwnerMoneyInputs => ({ ...base(), entries: [shift("a1", BRIAN, "2026-08-12", 10), ...sept] });
  const owed = (m: OwnerMoney) => (m.caveats.find((c) => c.kind === "crew_owed") as { total: number } | undefined)?.total ?? null;
  const run = (inp: OwnerMoneyInputs, key: "this_month" | "last_month" | "this_year", today = TODAY) =>
    computeOwnerMoney(inp, ownerMoneyWindow(key, today), TZ, today);

  it("each window names exactly the crew pay it counted", () => {
    const last = run(hours(), "last_month");
    expect([last.totals.crewPay, owed(last)]).toEqual([400, 400]);
    const month = run(hours(), "this_month");
    expect([month.totals.crewPay, owed(month)]).toEqual([2000, 2000]);
    const year = run(hours(), "this_year");
    expect([year.totals.crewPay, owed(year)]).toEqual([2400, 2400]);
    expect(countedNotPaidLine(last)).toBe("Counted, though not paid yet: $400.00 of crew pay.");
  });

  it("a This Year read in January names none of last year's unpaid pay", () => {
    const m = run(hours(), "this_year", "2027-01-15");
    expect(m.totals.crewPay).toBe(0);
    expect(owed(m)).toBeNull();
    expect(countedNotPaidLine(m)).toBeNull();
  });

  it("a payment pays the OLDEST earnings first, so the newest window keeps the unpaid dollars", () => {
    // $2,400 earned, $500 paid: August's $400 is paid in full and $100 of September's, so $1,900 of
    // September is still owed and none of August. Oldest-first is the Pay board's own order: a
    // payment locks the oldest periods first, and "going back to" names the oldest unpaid day.
    const paid = { ...hours(), payPayments: [{ id: "p1", profile_id: BRIAN, amount: 500, paid_on: "2026-09-20", method: "cash" }] };
    expect(owed(run(paid, "this_month"))).toBe(1900);
    expect(owed(run(paid, "last_month"))).toBeNull();
    expect(owed(run(paid, "this_year"))).toBe(1900);
  });
});

describe("the windows agree with each other", () => {
  it("This Year's totals are the field-by-field sum of each month run on its own", () => {
    const year = computeOwnerMoney(yearInputs(), YEAR, TZ, TODAY);
    const monthly = year.months.map((x) => computeOwnerMoney(yearInputs(), ownerMoneyWindow("this_month", `${x.month}-15`), TZ, TODAY));
    const fields = ["received", "materialsAndBills", "crewPay", "crewMileagePaid", "businessCostsTotal", "processorFees", "left"] as const;
    for (const f of fields) expect(monthly.reduce((s, m) => s + cents(m.totals[f]), 0)).toBe(cents(year.totals[f]));
    for (const b of BUSINESS_COST_BUCKETS) {
      expect(monthly.reduce((s, m) => s + cents(m.totals.businessCosts[b]), 0)).toBe(cents(year.totals.businessCosts[b]));
    }
    expect(monthly.reduce((s, m) => s + Math.round(m.totals.ownerHours * 100), 0)).toBe(Math.round(year.totals.ownerHours * 100));
    // And each month's own run matches that month's row in the year.
    monthly.forEach((m, i) => expect(m.totals.left).toBe(year.months[i].left));
  });
});

describe("costFigure: a cost line on the receipt", () => {
  it("money out reads with a minus; a net credit is money back, never a double sign", () => {
    expect(costFigure(1200)).toBe("\u2212$1,200.00");
    expect(costFigure(0)).toBe("$0.00");
    expect(costFigure(0.001)).toBe("$0.00");
    expect(costFigure(-51.58)).toBe("+$51.58");
  });

  it("a window whose only bill is a credit reads as money back", () => {
    const m = computeOwnerMoney(
      { ...base(), bills: [{ id: "cr", job_id: "J-011", amount: -51.58, bill_date: "2026-09-10", created_at: "2026-09-10T18:00:00Z", category: "Receipt", status: "paid" }] },
      ownerMoneyWindow("this_month", TODAY),
      TZ,
      TODAY,
    );
    expect(m.totals.materialsAndBills).toBe(-51.58);
    expect(costFigure(m.totals.materialsAndBills)).toBe("+$51.58");
    expect(m.totals.left).toBe(51.58);
  });
});

// ── THE FETCH HALF ─────────────────────────────────────────────────────────────

type FakeCall = { table: string; select: string; filters: string[]; bounds?: Record<string, string> };

/** A small PostgREST-builder fake that APPLIES the filters it is given (is/eq/gte/lt/in, order,
 *  range, limit) to canned rows per table, so the test pins what getOwnerMoney asks for as well as
 *  what it does with the answer. A table listed in `failing` answers with an error. */
function fakeClient(tables: Record<string, any[]>, calls: FakeCall[], failing: string[] = []) {
  return {
    from(table: string) {
      const call: FakeCall = { table, select: "", filters: [] };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      let slice: [number, number] | null = null;
      let limit: number | null = null;
      const b: any = {
        select(cols: string) { call.select = cols; return b; },
        is(col: string, v: unknown) { call.filters.push(`is:${col}:${v}`); rows = rows.filter((r) => (r[col] ?? null) === v); return b; },
        eq(col: string, v: unknown) { call.filters.push(`eq:${col}:${v}`); rows = rows.filter((r) => r[col] === v); return b; },
        gte(col: string, v: string) { call.filters.push(`gte:${col}`); (call.bounds ??= {})[`gte:${col}`] = v; rows = rows.filter((r) => String(r[col]) >= v); return b; },
        lt(col: string, v: string) { call.filters.push(`lt:${col}`); (call.bounds ??= {})[`lt:${col}`] = v; rows = rows.filter((r) => String(r[col]) < v); return b; },
        in(col: string, vs: unknown[]) { call.filters.push(`in:${col}`); rows = rows.filter((r) => vs.includes(r[col])); return b; },
        order(col: string, opts?: { ascending?: boolean }) {
          const dir = opts?.ascending === false ? -1 : 1;
          rows.sort((x, y) => (String(x[col]) < String(y[col]) ? -dir : String(x[col]) > String(y[col]) ? dir : 0));
          return b;
        },
        range(f: number, t: number) { slice = [f, t]; return b; },
        limit(n: number) { limit = n; return b; },
        then(ok: (v: any) => any, err?: (e: any) => any) {
          if (failing.includes(table)) return Promise.resolve({ data: null, error: { message: "boom" } }).then(ok, err);
          let out = rows;
          if (slice) out = out.slice(slice[0], slice[1] + 1);
          if (limit != null) out = out.slice(0, limit);
          return Promise.resolve({ data: out, error: null }).then(ok, err);
        },
      };
      return b;
    },
  };
}

describe("getOwnerMoney: the fetch half", () => {
  const NOW = new Date("2026-09-24T19:00:00Z");
  const tables = () => ({
    payments: [
      { id: "p1", amount: 1000, paid_at: "2026-06-11T18:00:00Z", processor_fee: null, stripe_payment_intent: null, invoices: { status: "paid" } },
      { id: "p2", amount: 450, paid_at: "2026-09-04T20:00:00Z", processor_fee: 13.35, stripe_payment_intent: "pi_x", invoices: { status: "paid" } },
    ],
    customer_credits: [],
    bills: [
      { id: "b1", job_id: "J1", amount: 200, bill_date: "2026-08-03", created_at: "2026-08-05T00:00:00Z", category: "Receipt", status: "paid", po_id: null, superseded_by_bill_id: null },
      { id: "b2", job_id: "J1", amount: 999, bill_date: "2026-08-03", created_at: "2026-08-05T00:00:00Z", category: "Receipt", status: "paid", po_id: null, superseded_by_bill_id: "b1" },
      // Entered after the fact with an old date: counts in April, never moves where records start.
      { id: "b3", job_id: null, amount: 30, bill_date: "2026-04-20", created_at: "2026-06-10T00:00:00Z", category: "Fuel", status: "paid", po_id: null, superseded_by_bill_id: null },
    ],
    purchase_orders: [],
    petty_cash: [],
    time_entries: [
      { id: "t1", profile_id: BRIAN, status: "closed", clock_in: "2026-06-15T15:00:00.000Z", clock_out: "2026-06-15T23:00:00.000Z", lunch_minutes: 0, rate_override: null, paid_at: null, profiles: { full_name: "Brian Taylor" } },
      { id: "t2", profile_id: ERIK, status: "closed", clock_in: "2026-06-12T15:00:00.000Z", clock_out: "2026-06-12T20:00:00.000Z", lunch_minutes: 0, rate_override: null, paid_at: null, profiles: { full_name: "Erik Taylor" } },
    ],
    payroll_runs: [],
    pay_payments: [],
    supplier_invoices: [],
    profile_pay: [
      { id: ERIK, full_name: "Erik Taylor", hourly_rate: 0, bill_rate: 125, commute_baseline_miles: null, paid_by_draw: true },
      { id: BRIAN, full_name: "Brian Taylor", hourly_rate: 40, bill_rate: 85, commute_baseline_miles: null, paid_by_draw: false },
    ],
  });

  it("asks only for live bills, attaches rates to each shift, and computes", async () => {
    const calls: FakeCall[] = [];
    const t = tables();
    const { money, problem } = await getOwnerMoney(fakeClient(t, calls), "this_year", TZ, NOW);
    expect(problem).toBeNull();
    expect(calls.find((c) => c.table === "bills")!.filters).toContain("is:superseded_by_bill_id:null");
    expect(calls.some((c) => c.table === "organizations")).toBe(false); // tz comes from the caller
    // The rates were merged onto the shift the way the Pay board merges them.
    expect(t.time_entries[0].profiles).toMatchObject({ full_name: "Brian Taylor", hourly_rate: 40, paid_by_draw: false });
    expect(t.time_entries[1].profiles).toMatchObject({ paid_by_draw: true });
    expect(money!.totals.received).toBe(1450);
    expect(money!.totals.materialsAndBills).toBe(200); // b2 is superseded: never requested, never counted
    expect(money!.totals.crewPay).toBe(320);
    expect(money!.totals.ownerHours).toBe(5);
    expect(money!.totals.businessCosts.Fees).toBe(13.35);
    expect(money!.totals.businessCosts["Gas & Truck"]).toBe(30);
    expect(money!.owners).toEqual([{ id: ERIK, name: "Erik Taylor" }]);
  });

  it("records start at the earlier of the first payment and the first shift", async () => {
    const { money } = await getOwnerMoney(fakeClient(tables(), []), "this_year", TZ, NOW);
    expect(windowLabel(money!)).toBe("This Year (records start Jun 11)");
    const t = tables();
    t.time_entries[1].clock_in = "2026-06-09T15:00:00.000Z";
    t.time_entries[1].clock_out = "2026-06-09T20:00:00.000Z";
    const earlier = await getOwnerMoney(fakeClient(t, []), "this_year", TZ, NOW);
    expect(windowLabel(earlier.money!)).toBe("This Year (records start Jun 9)");
  });

  it("a read that fails returns no figure and says which read", async () => {
    const out = await getOwnerMoney(fakeClient(tables(), [], ["petty_cash"]), "this_year", TZ, NOW);
    expect(out.money).toBeNull();
    expect(out.problem).toBe("the petty cash could not be read");
    const rates = await getOwnerMoney(fakeClient(tables(), [], ["profile_pay"]), "this_year", TZ, NOW);
    expect(rates.money).toBeNull();
    expect(rates.problem).toBe("the pay rates could not be read");
  });

  it("ONE READ: the chart's 12 months and the card's window come from one read over the span of both", async () => {
    const single: FakeCall[] = [];
    await getOwnerMoney(fakeClient(tables(), single), "this_year", TZ, NOW);
    const both: FakeCall[] = [];
    const chart = ownerMoneyChartWindow(TODAY);
    const aug = ownerMoneyWindow("2026-08", TODAY);
    const { views, problem, firstPaymentDay } = await getOwnerMoneyViews(fakeClient(tables(), both), [chart, aug], TZ, TODAY);
    expect(problem).toBeNull();
    // The first payment ever, from the same read: the chart's empty state tells "nothing yet" from "nothing lately".
    expect(firstPaymentDay).toBe("2026-06-11");
    // Exactly as many requests as ONE window's read, table for table: nothing is fetched twice.
    const count = (calls: FakeCall[]) => calls.reduce<Record<string, number>>((o, c) => ({ ...o, [c.table]: (o[c.table] ?? 0) + 1 }), {});
    expect(count(both)).toEqual(count(single));
    // The payments read covers the chart's whole span (Oct 1 2025 to Oct 1 2026, Pacific).
    const pay = both.find((c) => c.table === "payments" && c.bounds?.["gte:paid_at"])!;
    expect(pay.bounds).toEqual({ "gte:paid_at": "2025-10-01T07:00:00.000Z", "lt:paid_at": "2026-10-01T07:00:00.000Z" });
    // And the card's August IS the chart's August.
    const [c, a] = views!;
    expect(a.totals).toEqual(stripMonth(c.months.find((x) => x.month === "2026-08")!));
    expect(c.months.map((x) => x.month)).toEqual(chartMonthKeys(TODAY));
    expect(c.totals.received).toBe(1450);
  });
});

const stripMonth = ({ month: _month, ...rest }: { month: string } & OwnerMoneyFigures) => rest;

describe("month windows (a month tapped on the chart)", () => {
  it("accepts a real month inside the chart's 12, and nothing else", () => {
    expect(parseOwnerMoneyMonthKey("2026-08", TODAY)).toBe("2026-08");
    expect(parseOwnerMoneyMonthKey("2026-09", TODAY)).toBe("2026-09");
    expect(parseOwnerMoneyMonthKey("2025-10", TODAY)).toBe("2025-10"); // the oldest of the 12
    expect(parseOwnerMoneyMonthKey("2025-09", TODAY)).toBeNull(); // 13 months back: never read
    expect(parseOwnerMoneyMonthKey("2026-10", TODAY)).toBeNull(); // the future
    for (const junk of ["2026-13", "2026-00", "2026-8", "Aug", "2026-08-01", "", null, undefined, 202608, ["2026-08"]]) {
      expect(parseOwnerMoneyMonthKey(junk, TODAY)).toBeNull();
    }
  });

  it("the selection: a segment, a month remembering its segment, or This Year", () => {
    expect(resolveOwnerMoneySelection("this_month", undefined, TODAY)).toEqual({ windowKey: "this_month", segment: "this_month", month: null });
    expect(resolveOwnerMoneySelection("2026-08", "last_month", TODAY)).toEqual({ windowKey: "2026-08", segment: "last_month", month: "2026-08" });
    expect(resolveOwnerMoneySelection("2026-08", "bogus", TODAY)).toEqual({ windowKey: "2026-08", segment: "this_year", month: "2026-08" });
    expect(resolveOwnerMoneySelection("2019-03", "this_month", TODAY)).toEqual({ windowKey: "this_month", segment: "this_month", month: null });
    expect(resolveOwnerMoneySelection("<script>", undefined, TODAY)).toEqual({ windowKey: "this_year", segment: "this_year", month: null });
    expect(resolveOwnerMoneySelection(undefined, undefined, TODAY).windowKey).toBe("this_year");
  });

  it("a month window is that calendar month, named in full", () => {
    expect(ownerMoneyWindow("2026-08", TODAY)).toEqual({ key: "2026-08", label: "August 2026", start: "2026-08-01", end: "2026-09-01" });
    expect(ownerMoneyWindow("2025-12", TODAY)).toMatchObject({ label: "December 2025", start: "2025-12-01", end: "2026-01-01" });
    const m = computeOwnerMoney(yearInputs(), ownerMoneyWindow("2026-08", TODAY), TZ, TODAY);
    expect(windowLabel(m)).toBe("August 2026");
  });

  it("the card's month equals the chart's month, field for field, for the same inputs", () => {
    const chart = computeOwnerMoney(yearInputs(), ownerMoneyChartWindow(TODAY), TZ, TODAY);
    for (const row of chart.months) {
      const card = computeOwnerMoney(yearInputs(), ownerMoneyWindow(row.month as `${number}-${number}`, TODAY), TZ, TODAY);
      expect(card.totals).toEqual(stripMonth(row));
    }
  });

  it("every window the card can show lies inside the chart's span, every month of the year (January too)", () => {
    for (let mo = 1; mo <= 12; mo++) {
      for (const day of ["01", "15", "28"]) {
        const today = `2027-${String(mo).padStart(2, "0")}-${day}`;
        const chart = ownerMoneyChartWindow(today);
        const keys = [...OWNER_MONEY_WINDOWS.map((w) => w.key), ...chartMonthKeys(today)];
        for (const k of keys) {
          const win = ownerMoneyWindow(k, today);
          const span = ownerMoneyReadSpan([chart, win]);
          expect(windowInsideSpan(win, span)).toBe(true);
          expect(windowInsideSpan(chart, span)).toBe(true);
          // Never further back than the chart's 12 months: the card never makes the page read older
          // rows. (This Year's end is next Jan 1, past today; months past today are never counted.)
          expect(span.start).toBe(chart.start);
        }
      }
    }
    // January: last month is December of the year before, still inside the 12.
    const jan = "2027-01-10";
    expect(windowInsideSpan(ownerMoneyWindow("last_month", jan), ownerMoneyChartWindow(jan))).toBe(true);
    expect(ownerMoneyChartWindow(jan)).toMatchObject({ start: "2026-02-01", end: "2027-02-01" });
  });

  it("a window outside the span is refused, never computed from partial rows", () => {
    expect(windowInsideSpan({ start: "2025-01-01", end: "2025-02-01" }, ownerMoneyChartWindow(TODAY))).toBe(false);
    expect(() => ownerMoneyReadSpan([])).toThrow();
  });
});

describe("windows", () => {
  it("this month, last month, this year in org days", () => {
    expect(ownerMoneyWindow("this_month", TODAY)).toMatchObject({ start: "2026-09-01", end: "2026-10-01" });
    expect(ownerMoneyWindow("last_month", TODAY)).toMatchObject({ start: "2026-08-01", end: "2026-09-01" });
    expect(ownerMoneyWindow("last_month", "2026-01-15")).toMatchObject({ start: "2025-12-01", end: "2026-01-01" });
    expect(ownerMoneyWindow("this_year", TODAY)).toMatchObject({ start: "2026-01-01", end: "2027-01-01" });
  });
  it("months never run past the current month", () => {
    expect(windowMonths(ownerMoneyWindow("this_year", "2026-03-02"), "2026-03-02")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
  it("last month only counts last month's money", () => {
    const m: OwnerMoney = computeOwnerMoney(yearInputs(), ownerMoneyWindow("last_month", TODAY), TZ, TODAY);
    expect(m.months.map((x) => x.month)).toEqual(["2026-08"]);
    expect(m.totals.received).toBe(3337.17);
    expect(holds(m.totals)).toBe(true);
  });
});

describe("allocateCents", () => {
  it("always sums exactly, whatever the weights", () => {
    for (const total of [1, 99, 100001, 133333, -500]) {
      const out = allocateCents(total, new Map([["a", 1], ["b", 1], ["c", 1]]));
      expect([...out.values()].reduce((s, v) => s + v, 0)).toBe(total);
    }
  });
  it("no positive weight: nothing allocated (the caller decides)", () => {
    expect(allocateCents(500, new Map([["a", 0]])).size).toBe(0);
  });
});
