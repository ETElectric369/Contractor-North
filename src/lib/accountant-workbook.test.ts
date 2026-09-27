import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  NET_LABEL,
  OWNER_HIDDEN_NOTE,
  STOCK_BOUGHT_LABEL,
  STOCK_LOST_LABEL,
  TAB_NAMES,
  accountantFileName,
  accountantReadSpan,
  beforeRecordsLine,
  buildAccountantWorkbook,
  comparisonThrough,
  defaultAccountantPeriod,
  fileSafeName,
  lastDayShown,
  parseAccountantPeriod,
  periodChoices,
  periodFromKey,
  periodWindow,
  previousPeriod,
  summaryLines,
  tabCsv,
  workbookCsvZip,
  workbookXlsx,
  type AccountantWorkbook,
  type AccountantWorkbookInput,
} from "./accountant-workbook";
import { computeOwnerMoney, type OwnerMoneyFigures, type OwnerMoneyInputs, type OwnerMoneyPerson } from "@/lib/analytics/owner-money";
import { BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";
import type { AccountantInputs } from "@/lib/accountant-lists";
import { contentDisposition, fileNameFromDisposition } from "@/lib/download-name";
import type { XlsxSheet, XlsxValue } from "@/lib/xlsx-write";
import { unzip, text } from "@/test/unzip";

/**
 * THE ACCOUNTANT'S WORKBOOK ON A MADE-UP COMPANY (every name and number here is invented; the repo is
 * public). Pinecrest Electric Co, in Chicago's clock, over 2026 Q2 with Q1 before it: payments by
 * check, card (with a card fee) and Zelle, one on a voided invoice, a refund, a bank deposit filed
 * as Other Income; a job ticket with a roll put into stock, Fuel, Auto, a stored "Gas & Truck", a
 * Tools & Supplies ticket, a tool billed to a customer, petty cash, a purchase order, a write-off;
 * an owner with hours and miles, a 1099 crew member with a locked pay period, miles and a typed
 * mileage settlement, and a second crew member; an open invoice and an open supplier balance.
 */
const TZ = "America/Chicago";
const TODAY = "2026-09-27";
const OWNER = "p-owner";
const SAM = "p-sam";
const LEE = "p-lee";

const people = new Map<string, OwnerMoneyPerson>([
  [OWNER, { name: "Dana Pinecrest", paidByDraw: true, hourlyRate: 0, commuteBaselineMiles: 0 }],
  [SAM, { name: "Sam Rivera", paidByDraw: false, hourlyRate: 40, commuteBaselineMiles: 10 }],
  [LEE, { name: "Lee Okafor", paidByDraw: false, hourlyRate: 30, commuteBaselineMiles: null }],
]);
const profilesOf = (id: string) => {
  const p = people.get(id)!;
  return { full_name: p.name, hourly_rate: p.hourlyRate, paid_by_draw: p.paidByDraw, commute_baseline_miles: p.commuteBaselineMiles };
};
/** A closed shift `hours` long from 10 AM Chicago (15:00Z in summer) on `day`. */
const shift = (id: string, pid: string, day: string, hours: number, extra: Record<string, unknown> = {}) => {
  const clock_in = `${day}T15:00:00.000Z`;
  return { id, profile_id: pid, status: "closed", clock_in, clock_out: new Date(Date.parse(clock_in) + hours * 3_600_000).toISOString(), lunch_minutes: 0, rate_override: null, paid_at: null, miles: null, split_from: null, profiles: profilesOf(pid), ...extra };
};
const inv = (n: string, customer_id: string | null, name: string | null, job_id: string | null, status = "paid") => ({ status, invoice_number: n, customer_id, job_id, customers: name ? { name } : null });
const pay = (id: string, amount: number, paid_at: string, method: string, invoices: any, extra: Record<string, unknown> = {}) => ({
  id,
  amount,
  paid_at,
  processor_fee: null,
  stripe_payment_intent: null,
  method,
  invoices,
  ...extra,
});
const bill = (id: string, job_id: string | null, amount: number, bill_date: string, category: string, supplier: string, extra: Record<string, unknown> = {}) => ({
  id,
  job_id,
  amount,
  bill_date,
  created_at: `${bill_date}T20:00:00Z`,
  category,
  status: "paid",
  po_id: null,
  superseded_by_bill_id: null,
  supplier_account_id: null,
  supplier,
  bill_number: null,
  on_shelf: false,
  ...extra,
});

/** The formula-shaped name a customer typed: text in the xlsx, defused in the CSV. */
const SNEAKY = "=cmd|' /C calc'!A0";

const money = (): OwnerMoneyInputs => ({
  payments: [
    pay("p1", 1000, "2026-04-10T17:00:00Z", "check", inv("INV-101", "cu-acme", "Acme Homes", "j1")),
    pay("p2", 2500, "2026-05-15T17:00:00Z", "card", inv("INV-102", "cu-birch", "Birch Street LLC", "j2"), { processor_fee: 72.8, stripe_payment_intent: "pi_a" }),
    pay("p3", 400, "2026-06-03T17:00:00Z", "zelle", inv("INV-103", "cu-acme", "Acme Homes", null)),
    pay("p4", 300, "2026-06-20T17:00:00Z", "cash", inv("INV-104", "cu-birch", "Birch Street LLC", "j2", "void")),
    pay("p5", 200, "2026-06-25T17:00:00Z", "card", inv("INV-105", "cu-sneaky", SNEAKY, "j1"), { stripe_payment_intent: "pi_b" }),
    // Q1, the period before.
    pay("p0", 800, "2026-02-10T17:00:00Z", "check", inv("INV-100", "cu-acme", "Acme Homes", "j1")),
  ],
  refunds: [{ id: "r1", amount: 50, created_at: "2026-06-28T17:00:00Z", invoices: { invoice_number: "INV-102", job_id: "j2", customers: { name: "Birch Street LLC" } } }],
  otherIncome: [{ id: "bl1", amount: 120, posted_on: "2026-05-02" }],
  bills: [
    bill("b1", "j1", 600, "2026-04-12", "Receipt", "Northline Supply", { status: "unpaid", supplier_account_id: "a1", bill_number: "NS-100" }),
    bill("b2", null, 85.5, "2026-04-20", "Fuel", "Corner Gas"),
    bill("b3", null, 240, "2026-05-08", "Auto", "Tire Barn"),
    bill("b4", null, 129.99, "2026-05-20", "Tools & Supplies", "Northline Supply", { bill_number: "NS-114" }),
    bill("b5", "j2", 1200, "2026-06-02", "Receipt", "Northline Supply", { status: "unpaid", supplier_account_id: "a1", bill_number: "NS-120" }),
    bill("b6", null, 60, "2026-06-11", "Gas & Truck", "Quick Lube"),
    bill("b9", null, 300, "2026-06-30", "Insurance & Licenses", "Lakeside Insurance"),
    bill("b7", null, 40, "2026-03-03", "Fuel", "Corner Gas"),
    bill("b8", "j1", 999, "2026-04-12", "Receipt", "Northline Supply", { superseded_by_bill_id: "b1" }),
  ],
  pos: [{ id: "po1", job_id: "j2", total: 90, status: "sent", ordered_at: "2026-06-05T15:00:00Z", created_at: "2026-06-05T15:00:00Z" }],
  pettyCash: [
    { id: "pc1", job_id: "j1", amount: 35, kind: "expense", category: null, tx_date: "2026-04-15", created_at: "2026-04-15T15:00:00Z" },
    { id: "pc2", job_id: null, amount: 45, kind: "expense", category: "Phone & Office", tx_date: "2026-05-01", created_at: "2026-05-01T15:00:00Z" },
    { id: "pc3", job_id: null, amount: 200, kind: "replenish", category: null, tx_date: "2026-05-02", created_at: "2026-05-02T15:00:00Z" },
  ],
  entries: [
    shift("e-o1", OWNER, "2026-04-07", 9, { miles: 40 }),
    shift("e-o2", OWNER, "2026-05-20", 7),
    shift("e-s0", SAM, "2026-02-03", 4),
    shift("e-s1", SAM, "2026-04-06", 8, { paid_at: "2026-04-16T00:00:00Z" }),
    shift("e-s2", SAM, "2026-06-08", 8, { miles: 30 }),
    shift("e-s3", SAM, "2026-06-09", 6, { miles: 25 }),
    shift("e-l1", LEE, "2026-05-12", 5),
  ],
  runs: [
    { id: "run1", profile_id: SAM, kind: "base", period_start: "2026-04-01", period_end: "2026-04-15", gross: 320, mileage_amount: 0, created_at: "2026-04-16T00:00:00Z" },
    { id: "run2", profile_id: SAM, kind: "mileage", period_start: "2026-06-01", period_end: "2026-06-30", gross: 0, mileage_amount: 38, created_at: "2026-06-30T18:00:00Z" },
  ],
  payPayments: [
    { id: "pp1", profile_id: SAM, amount: 320, paid_on: "2026-04-20", method: "check", voided_at: null },
    { id: "pp2", profile_id: SAM, amount: 200, paid_on: "2026-06-25", method: "transfer", voided_at: null },
    { id: "pp3", profile_id: SAM, amount: 999, paid_on: "2026-06-26", method: "cash", voided_at: "2026-06-27T00:00:00Z" },
  ],
  creditMemos: [],
  people,
  recordsStart: "2026-02-03",
  shelfLots: [{ lot_id: "L1", bill_id: "b1", cost: 150, cost_left: 100, live: true }],
  shelfMoves: [{ id: "m1", lot_id: "L1", kind: "write_off", cost: 20, created_at: "2026-06-10T15:00:00Z", undone_at: null }],
  supplierAccounts: [{ id: "a1", name: "Northline Supply", on_account: true }],
  supplierPayments: [
    { id: "sp1", supplier_account_id: "a1", amount: 500, paid_on: "2026-05-30", method: "check", voided_at: null },
    { id: "sp2", supplier_account_id: "a1", amount: 100, paid_on: "2026-06-01", method: "check", voided_at: "2026-06-02T00:00:00Z" },
  ],
  supplierDocuments: [],
});

const lists = (): AccountantInputs => ({
  items: [{ id: "i1", name: "12/2 NM-B", unit: "ft" }],
  lots: [{ lot_id: "L1", item_id: "i1", kind: "line", bill_id: "b1", bill_line_id: "b1-l1", pieces: "250", unit: "ft", cost: "150", bought_on: "2026-04-12", live: true, note: null }],
  moves: [{ id: "m1", item_id: "i1", lot_id: "L1", job_id: null, kind: "write_off", qty: "33.333", cost: "20", note: "Ruined", created_at: "2026-06-10T15:00:00Z", undone_at: null, settled_by: null }],
  bills: money().bills.filter((b) => !b.superseded_by_bill_id).map((b) => ({ ...b, amount: String(b.amount) })) as AccountantInputs["bills"],
  lines: [
    { id: "b1-l1", bill_id: "b1", description: "12/2 NM-B 250'", quantity: 1, unit_price: 150, amount: 150, category: "Wire", billable: false, billed_amount: null },
    { id: "b4-l1", bill_id: "b4", description: "Cordless impact driver", quantity: 1, unit_price: 129.99, amount: 129.99, category: "Tools", billable: true, billed_amount: null },
    { id: "b5-l1", bill_id: "b5", description: "Hammer drill", quantity: 1, unit_price: 199, amount: 199, category: "Tools", billable: true, billed_amount: null },
    { id: "b5-l2", bill_id: "b5", description: "Wire and boxes", quantity: 1, unit_price: 1001, amount: 1001, category: "Materials", billable: true, billed_amount: null },
  ],
  jobs: [
    { id: "j1", job_number: "J-201", name: "Maple Court Remodel" },
    { id: "j2", job_number: "J-202", name: "Birch Street Service" },
  ],
  claims: [{ source_ids: ["b5"], import_key: null, invoice_number: "INV-102" }],
});

const Q2 = periodFromKey("2026-Q2")!;
const input = (over: Partial<AccountantWorkbookInput> = {}): AccountantWorkbookInput => ({
  company: "Pinecrest Electric Co",
  period: Q2,
  tz: TZ,
  todayYmd: TODAY,
  showOwner: true,
  money: money(),
  lists: lists(),
  shelf: true,
  arInvoices: [
    { id: "i7", customer_id: "cu-acme", invoice_number: "INV-107", status: "sent", total: 1500, amount_paid: 500, due_date: "2026-09-01", created_at: "2026-08-20T00:00:00Z", customers: { name: "Acme Homes" } },
    { id: "i8", customer_id: "cu-acme", invoice_number: "INV-108", status: "draft", total: 900, amount_paid: 0, due_date: null, created_at: "2026-09-20T00:00:00Z", customers: { name: "Acme Homes" } },
  ],
  salesTax: {
    invoices: [
      { tax_rate: 0.0725, tax: 72.5, subtotal: 1000, total: 1072.5, status: "sent", created_at: "2026-05-01T17:00:00Z" },
      { tax_rate: 0.0725, tax: 99, subtotal: 9, total: 108, status: "draft", created_at: "2026-05-01T17:00:00Z" },
    ],
    taxRates: [{ name: "Lakeside County", rate: 7.25 }],
  },
  ...over,
});

// ── Reading the tabs back ────────────────────────────────────────────────────

const tab = (wb: AccountantWorkbook, name: string): XlsxSheet => wb.tabs.find((t) => t.name === name)!;
const rowOf = (t: XlsxSheet, label: string) => t.rows.find((r) => r.cells[0] === label);
const cents = (v: XlsxValue): number | null => (v && typeof v === "object" && "money" in v ? Math.round(v.money * 100) : null);
const toCents = (n: number) => Math.round(n * 100);
const everyText = (wb: AccountantWorkbook) => wb.tabs.flatMap((t) => t.rows.flatMap((r) => r.cells.map((c) => (typeof c === "string" ? c : ""))));

describe("the Summary is Money by Month, to the cent", () => {
  const wb = buildAccountantWorkbook(input());
  const summary = tab(wb, "Summary");
  const cur = computeOwnerMoney(money(), periodWindow(Q2), TZ, TODAY);
  const prev = computeOwnerMoney(money(), periodWindow(previousPeriod(Q2)), TZ, TODAY);
  const header = summary.rows.find((r) => r.bold && r.cells[0] === "" && String(r.cells[1]).startsWith("Apr"))!;

  it("has the six tabs, in order", () => {
    expect(wb.tabs.map((t) => t.name)).toEqual([...TAB_NAMES]);
    expect(TAB_NAMES).toEqual(["Summary", "Income", "Costs", "People", "Open", "Stock"]);
  });

  it("each month, the quarter, the quarter before and the change: every figure computeOwnerMoney's", () => {
    expect(header.cells).toEqual(["", "Apr 2026", "May 2026", "Jun 2026", "Total 2026 Q2", "2026 Q1", "Change"]);
    const hasOther = true;
    for (const l of summaryLines(hasOther)) {
      const r = rowOf(summary, l.label)!;
      expect(r, l.label).toBeTruthy();
      const want = [...cur.months.map((m) => toCents(l.of(m))), toCents(l.of(cur.totals)), toCents(l.of(prev.totals))];
      expect(r.cells.slice(1, 6).map(cents), l.label).toEqual(want);
      expect(cents(r.cells[6]), l.label).toBe(want[3] - want[4]);
    }
    const net = rowOf(summary, NET_LABEL)!;
    expect(net.cells.slice(1, 6).map(cents)).toEqual([...cur.months.map((m) => toCents(m.left)), toCents(cur.totals.left), toCents(prev.totals.left)]);
    // The fixture moves money on every line (a check that the test itself isn't passing on zeros).
    expect(cur.totals).toMatchObject({ received: 4170, otherIncome: 120, crewMileagePaid: 38, fuel: 85.5, putOnShelf: 130, shopStockLost: 20, processorFees: 72.8 });
    expect(cur.totals.businessCosts.Auto).toBe(300); // 240 + a stored "Gas & Truck" 60
    expect(cur.totals.crewPay).toBe(1030);
  });

  it("Received less Total Costs is the Net, and the page's two figures are the same numbers", () => {
    const received = cents(rowOf(summary, "Received")!.cells[4])!;
    const costs = cents(rowOf(summary, "Total Costs")!.cells[4])!;
    expect(received - costs).toBe(toCents(cur.totals.left));
    expect(wb.figures).toEqual({ received: cur.totals.received, net: cur.totals.left });
  });

  it("the bottom line is named exactly Net Profit (before income tax)", () => {
    expect(NET_LABEL).toBe("Net Profit (before income tax)");
    expect(summary.rows.filter((r) => r.cells[0] === NET_LABEL)).toHaveLength(1);
    // Never called a draw: North doesn't track cash the owner took out.
    expect(summary.rows.some((r) => /^Owner'?s Draw/i.test(String(r.cells[0] ?? "")))).toBe(false);
  });

  it("every business-cost bucket is its own row, from BUSINESS_COST_BUCKETS: Fuel and Auto both, never Gas & Truck", () => {
    const labels = summary.rows.map((r) => r.cells[0]);
    const at = BUSINESS_COST_BUCKETS.map((b) => labels.indexOf(b));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at); // in the list's own order
    expect(labels).toContain("Fuel");
    expect(labels).toContain("Auto");
    expect(labels).not.toContain("Gas & Truck");
    expect(labels).toContain(STOCK_BOUGHT_LABEL);
    expect(labels).toContain(STOCK_LOST_LABEL);
  });

  it("prints what's open as of the download day, with that date", () => {
    expect(summary.rows.some((r) => r.cells[0] === `Open As Of ${TODAY}`)).toBe(true);
    expect(cents(rowOf(summary, "Customers Owe You")!.cells[1])).toBe(100000); // INV-107; the draft isn't counted
    // Northline Supply: 600 + 1200 on account, less the 500 sent (the voided 100 never counts).
    expect(cents(rowOf(summary, "Suppliers Say You Owe")!.cells[1])).toBe(130000);
    const open = tab(wb, "Open");
    expect(open.rows[0].cells[0]).toBe(`Open As Of ${TODAY}`);
    expect(String(open.rows[1].cells[0])).toContain(TODAY);
  });

  it("says what isn't counted, in words (a card fee Stripe hasn't reported, crew pay still owed)", () => {
    const notes = summary.rows.map((r) => String(r.cells[0] ?? ""));
    expect(notes.some((s) => s.startsWith("Not counted:") && s.includes("card fees on 1 payment"))).toBe(true);
    expect(notes.some((s) => s.startsWith("Counted, though not paid yet:"))).toBe(true);
    expect(notes).toContain("Fees includes $72.80 of card fees on payments received.");
  });
});

describe("Income, Costs and People hold the rows behind the Summary", () => {
  const wb = buildAccountantWorkbook(input());
  const cur = computeOwnerMoney(money(), periodWindow(Q2), TZ, TODAY);

  it("Income: every payment on its day; the counted ones, less the refund, plus Other Income, are Received", () => {
    const income = tab(wb, "Income");
    const start = income.rows.findIndex((r) => r.cells[0] === "Date") + 1;
    const end = income.rows.findIndex((r) => r.cells[0] === "Payments");
    const listed = income.rows.slice(start, end);
    expect(listed).toHaveLength(7); // 5 payments, 1 refund, 1 deposit
    const counted = listed.filter((r) => r.cells[8] !== "Invoice voided: not counted").reduce((s, r) => s + cents(r.cells[6])!, 0);
    expect(counted).toBe(toCents(cur.totals.received));
    expect(cents(rowOf(income, "Received")!.cells[6])).toBe(toCents(cur.totals.received));
    expect(listed.find((r) => r.cells[2] === "INV-102")!.cells).toEqual([{ date: "2026-05-15" }, "Birch Street LLC", "INV-102", "J-202", "Birch Street Service", "Card", { money: 2500 }, { money: 72.8 }, null]);
    expect(listed.find((r) => r.cells[2] === "INV-105")!.cells[8]).toBe("Card fee not reported yet");
    // By customer, by job, by method: each adds up to the payments.
    for (const [title, col] of [["Payments By Customer", 1], ["Payments By Job", 2], ["Payments By Method", 1]] as const) {
      const at = income.rows.findIndex((r) => r.cells[0] === title);
      const tot = income.rows.slice(at).find((r) => r.cells[0] === "Total")!;
      expect(cents(tot.cells[col]), title).toBe(410000);
    }
    const byJob = income.rows.slice(income.rows.findIndex((r) => r.cells[0] === "Payments By Job"));
    expect(byJob.find((r) => r.cells[1] === "No Job On The Invoice")!.cells[2]).toEqual({ money: 400 });
  });

  it("Income: sales tax only when switched on, labeled billed basis; switched off says so", () => {
    const on = tab(wb, "Income");
    expect(on.rows.some((r) => String(r.cells[0]).startsWith("Billed basis"))).toBe(true);
    const taxTotal = on.rows.slice(on.rows.findIndex((r) => r.cells[0] === "Sales Tax")).find((r) => r.cells[0] === "Total")!;
    expect(taxTotal.cells.slice(2).map((c) => (typeof c === "number" ? c : cents(c)))).toEqual([1, 100000, 7250]); // the draft never counts
    const off = tab(buildAccountantWorkbook(input({ salesTax: null })), "Income");
    expect(off.rows.map((r) => r.cells[0])).toContain("Sales Tax is switched off for this company, so none is listed.");
  });

  it("Costs: every cost line, and its totals by where it goes are the Summary's rows", () => {
    const costs = tab(wb, "Costs");
    const at = costs.rows.findIndex((r) => r.cells[0] === "Totals By Where It Goes");
    const totals = costs.rows.slice(at + 2, costs.rows.findIndex((r, i) => i > at && r.cells[0] === "Total"));
    const want = (f: OwnerMoneyFigures) =>
      summaryLines(false)
        .filter((l) => l.cost && l.label !== "Crew Pay (1099)" && l.label !== "Crew Mileage Paid")
        .map((l) => [l.label, toCents(l.of(f))]);
    expect(totals.map((r) => [r.cells[0], cents(r.cells[1])])).toEqual(want(cur.totals));
    // The ticket with a roll in it: its rest is Materials & Bills, its roll is Stock Bought.
    const b1 = costs.rows.filter((r) => r.cells[2] === "NS-100");
    expect(b1.map((r) => [r.cells[5], cents(r.cells[6])])).toEqual([
      ["Materials & Bills", 45000],
      [STOCK_BOUGHT_LABEL, 15000],
    ]);
    // The write-off: out of Stock Bought, into Stock Lost, named by its item.
    expect(costs.rows.filter((r) => r.cells[1] === "Stock").map((r) => [r.cells[5], cents(r.cells[6]), r.cells[7]])).toEqual([
      [STOCK_BOUGHT_LABEL, -2000, "Written off: 12/2 NM-B"],
      [STOCK_LOST_LABEL, 2000, "Written off: 12/2 NM-B"],
    ]);
    // A stored "Gas & Truck" goes to Auto, and never says Gas & Truck beside it.
    expect(costs.rows.find((r) => r.cells[1] === "Quick Lube")!.cells.slice(5)).toEqual(["Auto", { money: 60 }, null]);
  });

  it("Costs: what was paid to each supplier (voided left out), and the tools, kept and billed to the customer", () => {
    const costs = tab(wb, "Costs");
    expect(rowOf(costs, "Northline Supply")!.cells).toEqual(["Northline Supply", 1, { money: 500 }]);
    const kept = costs.rows.slice(costs.rows.findIndex((r) => r.cells[0] === "Tools The Company Kept"));
    expect(kept.find((r) => r.cells[3] === "Cordless impact driver")).toBeTruthy();
    const billed = costs.rows.slice(costs.rows.findIndex((r) => r.cells[0] === "Tools Billed To Customer"));
    expect(billed.find((r) => r.cells[4] === "Hammer drill")!.cells).toEqual([{ date: "2026-06-02" }, "Northline Supply", "J-202", "Birch Street Service", "Hammer drill", { money: 199 }, "INV-102"]);
  });

  it("People: earned adds up to Crew Pay; miles are miles, never dollars; the owner's hours are never pay", () => {
    const ppl = tab(wb, "People");
    const head = ppl.rows.find((r) => r.cells[0] === "Person")!.cells;
    expect(head).toEqual(["Person", "Paid By", "Hours", "Earned", "Paid In Period", `Still Owed (${TODAY})`, "Paid In 2026 Through 2026-06-30", "Miles Logged", "Miles Past Daily Commute", "Mileage Settled", "Note"]);
    const sam = rowOf(ppl, "Sam Rivera")!.cells;
    // 8 locked + 14 live hours; 320 frozen + 14 x 40; paid 320 + 200 (the voided 999 never counts);
    // owed 1,040 earned all told less 520; 55 miles, 35 past a 10-mile commute each day; 38 typed.
    expect(sam).toEqual(["Sam Rivera", "Crew (1099)", 22, { money: 880 }, { money: 520 }, { money: 520 }, { money: 520 }, 55, 35, { money: 38 }, null]);
    expect(typeof sam[7]).toBe("number");
    expect(typeof sam[8]).toBe("number");
    const total = rowOf(ppl, "Crew Total")!.cells;
    expect(cents(total[3])).toBe(toCents(cur.totals.crewPay));
    expect(cents(total[9])).toBe(toCents(cur.totals.crewMileagePaid));
    // No money cell anywhere is miles at a rate: the only mileage dollars are the ones a person typed.
    const moneyCells = wb.tabs.flatMap((t) => t.rows.flatMap((r) => r.cells.map(cents))).filter((c): c is number => c != null);
    for (const rate of [0.655, 0.67, 0.7, 0.725]) for (const miles of [55, 35, 40, 95]) expect(moneyCells).not.toContain(Math.round(miles * rate * 100));
    const owner = rowOf(ppl, "Dana Pinecrest")!.cells;
    expect(owner).toEqual(["Dana Pinecrest", "Owner (Owner's Draw)", 16, null, null, null, null, 40, 40, null, "Hours only: the owner's time is not pay or a cost."]);
    expect(rowOf(tab(wb, "Summary"), "Owner Hours (not pay)")!.cells[4]).toBe(16);
    // The owner's 16 hours cost nothing: Crew Pay is Sam's and Lee's alone.
    expect(cur.totals.crewPay).toBe(880 + 150);
  });

  it("Stock: what was in stock on the period's last day, at cost", () => {
    const stock = tab(wb, "Stock");
    expect(stock.rows[0].cells[0]).toBe("In Stock At The End Of 2026-06-30");
    const coil = rowOf(stock, "12/2 NM-B")!.cells;
    expect(coil.slice(0, 5)).toEqual(["12/2 NM-B", "ft", 216.667, { money: 130 }, { date: "2026-04-12" }]);
    expect(rowOf(tab(wb, "Summary"), "In Stock At The End Of 2026-06-30")!.cells[1]).toEqual({ money: 130 });
    const none = tab(buildAccountantWorkbook(input({ shelf: false })), "Stock");
    expect(none.rows[1].cells[0]).toBe("Shop Stock isn't set up in this database, so nothing is listed.");
  });
});

describe("the owner's switch: an office download without Owner's Draw", () => {
  const wb = buildAccountantWorkbook(input({ showOwner: false }));
  const cur = computeOwnerMoney(money(), periodWindow(Q2), TZ, TODAY);

  it("has no Net anywhere and no owner rows, and says so", () => {
    const texts = everyText(wb);
    expect(texts).not.toContain(NET_LABEL);
    expect(texts.some((s) => s.includes("Dana Pinecrest"))).toBe(false);
    expect(texts.some((s) => s.startsWith("Owner Hours"))).toBe(false);
    expect(texts).toContain(OWNER_HIDDEN_NOTE);
    expect(OWNER_HIDDEN_NOTE).toBe("The totals are the owner's.");
    expect(wb.figures).toEqual({ received: null, net: null });
    // The itemized tabs stay: the office already sees those records in the app.
    expect(rowOf(tab(wb, "People"), "Sam Rivera")).toBeTruthy();
    expect(rowOf(tab(wb, "Income"), "Payments")).toBeTruthy();
    // And the files built from it carry no Net either.
    const csv = unzip(workbookCsvZip(wb)).map((e) => text(e.data)).join("\n");
    expect(csv).not.toContain("Net Profit");
    const xml = unzip(workbookXlsx(wb)).map((e) => text(e.data)).join("\n");
    expect(xml).not.toContain("Net Profit");
  });

  it("the Summary carries no bottom-line figure at all: no Received, no Total Costs, so Net is never one subtraction away", () => {
    const summary = tab(wb, "Summary");
    const labels = summary.rows.map((r) => r.cells[0]);
    for (const gone of ["Received", "Other Income (Inside Received)", "Total Costs", NET_LABEL, "Owner Hours (not pay)"]) expect(labels, gone).not.toContain(gone);
    // The cost rows stay, one by one, each with its months, the period, the period before and the change.
    const costRows = summaryLines(true).filter((l) => l.cost);
    for (const l of costRows) expect(rowOf(summary, l.label)!.cells.slice(1, 5).map(cents), l.label).toEqual([...cur.months.map((m) => toCents(l.of(m))), toCents(l.of(cur.totals))]);
    // The table is the cost rows and nothing else: no row holds Received, Net or a total of the costs.
    const header = summary.rows.findIndex((r) => r.bold && r.cells[0] === "");
    const table = summary.rows.slice(header + 1, header + 1 + costRows.length);
    expect(table.map((r) => r.cells[0])).toEqual(costRows.map((l) => l.label));
    expect(summary.rows[header + 1 + costRows.length].cells).toEqual([OWNER_HIDDEN_NOTE]);
    const moneyInTable = summary.rows.slice(header + 1).flatMap((r) => r.cells.slice(1).map(cents)).filter((c): c is number => c != null);
    const costTotal = costRows.reduce((s, l) => s + toCents(l.of(cur.totals)), 0);
    for (const secret of [toCents(cur.totals.left), toCents(cur.totals.received), costTotal]) expect(moneyInTable).not.toContain(secret);
  });
});

describe("what suppliers are owed is /bills' rule: an account paid ahead doesn't come off the others", () => {
  const withAhead = (): OwnerMoneyInputs => {
    const m = money();
    m.supplierAccounts = [...(m.supplierAccounts ?? []), { id: "a2", name: "Paid Ahead Co", on_account: true }];
    m.supplierPayments = [...(m.supplierPayments ?? []), { id: "sp9", supplier_account_id: "a2", amount: 700, paid_on: "2026-06-15", method: "check", voided_at: null }];
    return m;
  };
  const wb = buildAccountantWorkbook(input({ money: withAhead() }));

  it("Suppliers Say You Owe counts only what is owed, as /bills does; the credit is its own labelled row", () => {
    // Northline: 1,800 of bills less 500 sent = 1,300 owed. Paid Ahead Co: 700 sent, no bills.
    expect(cents(rowOf(tab(wb, "Summary"), "Suppliers Say You Owe")!.cells[1])).toBe(130000);
    const open = tab(wb, "Open");
    const owedAt = open.rows.findIndex((r) => r.cells[0] === "Suppliers Say You Owe");
    const owedTotal = open.rows.slice(owedAt).find((r) => r.cells[0] === "Total")!;
    expect(cents(owedTotal.cells[1])).toBe(130000);
    const owedRows = open.rows.slice(owedAt + 2, open.rows.indexOf(owedTotal));
    expect(owedRows.map((r) => r.cells[0])).toEqual(["Northline Supply"]);
    const aheadAt = open.rows.findIndex((r) => r.cells[0] === "Paid Ahead (Credit With The Supplier)");
    expect(aheadAt).toBeGreaterThan(owedAt);
    expect(open.rows[aheadAt + 2].cells).toEqual(["Paid Ahead Co", { money: 700 }]);
    expect(tab(wb, "Summary").rows.some((r) => String(r.cells[0]).startsWith("Paid ahead with 1 supplier by $700.00"))).toBe(true);
  });
});

describe("Still Owed is the Pay board's You Owe, whatever span was read", () => {
  it("a never-locked shift from before the Pay board's 18 months doesn't raise it", () => {
    const m = money();
    m.balanceFrom = "2025-03-27";
    m.entries = [...m.entries, shift("e-old", SAM, "2025-01-15", 4)];
    const sam = rowOf(tab(buildAccountantWorkbook(input({ money: m })), "People"), "Sam Rivera")!.cells;
    expect(sam[5]).toEqual({ money: 520 }); // the same as without the old shift
  });
});

describe("a period not over yet is compared with the same days of the period before", () => {
  it("the same days: as far into the period before as today is into this one", () => {
    expect(comparisonThrough(periodFromKey("2026")!, TODAY)).toBe("2025-09-27");
    expect(comparisonThrough(periodFromKey("2026-09")!, TODAY)).toBe("2026-08-27");
    expect(comparisonThrough(periodFromKey("2026-Q3")!, TODAY)).toBe("2026-06-27");
    expect(comparisonThrough(periodFromKey("2026-03")!, "2026-03-31")).toBe("2026-02-28");
    expect(comparisonThrough(periodFromKey("2026-Q2")!, TODAY)).toBeNull(); // over: all of Q1
  });

  it("Q3 on Sep 27: the column is Q2 through Jun 27 (computeOwnerMoney through that day), and the change says So Far", () => {
    const q3 = periodFromKey("2026-Q3")!;
    const s = tab(buildAccountantWorkbook(input({ period: q3 })), "Summary");
    expect(s.rows.find((r) => r.cells[0] === "" && r.bold)!.cells).toEqual(["", "Jul 2026", "Aug 2026", "Sep 2026", "Total 2026 Q3", "2026 Q2 Through Jun 27", "Change So Far"]);
    const soFar = computeOwnerMoney(money(), periodWindow(Q2), TZ, TODAY, { throughDay: "2026-06-27" });
    const whole = computeOwnerMoney(money(), periodWindow(Q2), TZ, TODAY);
    // The Jun 28 refund and the Jun 30 insurance bill are after the day: not in the comparison.
    expect(soFar.totals.received).toBe(4220);
    expect(whole.totals.received).toBe(4170);
    expect(cents(rowOf(s, "Received")!.cells[5])).toBe(422000);
    expect(cents(rowOf(s, NET_LABEL)!.cells[5])).toBe(toCents(soFar.totals.left));
    expect(s.rows.some((r) => String(r.cells[0]).startsWith("Change So Far compares 2026 Q3 through 2026-09-27 with the same days of 2026 Q2"))).toBe(true);
  });

  it("the default, this year: 2025 through Sep 27", () => {
    const s = tab(buildAccountantWorkbook(input({ period: periodFromKey("2026")! })), "Summary");
    const head = s.rows.find((r) => r.cells[0] === "" && r.bold)!.cells;
    expect(head.slice(-3)).toEqual(["Total 2026", "2025 Through Sep 27", "Change So Far"]);
  });
});

describe("a period before North's records says so, never a silent $0.00", () => {
  it("the page's line and the file's note", () => {
    expect(beforeRecordsLine(periodFromKey("2025")!, "2026-02-03")).toBe("North has no records before Feb 3, 2026, so 2025 has nothing in it.");
    expect(beforeRecordsLine(Q2, "2026-02-03")).toBeNull();
    expect(beforeRecordsLine(Q2, null)).toBeNull();
    const s = tab(buildAccountantWorkbook(input({ period: periodFromKey("2025")! })), "Summary");
    expect(s.rows.map((r) => r.cells[0])).toContain("North has no records before Feb 3, 2026, so 2025 has nothing in it.");
  });
});

describe("the files", () => {
  const wb = buildAccountantWorkbook(input());
  const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));

  it("the CSV zip is one CSV per tab, every cell through toCsv: a formula a customer typed is defused", () => {
    const files = unzip(workbookCsvZip(wb, { deflate }));
    expect(files.map((f) => f.name)).toEqual(TAB_NAMES.map((n) => `${n}.csv`));
    const income = text(files.find((f) => f.name === "Income.csv")!.data);
    expect(income).toContain(`,'${SNEAKY},`); // a leading apostrophe: the spreadsheet shows it as text
    expect(income).not.toMatch(/(^|,)=cmd/m);
    expect(text(files[0].data).split("\r\n")[0]).toBe('"Pinecrest Electric Co: For Your Accountant, 2026 Q2"');
    expect(tabCsv(tab(wb, "Summary"))).toContain("Net Profit (before income tax),");
    // Money to the cent, dates as the day.
    expect(income).toContain("2026-05-15,Birch Street LLC,INV-102,J-202,Birch Street Service,Card,2500,72.8,");
  });

  it("the spreadsheet: six tabs, the formula a customer typed is text, money is a number", () => {
    const parts = new Map(unzip(workbookXlsx(wb, { deflate })).map((e) => [e.name, text(e.data)]));
    const names = [...parts.get("xl/workbook.xml")!.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual([...TAB_NAMES]);
    const all = [...parts.entries()].filter(([n]) => n.startsWith("xl/worksheets/")).map(([, x]) => x).join("");
    expect(all).not.toMatch(/<f[ >]/);
    expect(all).toContain("=cmd|&apos; /C calc&apos;!A0");
    expect(parts.get("xl/worksheets/sheet1.xml")).toMatch(/<c r="E5" s="2"><v>4170<\/v><\/c>/); // Received, the quarter
  });

  it("named after the company and the period, safe for a header, with the real name for clients that read it", () => {
    expect(accountantFileName("ET Electric", periodFromKey("2026-Q3")!, "xlsx")).toBe("ET Electric 2026 Q3.xlsx");
    expect(accountantFileName("ET Electric", periodFromKey("2026-09")!, "csv")).toBe("ET Electric 2026-09 CSV.zip");
    expect(accountantFileName('Bad/Name: "Co"\r\n', periodFromKey("2026")!, "xlsx")).toBe("Bad Name Co 2026.xlsx");
    expect(fileSafeName("   ")).toBe("North");
    const cd = contentDisposition("Électricité Nord 2026 Q3.xlsx");
    expect(cd).toBe(`attachment; filename="Electricite Nord 2026 Q3.xlsx"; filename*=UTF-8''%C3%89lectricit%C3%A9%20Nord%202026%20Q3.xlsx`);
    expect(fileNameFromDisposition(cd)).toBe("Électricité Nord 2026 Q3.xlsx");
    expect(fileNameFromDisposition('attachment; filename="x.xlsx"')).toBe("x.xlsx");
    expect(fileNameFromDisposition(null)).toBeNull();
  });

  it("a long name with an emoji at the 80-character cut: never half a character, never a failed download", () => {
    const name = `${"A".repeat(79)}\u{1F50C} Electric`;
    const safe = fileSafeName(name);
    expect(Array.from(safe)).toHaveLength(80);
    expect(safe.endsWith("\u{1F50C}")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(safe)).toBe(false);
    const file = accountantFileName(name, periodFromKey("2026-Q3")!, "xlsx");
    expect(() => contentDisposition(file)).not.toThrow();
    expect(fileNameFromDisposition(contentDisposition(file))).toBe(file);
    // And the header itself never throws on half a character, whoever cut it.
    expect(() => contentDisposition(`${"A".repeat(79)}\uD83D 2026.xlsx`)).not.toThrow();
    expect(contentDisposition(`AB\uD83D.xlsx`)).toBe(`attachment; filename="AB.xlsx"; filename*=UTF-8''AB.xlsx`);
  });
});

describe("periods: whole months only", () => {
  it("a month, a quarter or a year, begun by today; the one before; the page's choices", () => {
    expect(parseAccountantPeriod("2026-Q3", TODAY)).toMatchObject({ kind: "quarter", label: "2026 Q3", start: "2026-07-01", end: "2026-10-01" });
    expect(parseAccountantPeriod("2026-09", TODAY)).toMatchObject({ kind: "month", label: "September 2026", start: "2026-09-01", end: "2026-10-01" });
    expect(parseAccountantPeriod("2025", TODAY)).toMatchObject({ kind: "year", start: "2025-01-01", end: "2026-01-01" });
    for (const bad of ["2026-10", "2026-Q4", "2027", "2026-13", "2026-Q5", "2026-09-01", "", null, undefined, 2026, "1999"]) {
      expect(parseAccountantPeriod(bad, TODAY), String(bad)).toBeNull();
    }
    expect(previousPeriod(periodFromKey("2026-Q1")!).key).toBe("2025-Q4");
    expect(previousPeriod(periodFromKey("2026-01")!).key).toBe("2025-12");
    expect(previousPeriod(periodFromKey("2026")!).key).toBe("2025");
    expect(defaultAccountantPeriod(TODAY).key).toBe("2026");
    expect(periodChoices("quarter", TODAY).map((p) => p.key)).toEqual(["2026-Q3", "2026-Q2", "2026-Q1", "2025-Q4", "2025-Q3", "2025-Q2", "2025-Q1", "2024-Q4"]);
    expect(periodChoices("month", TODAY)).toHaveLength(24);
    expect(lastDayShown(periodFromKey("2026-Q3")!, TODAY)).toBe(TODAY);
    expect(lastDayShown(Q2, TODAY)).toBe("2026-06-30");
    // What the page and the route both read: the period and the one before.
    expect(accountantReadSpan(periodFromKey("2026")!)).toEqual({ start: "2025-01-01", end: "2027-01-01" });
    expect(accountantReadSpan(Q2)).toEqual({ start: "2026-01-01", end: "2026-07-01" });
  });

  it("a period not over yet says so, and its months stop at this one", () => {
    const wb = buildAccountantWorkbook(input({ period: periodFromKey("2026-Q3")! }));
    const s = tab(wb, "Summary");
    expect(String(s.rows[1].cells[0])).toContain(`The period isn't over: figures run through ${TODAY}.`);
    expect(s.rows.find((r) => r.cells[0] === "" && r.bold)!.cells).toEqual(["", "Jul 2026", "Aug 2026", "Sep 2026", "Total 2026 Q3", "2026 Q2 Through Jun 27", "Change So Far"]);
  });

  it("a month has no month-by-month columns (the total is the month)", () => {
    const s = tab(buildAccountantWorkbook(input({ period: periodFromKey("2026-06")! })), "Summary");
    expect(s.rows.find((r) => r.cells[0] === "" && r.bold)!.cells).toEqual(["", "Total June 2026", "May 2026", "Change"]);
  });
});

/**
 * A SAMPLE FOR THE REVIEWERS, regenerated without a script:
 *   WRITE_SAMPLE_XLSX=/some/folder/Pinecrest.xlsx npx vitest run src/lib/accountant-workbook.test.ts
 * writes the synthetic workbook there, and the CSV zip beside it (same name, " CSV.zip").
 */
const SAMPLE = process.env.WRITE_SAMPLE_XLSX;
(SAMPLE ? describe : describe.skip)("the sample file", () => {
  it("writes the synthetic workbook and its CSV zip", () => {
    const wb = buildAccountantWorkbook(input());
    const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));
    const xlsxPath = extname(SAMPLE!) ? SAMPLE! : join(SAMPLE!, accountantFileName("Pinecrest Electric Co", Q2, "xlsx"));
    mkdirSync(dirname(xlsxPath), { recursive: true });
    writeFileSync(xlsxPath, workbookXlsx(wb, { deflate }));
    const zipPath = xlsxPath.replace(/\.xlsx$/i, "") + " CSV.zip";
    writeFileSync(zipPath, workbookCsvZip(wb, { deflate }));
    expect(unzip(workbookXlsx(wb)).length).toBeGreaterThan(6);
  });
});
