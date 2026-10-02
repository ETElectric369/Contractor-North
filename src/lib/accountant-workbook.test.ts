import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  BEFORE_TAX_NOTE,
  NET_LABEL,
  OWNER_HIDDEN_NOTE,
  OWNER_HIDDEN_WHY,
  STOCK_BOUGHT_LABEL,
  STOCK_LOST_LABEL,
  TAB_NAMES,
  accountantFileName,
  accountantReadSpan,
  beforeRecordsLine,
  buildAccountantWorkbook,
  cogsOverheadNote,
  comparisonThrough,
  defaultAccountantPeriod,
  fileSafeName,
  lastDayShown,
  nothingInFigures,
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
import { computeOwnerMoney, supplierAccountRowsOf, type OwnerMoneyFigures, type OwnerMoneyInputs, type OwnerMoneyPerson } from "@/lib/analytics/owner-money";
import { supplierBalance } from "@/app/(app)/bills/supplier-balance";
import { PNL_WORDS, pnlLines, pnlRow, profitAndLoss } from "@/lib/analytics/profit-and-loss";
import { BUCKET_SECTION, BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";
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
  supplierAliases: [],
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

describe("the Summary is Money by Month, to the cent, laid out as a profit and loss", () => {
  const wb = buildAccountantWorkbook(input());
  const summary = tab(wb, "Summary");
  const cur = computeOwnerMoney(money(), periodWindow(Q2), TZ, TODAY);
  const prev = computeOwnerMoney(money(), periodWindow(previousPeriod(Q2)), TZ, TODAY);
  const headerAt = summary.rows.findIndex((r) => r.bold && r.cells[0] === "" && String(r.cells[1]).startsWith("Apr"));
  const header = summary.rows[headerAt];
  const lines = summaryLines({ hasOtherIncome: true, showOwner: true });

  it("has the six tabs, in order", () => {
    expect(wb.tabs.map((t) => t.name)).toEqual([...TAB_NAMES]);
    expect(TAB_NAMES).toEqual(["Summary", "Income", "Costs", "People", "Open", "Stock"]);
  });

  it("its rows are the profit and loss's, in the accounting industry's order and words, then the owner's hours", () => {
    // EVERYTHING ABOVE THE BOTTOM LINE, then Net Profit. What is BELOW it - a blank, the Owner's Draw
    // equity row and its note - is asserted on its own below, because a row under the rule must never be
    // mistaken for one in this list.
    const aboveAndNet = lines.filter((l) => l.key !== "owner_draw");
    const labels = summary.rows.slice(headerAt + 1, headerAt + 1 + aboveAndNet.length).map((r) => r.cells[0]);
    expect(labels).toEqual([
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
    expect(aboveAndNet.map((l) => l.label)).toEqual(labels);
    // AND THE OWNER'S THREE HOURS ROWS, after the equity block (0373), so an accountant can tie the COGS
    // line to hours: the total, the on-site half whose cost is charged to the jobs, the office half that is not.
    const hours = summary.rows.map((r) => r.cells[0]).filter((c) => typeof c === "string" && c.startsWith("Owner Hours"));
    expect(hours).toEqual([
      "Owner Hours (Not Pay)",
      "Owner Hours On Jobs",
      "Owner Hours In The Office (Overhead)",
    ]);
  });

  /**
   * THE EQUITY LINE IS ON THE SHEET WHETHER OR NOT HE DREW ANYTHING (Erik, 2026-10-01: "an actual draw
   * from the owner is considered equity and should be a line item below net profit stating what Ive taken
   * out this month").
   *
   * It used to be switched on only when the figure was non-zero, and the figure has ONE source: bank lines
   * sorted as Owner's Draw. This fixture draws nothing, so before the fix the Summary had NO equity row,
   * no $0.00 and no disclosure - and an accountant could not tell a draw of nothing from a draw the app
   * cannot see. Now the row is there with the note that says which.
   */
  it("Owner's Draw is a row below the bottom line even at $0.00, and says what it cannot see", () => {
    const netAt = summary.rows.findIndex((r) => r.cells[0] === NET_LABEL);
    const drawAt = summary.rows.findIndex((r) => r.cells[0] === PNL_WORDS.ownerDraw);
    expect(drawAt).toBeGreaterThan(netAt);
    // A BLANK ROW BETWEEN THEM: flush under a bold Net Profit, this row reads as a total of it.
    expect(summary.rows[drawAt - 1].cells.filter(Boolean)).toEqual([]);
    // NEVER BOLD. How the row is weighted is PNL_KIND_SHAPE's answer and `equity` is weighted "line", so
    // it is indented like one - what it must never be is BOLD, because bold under a bold Net Profit is
    // exactly how a reader takes it for a total of the figure above it.
    expect(!!summary.rows[drawAt].bold).toBe(false);
    // The fixture really did draw nothing, so this is the zero case and not an accident.
    expect(cur.totals.ownerDraw).toBe(0);
    expect(cents(summary.rows[drawAt].cells[4])).toBe(0);
    // AND IT SAYS SO IN WORDS: equity not an expense, what the figure can see, and that zero is not a
    // claim that nothing was drawn.
    const note = String(summary.rows[drawAt + 1].cells[0]);
    expect(note).toContain("is equity, not an expense");
    expect(note).toContain("Cash you took without a bank line is not in it");
    expect(note).toContain("Nothing this period that the app can see");
  });

  it("formatted the way an accountant lays one out: headings and totals bold, every line under its heading indented", () => {
    for (const l of lines) {
      const r = rowOf(summary, l.label)!;
      if (l.kind === "heading") expect(r, l.label).toEqual({ cells: [l.label], bold: true });
      else if (l.kind === "cost" || l.kind === "part" || l.kind === "margin") expect([r.indent, !!r.bold], l.label).toEqual([true, false]);
      else expect([!!r.indent, r.bold], l.label).toEqual([false, true]);
    }
  });

  it("each month, the quarter, the quarter before and the change: every figure computeOwnerMoney's", () => {
    expect(header.cells).toEqual(["", "Apr 2026", "May 2026", "Jun 2026", "Total 2026 Q2", "2026 Q1", "Change"]);
    for (const l of lines.filter((x) => x.kind !== "heading" && x.kind !== "margin")) {
      const r = rowOf(summary, l.label)!;
      expect(r, l.label).toBeTruthy();
      const want = [...cur.months.map((m) => l.cents(m)), l.cents(cur.totals), l.cents(prev.totals)];
      expect(r.cells.slice(1, 6).map(cents), l.label).toEqual(want);
      expect(cents(r.cells[6]), l.label).toBe(want[3]! - want[4]!);
    }
    // THE BOTTOM LINE IS THE ENGINE'S NET, month by month, to the cent.
    const net = rowOf(summary, NET_LABEL)!;
    expect(net.cells.slice(1, 6).map(cents)).toEqual([...cur.months.map((m) => toCents(m.left)), toCents(cur.totals.left), toCents(prev.totals.left)]);
    // The fixture moves money on every line (a check that the test itself isn't passing on zeros).
    expect(cur.totals).toMatchObject({ received: 4170, otherIncome: 120, crewMileagePaid: 38, fuel: 85.5, putOnShelf: 130, shopStockLost: 20, processorFees: 72.8 });
    expect(cur.totals.businessCosts.Auto).toBe(300); // 240 + a stored "Gas & Truck" 60
    expect(cur.totals.crewPay).toBe(1030);
  });

  it("Revenue less Total COGS is Gross Profit, less Total Overhead is Net Profit: the engine's net, in every column", () => {
    const col = (label: string, i: number) => cents(rowOf(summary, label)!.cells[i])!;
    for (let i = 1; i <= 6; i++) {
      expect(col("Revenue", i) - col("Total COGS", i), `column ${i}`).toBe(col("Gross Profit", i));
      expect(col("Gross Profit", i) - col("Total Overhead", i), `column ${i}`).toBe(col(NET_LABEL, i));
    }
    // By hand, the quarter: 4,170 in; COGS 1,775 + 130 + 20 + 1,030 + 38 = 2,993 (Fuel left COGS on
    // 2026-09-30); Overhead 85.50 Fuel + 300 + 129.99 + 45 + 300 + 72.80 = 933.29; so 1,177 gross
    // and the same 243.71 net.
    expect([col("Total COGS", 4), col("Gross Profit", 4), col("Total Overhead", 4), col(NET_LABEL, 4)]).toEqual([299300, 117700, 93329, 24371]);
    expect(toCents(cur.totals.left)).toBe(24371);
    // The page's figures are the same numbers.
    expect(wb.figures).toEqual({ revenue: cur.totals.received, grossProfit: 1177, net: cur.totals.left });
  });

  it("Gross Margin %: a plain percent in each column, its change in points", () => {
    const r = rowOf(summary, "Gross Margin %")!;
    // Q2: 1,177 of 4,170 is 28.2%. Q1: 800 in and 160 of crew pay, so 80.0% (its 40 of Fuel is
    // Overhead now, below Gross Profit).
    expect(r.cells.slice(4)).toEqual([28.2, 80, -51.8]);
    expect(r.cells.slice(1, 4).every((c) => typeof c === "number")).toBe(true);
  });

  it("the bottom line is named exactly Net Profit, said before income tax", () => {
    expect(NET_LABEL).toBe("Net Profit");
    expect(summary.rows.filter((r) => r.cells[0] === NET_LABEL)).toHaveLength(1);
    expect(summary.rows.map((r) => r.cells[0])).toContain(BEFORE_TAX_NOTE);
    expect(BEFORE_TAX_NOTE).toBe("Net Profit is before income tax.");
    // What the two halves are, in the accounting industry's own test, with the lines from the data.
    expect(summary.rows.map((r) => r.cells[0])).toContain(cogsOverheadNote());
    expect(cogsOverheadNote()).toBe(
      "Cost of Goods Sold (COGS) is what doing the jobs costs: Materials & Bills, Stock Bought, Stock Lost, Crew Pay (1099) and Crew Mileage Paid. Overhead is what keeps running whether there is work or not: Fuel, Auto, Tools & Supplies, Phone & Office, Insurance & Licenses, Fees and Other.",
    );
  });

  it("every business-cost bucket is its own row, in the half BUCKET_SECTION puts it: every one Overhead, Fuel above Auto, never Gas & Truck", () => {
    const labels = summary.rows.map((r) => r.cells[0]);
    const at = BUSINESS_COST_BUCKETS.map((b) => labels.indexOf(b));
    expect(at.every((i) => i > 0)).toBe(true);
    const cogs = labels.indexOf("Cost of Goods Sold (COGS)");
    const totalCogs = labels.indexOf("Total COGS");
    const overhead = labels.indexOf("Overhead");
    const totalOverhead = labels.indexOf("Total Overhead");
    for (const b of BUSINESS_COST_BUCKETS) {
      const i = labels.indexOf(b);
      if (BUCKET_SECTION[b] === "cogs") expect(i > cogs && i < totalCogs, b).toBe(true);
      else expect(i > overhead && i < totalOverhead, b).toBe(true);
    }
    // Fuel is an Overhead row now (2026-09-30), the first of them, so it reads above Auto.
    expect(labels.indexOf("Fuel")).toBeGreaterThan(overhead);
    expect(labels.indexOf("Fuel")).toBeLessThan(labels.indexOf("Auto"));
    expect(labels.slice(cogs, totalCogs)).not.toContain("Fuel");
    expect(labels).not.toContain("Gas & Truck");
    expect(labels).toContain(STOCK_BOUGHT_LABEL);
    expect(labels).toContain(STOCK_LOST_LABEL);
    // The old words are gone.
    for (const old of ["Received", "Total Costs", "Other Income (Inside Received)", "Net Profit (before income tax)"]) expect(labels, old).not.toContain(old);
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
    // The list's bottom line is the Summary's top one, by the same word.
    expect(cents(rowOf(income, "Revenue")!.cells[6])).toBe(toCents(cur.totals.received));
    expect(rowOf(income, "Received")).toBeUndefined();
    expect(income.rows.map((r) => r.cells[0])).toContain("Refunds and Other Income are in the list above and in Revenue, not in these three breakdowns.");
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

  it("Costs: every cost line, and its totals by where it goes are the Summary's rows, under the same two headings", () => {
    const costs = tab(wb, "Costs");
    const at = costs.rows.findIndex((r) => r.cells[0] === "Totals By Where It Goes");
    const totals = costs.rows.slice(at + 2, costs.rows.findIndex((r, i) => i > at && r.cells[0] === "Total"));
    // The Summary's headings and cost rows, in its order, less the two crew rows (they are on People).
    const want = (f: OwnerMoneyFigures) =>
      pnlLines()
        .filter((l) => l.kind === "heading" || (l.kind === "cost" && l.key !== "crew_pay" && l.key !== "crew_mileage"))
        .map((l) => [l.label, l.kind === "heading" ? null : l.cents(f)]);
    expect(totals.map((r) => [r.cells[0], r.cells.length > 1 ? cents(r.cells[1]) : null])).toEqual(want(cur.totals));
    expect(totals.map((r) => r.cells[0])).toEqual([
      "Cost of Goods Sold (COGS)",
      "Materials & Bills",
      STOCK_BOUGHT_LABEL,
      STOCK_LOST_LABEL,
      "Overhead",
      "Fuel",
      "Auto",
      "Tools & Supplies",
      "Phone & Office",
      "Insurance & Licenses",
      "Fees",
      "Other",
    ]);
    // Headings bold, the lines under them indented, as on the Summary.
    for (const r of totals) expect(r.bold ? "heading" : r.indent ? "line" : "?", String(r.cells[0])).toBe(r.cells.length === 1 ? "heading" : "line");
    // Its Total is every cost line listed above it, to the cent.
    const totalAt = costs.rows.findIndex((r, i) => i > at && r.cells[0] === "Total");
    const listed = costs.rows.slice(costs.rows.findIndex((r) => r.cells[0] === "Date") + 1, at - 1).reduce((s, r) => s + (cents(r.cells[6]) ?? 0), 0);
    expect(cents(costs.rows[totalAt].cells[1])).toBe(listed);
    // It leaves crew pay out, and says so, so it never reads as the Summary's Total COGS.
    expect(costs.rows[totalAt + 1].cells[0]).toBe("Crew Pay (1099), Crew Mileage Paid and the owner's build time are in Cost of Goods Sold (COGS) too, but they are hours rather than paper, so their rows are on the People tab and they are not in this total.");
    // The ticket with a roll in it: its rest is Materials & Bills, its roll is Stock Bought. Scoped to
    // the cost list (above the totals) — the ticket's own lines are listed again further down the tab.
    const costList = costs.rows.slice(0, at);
    const b1 = costList.filter((r) => r.cells[2] === "NS-100");
    expect(b1.map((r) => [r.cells[5], cents(r.cells[6])])).toEqual([
      ["Materials & Bills", 45000],
      [STOCK_BOUGHT_LABEL, 15000],
    ]);
    // The write-off: out of Stock Bought, into Stock Lost, named by its item.
    expect(costList.filter((r) => r.cells[1] === "Stock").map((r) => [r.cells[5], cents(r.cells[6]), r.cells[7]])).toEqual([
      [STOCK_BOUGHT_LABEL, -2000, "Written off: 12/2 NM-B"],
      [STOCK_LOST_LABEL, 2000, "Written off: 12/2 NM-B"],
    ]);
    // A stored "Gas & Truck" goes to Auto, and never says Gas & Truck beside it.
    expect(costList.find((r) => r.cells[1] === "Quick Lube")!.cells.slice(5)).toEqual(["Auto", { money: 60 }, null]);
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
    expect(owner).toEqual(["Dana Pinecrest", "Owner (Owner's Draw)", 16, null, null, null, null, 40, 40, null, "Hours only: never a wage. Hours on a job are charged to the job at the owner's cost rate, and booked straight back on the profit and loss."]);
    expect(rowOf(tab(wb, "Summary"), "Owner Hours (Not Pay)")!.cells[4]).toBe(16);
    // HIS 16 HOURS ARE NOT IN CREW PAY, and never will be: Crew Pay is Sam's and Lee's alone. His build
    // time is its own COGS line with its own contra (0373), so it can never be folded in here - that fold
    // would deduct an owner's labour on the profit and loss, which a sole proprietor may not do.
    expect(cur.totals.ownerBuildTimeOnJobs).toBe(0); // no cost rate set on this fixture
    expect(cur.totals.crewPay).toBe(880 + 150);
  });

  it("Costs: every line on every ticket, and the gap between the lines and the tickets' totals is said", () => {
    const costs = tab(wb, "Costs");
    const at = costs.rows.findIndex((r) => r.cells[0] === "Every Line On Every Ticket");
    const lines = costs.rows.slice(at + 3, costs.rows.findIndex((r, i) => i > at && r.cells[0] === "Total Of The Lines"));
    expect(costs.rows[at + 2].cells).toEqual([
      "Date", "Supplier", "Bill Number", "Job Number", "Job", "Filed As", "Amount", "What", "Quantity", "Unit Price", "Billable", "Part Billed", "Into Stock",
    ]);
    // The roll on the Maple Court ticket: the company's own line (0268's billable false) that went on
    // the shelf, on the ticket's own day, under the ticket's number and the ticket's job.
    expect(lines.find((r) => r.cells[7] === "12/2 NM-B 250'")!.cells).toEqual([
      { date: "2026-04-12" }, "Northline Supply", "NS-100", "J-201", "Maple Court Remodel", "Wire", { money: 150 }, "12/2 NM-B 250'", 1, { money: 150 }, "No (the company's)", null, "Yes",
    ]);
    // A tool line on a ticket with two lines: billable, not stock, both lines listed.
    expect(lines.filter((r) => r.cells[2] === "NS-120").map((r) => [r.cells[7], cents(r.cells[6]), r.cells[10], r.cells[12]])).toEqual([
      ["Hammer drill", 19900, "Yes", null],
      ["Wire and boxes", 100100, "Yes", null],
    ]);
    // Only the period's tickets: the March receipt and the superseded duplicate are nowhere.
    expect(lines.every((r) => String((r.cells[0] as any)?.date ?? "").startsWith("2026-0") && (r.cells[0] as any).date >= "2026-04-01")).toBe(true);
    // The lines add up to their own Total, and the tab says, in dollars, what the lines don't name.
    const lineTotal = costs.rows.find((r) => r.cells[0] === "Total Of The Lines")!;
    expect(cents(lineTotal.cells[6])).toBe(lines.reduce((s, r) => s + cents(r.cells[6])!, 0));
    expect(cents(lineTotal.cells[6])).toBe(147999); // 150 + 129.99 + 199 + 1,001
    const said = costs.rows.map((r) => String(r.cells[0]));
    // 7 tickets in Q2 come to $2,615.50 (600 + 85.50 + 240 + 129.99 + 1,200 + 60 + 300); four of them
    // (Fuel, Auto, Gas & Truck, Insurance: $685.50) were entered as a total only.
    expect(said).toContain(
      "The tickets of this period come to $2,615.49 in the list at the top of this tab, and their lines name $1,479.99 of it. 4 tickets ($685.50) were entered as a total only, with no lines to list. A ticket is always counted by its own total, never by adding its lines.",
    );
  });

  it("Costs: each payment to a supplier, on its day, voided ones marked and not counted", () => {
    const costs = tab(wb, "Costs");
    const at = costs.rows.findIndex((r) => r.cells[0] === "Each Payment To A Supplier");
    const rows = costs.rows.slice(at + 3, costs.rows.findIndex((r, i) => i > at && r.cells[0] === "Total"));
    expect(costs.rows[at + 2].cells).toEqual(["Date", "Supplier", "Method", "Amount", "Note"]);
    expect(rows.map((r) => r.cells)).toEqual([
      [{ date: "2026-05-30" }, "Northline Supply", "Check", { money: 500 }, null],
      [{ date: "2026-06-01" }, "Northline Supply", "Check", { money: 100 }, "Voided: not counted"],
    ]);
    // Its Total is the live payments only — the same $500 the rollup above counts.
    const sent = costs.rows.slice(at).find((r) => r.cells[0] === "Total")!;
    expect(cents(sent.cells[3])).toBe(50000);
  });

  it("People: each payment handed over, every shift, and the pay periods that locked", () => {
    const ppl = tab(wb, "People");
    const handedAt = ppl.rows.findIndex((r) => r.cells[0] === "Each Payment Handed Over");
    expect(ppl.rows[handedAt + 2].cells).toEqual(["Date", "Person", "Kind", "Method", "Check Or Reference", "Amount", "Note"]);
    const handed = ppl.rows.slice(handedAt + 3, ppl.rows.findIndex((r, i) => i > handedAt && r.cells[0] === "Total Pay"));
    expect(handed.map((r) => [r.cells[0], r.cells[2], cents(r.cells[5]), r.cells[6]])).toEqual([
      [{ date: "2026-04-20" }, "Pay", 32000, null],
      [{ date: "2026-06-25" }, "Pay", 20000, null],
      [{ date: "2026-06-26" }, "Pay", 99900, "Voided: not counted"],
      [{ date: "2026-06-30" }, "Mileage Settled", 3800, "What was typed for the miles of 2026-06-01 to 2026-06-30"],
    ]);
    // The two totals are Sam's own Paid In Period and Mileage Settled, and they are never added together.
    const sam = rowOf(ppl, "Sam Rivera")!.cells;
    expect(cents(rowOf(ppl, "Total Pay")!.cells[5])).toBe(cents(sam[4]));
    expect(cents(rowOf(ppl, "Total Mileage Settled")!.cells[5])).toBe(cents(sam[9]));

    const shiftAt = ppl.rows.findIndex((r) => r.cells[0] === "Every Shift");
    expect(ppl.rows[shiftAt + 2].cells).toEqual(["Person", "Date", "Clock In", "Clock Out", "Lunch (Minutes)", "Hours", "Miles Logged", "Note"]);
    const shifts = ppl.rows.slice(shiftAt + 3, ppl.rows.findIndex((r, i) => i > shiftAt && r.cells[0] === "Total Hours"));
    // Q2's shifts only, in day order, in the company's clock (10 AM Chicago), the owner's among them.
    expect(shifts.map((r) => [r.cells[0], (r.cells[1] as any).date, r.cells[2], r.cells[3], r.cells[5], r.cells[6]])).toEqual([
      ["Sam Rivera", "2026-04-06", "10:00 AM", "6:00 PM", 8, 0],
      ["Dana Pinecrest", "2026-04-07", "10:00 AM", "7:00 PM", 9, 40],
      ["Lee Okafor", "2026-05-12", "10:00 AM", "3:00 PM", 5, 0],
      ["Dana Pinecrest", "2026-05-20", "10:00 AM", "5:00 PM", 7, 0],
      ["Sam Rivera", "2026-06-08", "10:00 AM", "6:00 PM", 8, 30],
      ["Sam Rivera", "2026-06-09", "10:00 AM", "4:00 PM", 6, 25],
    ]);
    // Hours only: no shift row carries money, so nothing here can argue with Earned.
    for (const r of shifts) expect(r.cells.map(cents).filter((c) => c != null)).toEqual([]);
    expect(rowOf(ppl, "Total Hours")!.cells[5]).toBe(43); // 8 + 9 + 5 + 7 + 8 + 6, the owner's included

    const lockAt = ppl.rows.findIndex((r) => r.cells[0] === "Pay Periods Locked");
    expect(ppl.rows[lockAt + 2].cells).toEqual(["Person", "From", "To", "Gross Frozen"]);
    expect(ppl.rows[lockAt + 3].cells).toEqual(["Sam Rivera", { date: "2026-04-01" }, { date: "2026-04-15" }, { money: 320 }]);
  });

  it("Open: the bills and the supplier's own invoices behind what suppliers say is owed", () => {
    const open = tab(wb, "Open");
    const at = open.rows.findIndex((r) => r.cells[0] === "Bills North Has Marked Unpaid");
    expect(open.rows[at + 2].cells).toEqual(["Date", "Supplier", "Bill Number", "Amount", "Supplier Account", "Job"]);
    const bills = open.rows.slice(at + 3, open.rows.findIndex((r, i) => i > at && r.cells[0] === "Total"));
    // The two unpaid Northline tickets — all time, as of the download day, not just this period.
    expect(bills.map((r) => [r.cells[2], cents(r.cells[3]), r.cells[4], r.cells[5]])).toEqual([
      ["NS-100", 60000, "Northline Supply", "Maple Court Remodel"],
      ["NS-120", 120000, "Northline Supply", "Birch Street Service"],
    ]);
    // $1,800 of tickets less the $500 sent is the $1,300 the supplier figure above says.
    expect(cents(open.rows.slice(at).find((r) => r.cells[0] === "Total")!.cells[3])).toBe(180000);
    const docsAt = open.rows.findIndex((r) => r.cells[0] === "What Each Supplier's Own Invoices Say Is Still Open");
    expect(docsAt).toBeGreaterThan(at);
    expect(open.rows[docsAt + 3].cells[0]).toBe("No supplier has an open document of its own on the books.");
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
  /** The owner's lines of the profit and loss: every one a total, a profit or Revenue. */
  const OWNER_LABELS = ["Revenue", "Other Income (Inside Revenue)", "Total COGS", "Gross Profit", "Gross Margin %", "Total Overhead", NET_LABEL];

  it("has no Net Profit anywhere and no owner rows, and says so", () => {
    const texts = everyText(wb);
    expect(texts).not.toContain(NET_LABEL);
    expect(texts.some((s) => s.includes("Dana Pinecrest"))).toBe(false);
    expect(texts.some((s) => s.startsWith("Owner Hours"))).toBe(false);
    expect(texts).toContain(OWNER_HIDDEN_NOTE);
    expect(OWNER_HIDDEN_NOTE).toBe("The totals are the owner's.");
    expect(texts).not.toContain(BEFORE_TAX_NOTE);
    expect(wb.figures).toEqual({ revenue: null, grossProfit: null, net: null });
    // The itemized tabs stay: the office already sees those records in the app.
    expect(rowOf(tab(wb, "People"), "Sam Rivera")).toBeTruthy();
    expect(rowOf(tab(wb, "Income"), "Payments")).toBeTruthy();
    // And the files built from it carry no Net Profit, Gross Profit or total either.
    const csv = unzip(workbookCsvZip(wb)).map((e) => text(e.data)).join("\n");
    const xml = unzip(workbookXlsx(wb)).map((e) => text(e.data)).join("\n");
    for (const file of [csv, xml]) for (const gone of ["Net Profit", "Gross Profit", "Gross Margin", "Total COGS", "Total Overhead"]) expect(file, gone).not.toContain(gone);
  });

  it("the Summary is the cost rows one by one under their two headings, and no figure a subtraction from the bottom line", () => {
    const summary = tab(wb, "Summary");
    const labels = summary.rows.map((r) => r.cells[0]);
    for (const gone of [...OWNER_LABELS, "Owner Hours (not pay)"]) expect(labels, gone).not.toContain(gone);
    // The cost rows stay, one by one, each with its months, the period, the period before and the change.
    const officeLines = summaryLines({ hasOtherIncome: true, showOwner: false });
    const costRows = officeLines.filter((l) => l.kind === "cost");
    expect(costRows).toHaveLength(12);
    for (const l of costRows) expect(rowOf(summary, l.label)!.cells.slice(1, 5).map(cents), l.label).toEqual([...cur.months.map((m) => l.cents(m)), l.cents(cur.totals)]);
    // The table is the two headings and their cost rows and nothing else, then the owner's note.
    const header = summary.rows.findIndex((r) => r.bold && r.cells[0] === "");
    const table = summary.rows.slice(header + 1, header + 1 + officeLines.length);
    expect(table.map((r) => r.cells[0])).toEqual([
      "Cost of Goods Sold (COGS)",
      "Materials & Bills",
      STOCK_BOUGHT_LABEL,
      STOCK_LOST_LABEL,
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
    expect(summary.rows[header + 1 + officeLines.length].cells).toEqual([OWNER_HIDDEN_NOTE]);
    // The headings carry no figure, and neither half is added up anywhere on the tab.
    const own = profitAndLoss(cur.totals);
    const secret = (k: Parameters<typeof pnlRow>[1]) => pnlRow(own, k)!.cents!;
    const moneyInTab = summary.rows.flatMap((r) => r.cells.slice(1).map(cents)).filter((c): c is number => c != null);
    for (const k of ["revenue", "total_cogs", "gross_profit", "total_overhead", "net_profit"] as const) expect(moneyInTab, k).not.toContain(secret(k));
  });

  it("no tab carries a bottom-line figure: no Revenue row on Income, and Revenue, the totals and Net Profit are nowhere in the file", () => {
    const own = profitAndLoss(cur.totals);
    const at = (k: Parameters<typeof pnlRow>[1]) => pnlRow(own, k)!.cents!;
    const allCosts = at("total_cogs") + at("total_overhead");
    const secrets = [at("revenue"), at("total_cogs"), at("gross_profit"), at("total_overhead"), at("net_profit"), allCosts];
    // The fixture keeps them apart from each other and from every list's own sum, so a hit here is a real leak.
    expect(new Set(secrets).size).toBe(secrets.length);
    for (const t of wb.tabs) {
      const labels = t.rows.map((r) => r.cells[0]);
      for (const gone of [...OWNER_LABELS, "Received", "Total Costs"]) expect(labels, `${t.name}: ${gone}`).not.toContain(gone);
      const moneyCells = t.rows.flatMap((r) => r.cells.map(cents)).filter((c): c is number => c != null);
      for (const secret of secrets) expect(moneyCells, `${t.name}: ${secret}`).not.toContain(secret);
    }
    // The owner's own download still has it, to the cent.
    const ownIncome = tab(buildAccountantWorkbook(input()), "Income");
    expect(cents(rowOf(ownIncome, "Revenue")!.cells[6])).toBe(toCents(cur.totals.received));
    // And no line in the office's file points to a Revenue it doesn't carry.
    expect(everyText(wb).some((s) => /\bin (Revenue|Received)\b/.test(s))).toBe(false);
  });

  it("the page's words say what the file leaves out and what it keeps, and the file keeps its word", () => {
    expect(OWNER_HIDDEN_WHY).toContain(
      "Revenue, Total COGS, Gross Profit and Gross Margin %, Total Overhead, Net Profit, the owner's own build time and his Owner's Draw are left out, here and in the file",
    );
    // The lists stay with their own totals: said, not promised away.
    expect(OWNER_HIDDEN_WHY).toContain("with each list's own total");
    expect(rowOf(tab(wb, "Income"), "Payments")).toBeTruthy();
    expect(rowOf(tab(wb, "People"), "Crew Total")).toBeTruthy();
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

describe("the supplier's own invoices list reconciles to the figure above it, to the cent", () => {
  /** A supplier document as PostgREST hands it over: snake_case, `open_balance` null when none was recorded. */
  const doc = (id: string, number: string, kind: string, on: string, total: number, openBalance: number | null, closed = false) => ({
    id,
    supplier_account_id: "a1",
    invoice_number: number,
    kind,
    invoice_date: on,
    created_at: `${on}T15:00:00Z`,
    total,
    open_balance: openBalance,
    closed,
  });
  const withDocs = (): OwnerMoneyInputs => {
    const m = money();
    m.supplierDocuments = [
      doc("sd1", "8802-1107230", "invoice", "2026-09-10", 2000, 2000),
      // The one the list used to drop: a credit memo the supplier has not closed, carrying a NEGATIVE
      // open balance. The balance above subtracts it, so leaving it out made the list the larger number.
      doc("sd2", "8802-1108648", "credit_memo", "2026-09-12", -225.47, -225.47),
      doc("sd3", "8802-1109001", "invoice", "2026-09-15", 800, 300), // part-paid
      doc("sd4", "8802-1105000", "invoice", "2026-08-01", 450, null), // from before North recorded a balance
      doc("sd5", "8802-1104000", "invoice", "2026-07-01", 610, 0), // open paper with nothing left on it
      doc("sd6", "8802-1103000", "invoice", "2026-06-01", 990, 990, true), // closed
    ];
    return m;
  };
  const m = withDocs();
  const wb = buildAccountantWorkbook(input({ money: m }));
  const open = tab(wb, "Open");
  const docsAt = open.rows.findIndex((r) => r.cells[0] === "What Each Supplier's Own Invoices Say Is Still Open");
  const docTotal = open.rows.slice(docsAt).find((r) => r.cells[0] === "Total")!;
  const docRows = open.rows.slice(docsAt + 3, open.rows.indexOf(docTotal));

  it("lists every open document, a credit memo as a negative, and totals exactly what supplierBalance says", () => {
    const acct = supplierAccountRowsOf(m, TZ).get("a1")!;
    const bal = supplierBalance(acct, TODAY);
    // Northline now sends its own paper, so the account is read the supplier's way.
    expect(bal.model).toBe("supplier-invoices");
    // 2,000 less the 225.47 memo plus 300 left on the part-paid ticket plus the 450 paper with no
    // balance recorded = 2,524.53, and that is the itemized Total AND the figure above it.
    expect(cents(docTotal.cells[5])).toBe(252453);
    expect(cents(docTotal.cells[5])).toBe(toCents(bal.owed!));
    const owedAt = open.rows.findIndex((r) => r.cells[0] === "Suppliers Say You Owe");
    const owedTotal = open.rows.slice(owedAt).find((r) => r.cells[0] === "Total")!;
    expect(cents(owedTotal.cells[1])).toBe(cents(docTotal.cells[5]));

    expect(docRows.map((r) => [r.cells[2], r.cells[3], cents(r.cells[4]), cents(r.cells[5])])).toEqual([
      ["8802-1105000", "Invoice (No Balance Recorded)", 45000, 45000],
      ["8802-1107230", "Invoice", 200000, 200000],
      ["8802-1108648", "Credit Memo", -22547, -22547],
      ["8802-1109001", "Invoice", 80000, 30000],
    ]);
  });

  it("says a paper with no balance recorded IS counted above, and never the opposite", () => {
    const texts = everyText(wb);
    expect(texts.some((s) => s.includes("doesn't count it"))).toBe(false);
    expect(texts.some((s) => s.includes("No Balance Recorded") && s.includes("counts it the same way, in full"))).toBe(true);
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
    expect(cents(rowOf(s, "Revenue")!.cells[5])).toBe(422000);
    expect(cents(rowOf(s, NET_LABEL)!.cells[5])).toBe(toCents(soFar.totals.left));
    // The so-far column is a profit and loss too: its Gross Profit less its Overhead is its net.
    const col5 = (label: string) => cents(rowOf(s, label)!.cells[5])!;
    expect(col5("Revenue") - col5("Total COGS")).toBe(col5("Gross Profit"));
    expect(col5("Gross Profit") - col5("Total Overhead")).toBe(toCents(soFar.totals.left));
    expect(s.rows.some((r) => String(r.cells[0]).startsWith("Change So Far compares 2026 Q3 through 2026-09-27 with the same days of 2026 Q2"))).toBe(true);
  });

  it("the default, this year: 2025 through Sep 27", () => {
    const s = tab(buildAccountantWorkbook(input({ period: periodFromKey("2026")! })), "Summary");
    const head = s.rows.find((r) => r.cells[0] === "" && r.bold)!.cells;
    expect(head.slice(-3)).toEqual(["Total 2026", "2025 Through Sep 27", "Change So Far"]);
  });
});

describe("a period before North's records says so, never a silent $0.00", () => {
  it("the page's line and the file's note, when every figure is zero", () => {
    const y2025 = periodFromKey("2025")!;
    const f2025 = computeOwnerMoney(money(), periodWindow(y2025), TZ, TODAY).totals;
    expect(beforeRecordsLine(y2025, "2026-02-03", f2025)).toEqual({ text: "North has no records before Feb 3, 2026, so 2025 has nothing in it.", nothing: true });
    const fQ2 = computeOwnerMoney(money(), periodWindow(Q2), TZ, TODAY).totals;
    expect(beforeRecordsLine(Q2, "2026-02-03", fQ2)).toBeNull();
    expect(beforeRecordsLine(Q2, null, fQ2)).toBeNull();
    const s = tab(buildAccountantWorkbook(input({ period: y2025 })), "Summary");
    expect(s.rows.map((r) => r.cells[0])).toContain("North has no records before Feb 3, 2026, so 2025 has nothing in it.");
  });

  it("a receipt dated before the records still counts: the figures show, and it never says 'nothing in it'", () => {
    // Records start with the first payment or shift; a bill is never a start (a receipt entered later
    // with an older date counts in its own month). The fixture's $40 Fuel ticket is dated Mar 3.
    const m = money();
    m.recordsStart = "2026-04-01";
    const march = periodFromKey("2026-03")!;
    const f = computeOwnerMoney(m, periodWindow(march), TZ, TODAY).totals;
    expect(f).toMatchObject({ received: 0, fuel: 40, left: -40 });
    const line = beforeRecordsLine(march, "2026-04-01", f)!;
    expect(line.nothing).toBe(false); // the page shows Revenue and Net Profit, with this line under them
    expect(line.text).not.toContain("nothing in it");
    expect(line.text).toBe("North's records start Apr 1, 2026. What March 2026 shows was dated before then (a receipt entered later still counts in its own month).");
    const s = tab(buildAccountantWorkbook(input({ period: march, money: m })), "Summary");
    const texts = s.rows.map((r) => String(r.cells[0] ?? ""));
    expect(texts.some((t) => t.includes("nothing in it"))).toBe(false);
    expect(texts).toContain(line.text);
    expect(cents(rowOf(s, "Fuel")!.cells[1])).toBe(4000);
    expect(cents(rowOf(s, NET_LABEL)!.cells[1])).toBe(-4000);
  });

  it("nothing in it means nothing: any figure, owner hours included, is something", () => {
    const zero = computeOwnerMoney(money(), periodWindow(periodFromKey("2025")!), TZ, TODAY).totals;
    expect(nothingInFigures(zero)).toBe(true);
    expect(nothingInFigures({ ...zero, ownerHours: 2 })).toBe(false);
    expect(nothingInFigures({ ...zero, businessCosts: { ...zero.businessCosts, Auto: 12 } })).toBe(false);
    expect(nothingInFigures({ ...zero, crewPay: 0.01 })).toBe(false);
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
    expect(tabCsv(tab(wb, "Summary"))).toContain("Net Profit,");
    expect(tabCsv(tab(wb, "Summary"))).toContain("Gross Margin %,");
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
    const summary = parts.get("xl/worksheets/sheet1.xml")!;
    expect(summary).toMatch(/<c r="A5" t="inlineStr" s="1"><is><t xml:space="preserve">Revenue<\/t><\/is><\/c>/);
    expect(summary).toMatch(/<c r="E5" s="3"><v>4170<\/v><\/c>/); // Revenue, the quarter: a bold figure
    // The line under it is indented, its money plain.
    expect(summary).toMatch(/<c r="A6" t="inlineStr" s="6"><is><t xml:space="preserve">Other Income \(Inside Revenue\)<\/t><\/is><\/c>/);
    expect(summary).toMatch(/<c r="E6" s="2"><v>120<\/v><\/c>/);
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
    // A bookmarked month older than the list (parseAccountantPeriod takes 20 years): it is among the
    // choices, in date order, so the picker shows the month the page and the file are.
    const may2024 = parseAccountantPeriod("2024-05", TODAY)!;
    const withOld = periodChoices("month", TODAY, may2024).map((p) => p.key);
    expect(withOld).toHaveLength(25);
    expect(withOld[0]).toBe("2026-09");
    expect(withOld.at(-1)).toBe("2024-05");
    expect(periodChoices("month", TODAY, periodFromKey("2026-03")).map((p) => p.key)).toEqual(periodChoices("month", TODAY).map((p) => p.key));
    expect(periodChoices("quarter", TODAY, periodFromKey("2019-Q2")).map((p) => p.key).at(-1)).toBe("2019-Q2");
    expect(periodChoices("year", TODAY, periodFromKey("2010")).map((p) => p.key)).toEqual(["2026", "2025", "2024", "2023", "2022", "2021", "2010"]);
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
