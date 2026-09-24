import { describe, it, expect } from "vitest";
import {
  allocateCents,
  computeOwnerMoney,
  countedNotPaidLine,
  notCountedLine,
  ownerMoneyWindow,
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
