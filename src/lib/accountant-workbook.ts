import { BUSINESS_COST_BUCKETS, namesABucket } from "@/lib/business-cost-buckets";
import {
  computeOwnerMoney,
  countedNotPaidLine,
  crewPayByMonth,
  notCountedLine,
  balanceEntries,
  ownerMoneyCostLines,
  ownerMoneyReadSpan,
  recordDay,
  supplierAccountRowsOf,
  windowMonths,
  type OwnerMoney,
  type OwnerMoneyCostLine,
  type OwnerMoneyCostTarget,
  type OwnerMoneyFigures,
  type OwnerMoneyInputs,
  type OwnerMoneyWindow,
} from "@/lib/analytics/owner-money";
import { computeArAging, computeCollected, computeCustomerValue, monthKeyInTz } from "@/lib/analytics/money-metrics";
import { collectedByJob } from "@/lib/analytics/job-profitability";
import { HEADERS, onHandList, toCsv, toolsBilledList, toolsList, type AccountantInputs, type Cell, type CsvTable } from "@/lib/accountant-lists";
import { summarizeSalesTax } from "@/lib/sales-tax";
import { balanceForPerson, sumPayments, toPayPaymentRow, type PayPaymentRow } from "@/lib/payroll-math";
import { summarizeMileage } from "@/lib/mileage-math";
import { formatCurrency, hoursBetween } from "@/lib/utils";
import { isOnAccountBill, supplierBalance } from "@/app/(app)/bills/supplier-balance";
import { buildXlsx, type XlsxRow, type XlsxSheet, type XlsxValue } from "@/lib/xlsx-write";
import { buildZip, type DeflateRaw } from "@/lib/zip-write";

/**
 * ONE DOWNLOAD FOR YOUR ACCOUNTANT (approved 2026-09-27).
 *
 * Erik: an accountant doesn't need several versions of a stock download; "exporting real analytics
 * for everything compared i can see that being used, stock and inventory is minimal with
 * contractors". So the four stock lists became one workbook for a whole month, quarter or year,
 * six tabs, every figure from the engine that already shows it in the app:
 *
 *   Summary  Money by Month's own figures (computeOwnerMoney), month by month, the period's total,
 *            the period before and the change. Every business-cost bucket on its own row, read from
 *            BUSINESS_COST_BUCKETS, so a new bucket (Fuel and Auto, 0362) shows up by itself. The
 *            bottom line is named exactly "Net Profit (before income tax)" (Erik's answer 2).
 *   Income   every payment (computeCollected's rows: the same read), by customer
 *            (computeCustomerValue), by job (collectedByJob, job profit's cash rule) and by method;
 *            sales tax only when the company has it switched on, labeled billed basis.
 *   Costs    every cost line Money by Month adds up (ownerMoneyCostLines), what was paid to each
 *            supplier (supplierBalance), and the tools lists (depreciation is the accountant's call).
 *   People   earned (the frozen-gross rule), paid, still owed (balanceForPerson), paid this calendar
 *            year; MILES AS MILES, never dollars; the owner's HOURS, never pay.
 *   Open     what customers owe (computeArAging) and what suppliers say is owed (supplierBalance),
 *            AS OF THE DOWNLOAD DAY, with that date printed (Erik's answer 1).
 *   Stock    what was in stock on the period's last day, roll by roll (onHandList).
 *
 * THE OWNER'S SWITCH: when the owner has not shared Owner's Draw with the office
 * (office_sees_owner_money), the bottom line is the owner's. An office download then carries NO
 * bottom-line figure at all: no Received total, no Total Costs, no Net, no change on them, and no
 * owner rows; the Summary keeps the cost rows one by one and says "The totals are the owner's." The
 * itemized tabs stay (the office already sees those records in the app).
 *
 * A PERIOD NOT OVER YET is compared with the SAME DAYS of the period before ("2025 Through Sep 27"),
 * never with the whole of it, and its Change column says "So Far".
 *
 * Pure: the route reads, this builds. Every sum is in integer cents.
 */

// ── Periods: whole months only ───────────────────────────────────────────────

export type AccountantPeriodKind = "month" | "quarter" | "year";
export type AccountantPeriod = {
  kind: AccountantPeriodKind;
  /** "2026-09", "2026-Q3" or "2026": what ?period= carries. */
  key: string;
  /** "September 2026", "2026 Q3", "2026". */
  label: string;
  /** What the file is named by: "2026-09", "2026 Q3", "2026". */
  fileLabel: string;
  /** Org-local days: start inclusive, end exclusive. */
  start: string;
  end: string;
};

export const PERIOD_KINDS: { kind: AccountantPeriodKind; label: string }[] = [
  { kind: "month", label: "Month" },
  { kind: "quarter", label: "Quarter" },
  { kind: "year", label: "Year" },
];

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const firstOf = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

function makePeriod(kind: AccountantPeriodKind, y: number, n: number): AccountantPeriod {
  if (kind === "year") return { kind, key: String(y), label: String(y), fileLabel: String(y), start: `${y}-01-01`, end: `${y + 1}-01-01` };
  if (kind === "quarter") {
    const m = (n - 1) * 3 + 1;
    return { kind, key: `${y}-Q${n}`, label: `${y} Q${n}`, fileLabel: `${y} Q${n}`, start: firstOf(y, m), end: firstOf(y, m + 3) };
  }
  const key = `${y}-${String(n).padStart(2, "0")}`;
  return { kind, key, label: `${MONTH_NAMES[n - 1]} ${y}`, fileLabel: key, start: firstOf(y, n), end: firstOf(y, n + 1) };
}

/** The period a key names, or null. Shape only; parseAccountantPeriod also checks it is not future. */
export function periodFromKey(v: unknown): AccountantPeriod | null {
  if (typeof v !== "string") return null;
  let m = /^(\d{4})$/.exec(v);
  if (m) return makePeriod("year", Number(m[1]), 1);
  m = /^(\d{4})-Q([1-4])$/.exec(v);
  if (m) return makePeriod("quarter", Number(m[1]), Number(m[2]));
  m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(v);
  if (m) return makePeriod("month", Number(m[1]), Number(m[2]));
  return null;
}

/** The period of `kind` holding the org-local day `ymd`. */
export function periodContaining(kind: AccountantPeriodKind, ymd: string): AccountantPeriod {
  const [y, m] = ymd.split("-").map(Number);
  if (kind === "year") return makePeriod("year", y, 1);
  if (kind === "quarter") return makePeriod("quarter", y, Math.floor((m - 1) / 3) + 1);
  return makePeriod("month", y, m);
}

/** How far back a download may reach: the books of twenty years, and never a period not begun. */
const YEARS_BACK = 20;

/** A ?period= value as a period the download may cover: real, begun by the org's today, and not
 *  more than twenty years back. Anything else is null (the page falls back, the route refuses). */
export function parseAccountantPeriod(v: unknown, todayYmd: string): AccountantPeriod | null {
  const p = periodFromKey(v);
  if (!p) return null;
  if (p.start > todayYmd) return null;
  if (Number(p.start.slice(0, 4)) < Number(todayYmd.slice(0, 4)) - YEARS_BACK) return null;
  return p;
}

/** The page opens on this year: the same window the Owner's Draw card opens on. */
export function defaultAccountantPeriod(todayYmd: string): AccountantPeriod {
  return periodContaining("year", todayYmd);
}

/** The period just before, of the same kind. */
export function previousPeriod(p: AccountantPeriod): AccountantPeriod {
  const day = new Date(Date.parse(`${p.start}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return periodContaining(p.kind, day);
}

/** The periods the page offers, newest first: 24 months, 8 quarters or 6 years. */
export function periodChoices(kind: AccountantPeriodKind, todayYmd: string): AccountantPeriod[] {
  const count = kind === "month" ? 24 : kind === "quarter" ? 8 : 6;
  const out: AccountantPeriod[] = [periodContaining(kind, todayYmd)];
  while (out.length < count) out.push(previousPeriod(out[out.length - 1]));
  return out;
}

/** The period as Money by Month's window. */
export function periodWindow(p: AccountantPeriod): OwnerMoneyWindow {
  return { key: "period", label: p.label, start: p.start, end: p.end };
}

/** What the page AND the route read for a period: the period and the one before it, in one span.
 *  The same span on both, so the page's figures are the file's to the cent. */
export function accountantReadSpan(p: AccountantPeriod): { start: string; end: string } {
  return ownerMoneyReadSpan([periodWindow(p), periodWindow(previousPeriod(p))]);
}

/**
 * THE SAME DAYS OF THE PERIOD BEFORE, for a period not over yet: as many months into it as today is
 * into this one, on today's day of the month (the last day of a shorter month). 2026 on Sep 27 is
 * compared with 2025 through Sep 27; September 27 with August 27; Q3 on Sep 27 with Q2 through
 * Jun 27. Null when the period is over: then the whole period before is the comparison.
 */
export function comparisonThrough(p: AccountantPeriod, todayYmd: string): string | null {
  if (p.end <= todayYmd) return null;
  const before = previousPeriod(p);
  const [py, pm] = p.start.split("-").map(Number);
  const [ty, tm, td] = todayYmd.split("-").map(Number);
  const into = (ty - py) * 12 + (tm - pm);
  const [by, bm] = before.start.split("-").map(Number);
  const lastOfMonth = new Date(Date.UTC(by, bm - 1 + into + 1, 0));
  const day = new Date(Date.UTC(lastOfMonth.getUTCFullYear(), lastOfMonth.getUTCMonth(), Math.min(td, lastOfMonth.getUTCDate()))).toISOString().slice(0, 10);
  const lastBefore = new Date(Date.parse(`${before.end}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return day < lastBefore ? day : lastBefore;
}

/** The period's last day, or today when the period isn't over yet. */
export function lastDayShown(p: AccountantPeriod, todayYmd: string): string {
  const last = new Date(Date.parse(`${p.end}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return last < todayYmd ? last : todayYmd;
}

// ── Names ────────────────────────────────────────────────────────────────────

/** The bottom line's name, exactly (Erik's answer 2, 2026-09-27). */
export const NET_LABEL = "Net Profit (before income tax)";
export const STOCK_BOUGHT_LABEL = "Stock Bought";
export const STOCK_LOST_LABEL = "Stock Lost (Written Off, Counted Short, Returned)";
export const TAB_NAMES = ["Summary", "Income", "Costs", "People", "Open", "Stock"] as const;
/** What an office download's Summary says when the owner hasn't shared Owner's Draw (never a total). */
export const OWNER_HIDDEN_NOTE = "The totals are the owner's.";
/** The page's line for that office viewer: why, and what the file leaves out. Never shown to the owner. */
export const OWNER_HIDDEN_WHY =
  "The owner hasn't shared Owner's Draw with the office, so the Summary's totals (Received, Total Costs and Net) and the owner's own rows are left out, here and in the file.";
/** The People tab's line for that office viewer. */
export const OWNER_ROWS_HIDDEN_NOTE = "The owner's own row is left out: the totals are the owner's.";

/** Half of a character: a surrogate with no partner. Never valid text, and encodeURIComponent throws on it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A company's name as a file name: no path or header characters, no control characters, one space
 *  between words, 80 characters at most, counted as characters so an emoji is never cut in half.
 *  A blank one is "North". */
export function fileSafeName(raw: string | null | undefined): string {
  const s = String(raw ?? "")
    .normalize("NFC")
    .replace(LONE_SURROGATE, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[\\/:*?"<>|;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const cut = Array.from(s).slice(0, 80).join("").trim();
  return cut || "North";
}

/** "ET Electric 2026 Q3.xlsx", "ET Electric 2026-09 CSV.zip". */
export function accountantFileName(company: string | null | undefined, p: AccountantPeriod, as: "xlsx" | "csv"): string {
  return `${fileSafeName(company)} ${p.fileLabel}${as === "xlsx" ? ".xlsx" : " CSV.zip"}`;
}

// ── The workbook ─────────────────────────────────────────────────────────────

export type AccountantWorkbookInput = {
  company: string | null;
  period: AccountantPeriod;
  tz: string;
  /** The org-local day of the download: what Open is as of, and printed on it. */
  todayYmd: string;
  /** The owner, or an office viewer the owner has shared Owner's Draw with. */
  showOwner: boolean;
  /** readOwnerMoneyInputs over a span covering this period and the one before. */
  money: OwnerMoneyInputs;
  /** readAccountantInputs: stock, tools, jobs. */
  lists: AccountantInputs;
  /** False before 0303 (no stock in this database). */
  shelf: boolean;
  /** Every invoice not paid, void or draft: id, customer_id, invoice_number, status, total,
   *  amount_paid, due_date, customers(name). */
  arInvoices: any[];
  /** Null when Sales Tax is switched off. Invoices created in the period (SALES_TAX_INVOICE_COLS). */
  salesTax: { invoices: any[]; taxRates: any[] } | null;
};

export type AccountantWorkbook = {
  tabs: XlsxSheet[];
  /** The page's two figures. Both null when the viewer may not see the totals (the owner's switch). */
  figures: { received: number | null; net: number | null };
};

type Row = XlsxRow;
const title = (s: string): Row => ({ cells: [s], bold: true });
const note = (s: string): Row => ({ cells: [s] });
const blank = (): Row => ({ cells: [] });
const head = (...cells: XlsxValue[]): Row => ({ cells, bold: true });
const line = (...cells: XlsxValue[]): Row => ({ cells });
const total = (...cells: XlsxValue[]): Row => ({ cells, bold: true });
const cents = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
};
const money = (c: number): XlsxValue => ({ money: c / 100 });
const date = (ymd: string | null | undefined): XlsxValue => (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? { date: ymd } : null);
const shortMonth = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1].slice(0, 3)} ${m.slice(0, 4)}`;
/** "Sep 27" from "2025-09-27". */
const shortDay = (ymd: string) => `${MONTH_NAMES[Number(ymd.slice(5, 7)) - 1].slice(0, 3)} ${Number(ymd.slice(8, 10))}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A CsvTable (the stock and tools lists) as sheet rows: its header bold, its Total rows bold, the
 *  money columns as money and the date columns as dates. */
function tableRows(t: CsvTable, moneyCols: number[], dateCols: number[]): Row[] {
  const firstTotal = t.rows.length - (t.summaryRows ?? 0);
  return [
    head(...t.header),
    ...t.rows.map((r, i) => ({
      cells: r.map((v, c) => {
        if (v == null) return null;
        if (moneyCols.includes(c) && typeof v === "number") return { money: v };
        if (dateCols.includes(c) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v };
        return v;
      }),
      bold: i >= firstTotal,
    })),
  ];
}

const targetLabel = (to: OwnerMoneyCostTarget): string =>
  to === "materials" ? "Materials & Bills" : to === "stock" ? STOCK_BOUGHT_LABEL : to === "stock_lost" ? STOCK_LOST_LABEL : to;

const methodLabel = (m: unknown): string => {
  const s = String(m ?? "").trim();
  if (!s) return "Not Recorded";
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
};

/** A stored category, unless it only repeats a bucket's name (Goes To already says it; a stored
 *  "Gas & Truck" would contradict its Auto). */
const categoryWords = (c: unknown): string | null => {
  const s = String(c ?? "").trim();
  return s && !namesABucket(s) ? s : null;
};

const STOCK_MOVE_WORDS: Record<string, string> = {
  write_off: "Written off",
  recount_down: "Counted short",
  supplier_return: "Returned to the supplier",
};

export function buildAccountantWorkbook(input: AccountantWorkbookInput): AccountantWorkbook {
  const { period, tz, todayYmd, showOwner, money: inp, lists } = input;
  const win = periodWindow(period);
  const prevPeriod = previousPeriod(period);
  const cur = computeOwnerMoney(inp, win, tz, todayYmd);
  // A period not over yet is compared with the same days of the one before, never all of it.
  const prevThrough = comparisonThrough(period, todayYmd);
  const prev = computeOwnerMoney(inp, periodWindow(prevPeriod), tz, todayYmd, prevThrough ? { throughDay: prevThrough } : {});
  const months = new Set(windowMonths(win, todayYmd));
  const through = lastDayShown(period, todayYmd);
  const unfinished = period.end > todayYmd;
  const jobs = new Map(lists.jobs.map((j) => [String(j.id), j]));

  const open = openFigures(input);
  const stock = input.shelf ? onHandList(lists, through, tz) : null;

  const tabs: XlsxSheet[] = [
    summaryTab(input, cur, prev, prevPeriod, prevThrough, open, stock, through, unfinished),
    incomeTab(input, cur, months, jobs),
    costsTab(input, cur, months, jobs, through),
    peopleTab(input, cur, months, through),
    openTab(input, open),
    stockTab(input, stock, through),
  ];
  return { tabs, figures: showOwner ? { received: cur.totals.received, net: cur.totals.left } : { received: null, net: null } };
}

/** What the page says instead of $0.00 for a period that ends before North's records begin. */
export function beforeRecordsLine(p: AccountantPeriod, recordsStart: string | null | undefined): string | null {
  if (!recordsStart || recordsStart < p.end) return null;
  return `North has no records before ${shortDay(recordsStart)}, ${recordsStart.slice(0, 4)}, so ${p.label} has nothing in it.`;
}

// ── Summary ──────────────────────────────────────────────────────────────────

type SummaryLine = { label: string; of: (f: OwnerMoneyFigures) => number; cost?: boolean };

/** The Summary's rows in order, from BUSINESS_COST_BUCKETS for the buckets (Fuel on its own). */
export function summaryLines(hasOtherIncome: boolean): SummaryLine[] {
  return [
    { label: "Received", of: (f) => f.received },
    ...(hasOtherIncome ? [{ label: "Other Income (Inside Received)", of: (f: OwnerMoneyFigures) => f.otherIncome ?? 0 }] : []),
    { label: "Materials & Bills", of: (f) => f.materialsAndBills, cost: true },
    { label: "Crew Pay (1099)", of: (f) => f.crewPay, cost: true },
    { label: "Crew Mileage Paid", of: (f) => f.crewMileagePaid, cost: true },
    ...BUSINESS_COST_BUCKETS.map((b) => ({
      label: b as string,
      of: (f: OwnerMoneyFigures) => (b === "Fuel" ? f.fuel : (f.businessCosts as Record<string, number>)[b] ?? 0),
      cost: true,
    })),
    { label: STOCK_BOUGHT_LABEL, of: (f) => f.putOnShelf, cost: true },
    { label: STOCK_LOST_LABEL, of: (f) => f.shopStockLost, cost: true },
  ];
}

function summaryTab(
  input: AccountantWorkbookInput,
  cur: OwnerMoney,
  prev: OwnerMoney,
  prevPeriod: AccountantPeriod,
  prevThrough: string | null,
  open: OpenFigures,
  stock: CsvTable | null,
  through: string,
  unfinished: boolean,
): XlsxSheet {
  const { period, showOwner } = input;
  const byMonth = period.kind !== "month";
  const hasOther = [cur.totals, prev.totals].some((f) => Math.abs(f.otherIncome ?? 0) >= 0.005);
  // THE OWNER'S SWITCH: an office viewer the owner hasn't shared Owner's Draw with gets the cost rows
  // one by one and no total at all (no Received, no Total Costs, no Net): the totals are the owner's.
  const lines = summaryLines(hasOther).filter((l) => showOwner || l.cost);
  const cols = (f: (x: OwnerMoneyFigures) => number): XlsxValue[] => {
    const now = cents(f(cur.totals));
    const before = cents(f(prev.totals));
    return [...(byMonth ? cur.months.map((m) => money(cents(f(m)))) : []), money(now), money(before), money(now - before)];
  };
  const costCents = (x: OwnerMoneyFigures) => lines.filter((l) => l.cost).reduce((s, l) => s + cents(l.of(x)), 0);
  // A period not over yet: the period before through the same day, and the change so far.
  const prevHead = prevThrough ? `${prevPeriod.label} Through ${shortDay(prevThrough)}` : prevPeriod.label;
  const changeHead = prevThrough ? "Change So Far" : "Change";
  const rows: Row[] = [
    title(`${fileSafeName(input.company)}: For Your Accountant, ${period.label}`),
    note(`Cash basis: money counts on the day it came in or went out.${unfinished ? ` The period isn't over: figures run through ${through}.` : ""} Downloaded ${input.todayYmd}.`),
    blank(),
    head("", ...(byMonth ? cur.months.map((m) => shortMonth(m.month)) : []), `Total ${period.label}`, prevHead, changeHead),
  ];
  for (const l of lines) rows.push(line(l.label, ...cols(l.of)));
  if (showOwner) {
    rows.push(total("Total Costs", ...cols((x) => costCents(x) / 100)));
    rows.push(total(NET_LABEL, ...cols((x) => x.left)));
    const hours = (x: OwnerMoneyFigures) => round2(x.ownerHours);
    rows.push(line("Owner Hours (not pay)", ...(byMonth ? cur.months.map(hours) : []), hours(cur.totals), hours(prev.totals), round2(cur.totals.ownerHours - prev.totals.ownerHours)));
  } else {
    rows.push(note(OWNER_HIDDEN_NOTE));
  }

  rows.push(blank(), head(`Open As Of ${input.todayYmd}`, "Amount"));
  rows.push(line("Customers Owe You", money(open.customersCents)));
  rows.push(line("Suppliers Say You Owe", money(open.suppliersCents)));
  if (stock) rows.push(line(`In Stock At The End Of ${through}`, money(cents(stock.total ?? 0))));

  rows.push(blank());
  if (prevThrough) {
    rows.push(note(`${changeHead} compares ${period.label} through ${input.todayYmd} with the same days of ${prevPeriod.label} (through ${prevThrough}), not the whole of it.`));
  }
  if (open.ahead.length) {
    const aheadCents = open.ahead.reduce((s, a) => s + a.cents, 0);
    rows.push(note(`Paid ahead with ${open.ahead.length === 1 ? "1 supplier" : `${open.ahead.length} suppliers`} by ${formatCurrency(aheadCents / 100)}: that credit isn't taken off Suppliers Say You Owe (see Open).`));
  }
  if (cur.totals.processorFees) rows.push(note(`Fees includes ${formatCurrency(cur.totals.processorFees)} of card fees on payments received.`));
  const records = input.money.recordsStart ?? null;
  const empty = beforeRecordsLine(period, records);
  if (empty) rows.push(note(empty));
  const start = cur.caveats.find((c) => c.kind === "records_start") as { date: string } | undefined;
  if (start) rows.push(note(`Records in North start ${start.date}.`));
  if (!empty && records && records > prevPeriod.start) {
    rows.push(note(`Records in North start ${records}, so ${prevPeriod.label} isn't a full comparison.`));
  }
  const notCounted = notCountedLine(cur);
  if (notCounted) rows.push(note(notCounted));
  const notPaid = countedNotPaidLine(cur);
  if (notPaid) rows.push(note(notPaid));
  rows.push(note(`Open is as of the day this was downloaded (${input.todayYmd}), not the end of the period. Stock is at cost.`));
  rows.push(note("Tabs: Income, Costs, People, Open and Stock hold the rows behind these figures."));
  return { name: "Summary", rows, widths: [46, ...(byMonth ? cur.months.map(() => 13) : []), 16, 22, 15] };
}

// ── Income ───────────────────────────────────────────────────────────────────

function incomeTab(input: AccountantWorkbookInput, cur: OwnerMoney, months: Set<string>, jobs: Map<string, { job_number: string | null; name: string | null }>): XlsxSheet {
  const { tz, money: inp } = input;
  const inPeriod = (at: string | null | undefined) => !!at && months.has(monthKeyInTz(at, tz));
  const pays = (inp.payments ?? []).filter((p) => p?.paid_at && inPeriod(p.paid_at));
  const refunds = (inp.refunds ?? []).filter((r) => r?.created_at && inPeriod(r.created_at));
  const other = (inp.otherIncome ?? []).filter((o) => months.has(String(o?.posted_on ?? "").slice(0, 7)));
  const jobOf = (id: unknown) => (id ? jobs.get(String(id)) : undefined);

  const rows: Row[] = [
    title(`Income, ${input.period.label}`),
    note("Cash basis: each payment on the day it came in. A payment on an invoice that was later voided is listed but not counted."),
    blank(),
    head("Date", "Customer", "Invoice", "Job Number", "Job", "Method", "Amount", "Card Fee", "Note"),
  ];
  type Dated = { at: string; row: Row };
  const dated: Dated[] = [];
  for (const p of pays) {
    const inv = p.invoices ?? {};
    const j = jobOf(inv.job_id);
    const fee = p.processor_fee == null || p.processor_fee === "" ? null : money(cents(p.processor_fee));
    dated.push({
      at: String(p.paid_at),
      row: line(
        date(recordDay(null, p.paid_at, tz)),
        inv.customers?.name ?? null,
        inv.invoice_number ?? null,
        j?.job_number ?? null,
        j?.name ?? null,
        methodLabel(p.method),
        money(cents(p.amount)),
        fee,
        inv.status === "void" ? "Invoice voided: not counted" : !fee && p.stripe_payment_intent ? "Card fee not reported yet" : null,
      ),
    });
  }
  for (const r of refunds) {
    const inv = r.invoices ?? {};
    const j = jobOf(inv.job_id);
    dated.push({
      at: String(r.created_at),
      row: line(date(recordDay(null, r.created_at, tz)), inv.customers?.name ?? null, inv.invoice_number ?? null, j?.job_number ?? null, j?.name ?? null, "Refund", money(-cents(r.amount)), null, null),
    });
  }
  for (const o of other) {
    dated.push({ at: `${o.posted_on}T12:00:00Z`, row: line(date(o.posted_on), null, null, null, null, "Other Income (Bank)", money(cents(o.amount)), null, null) });
  }
  dated.sort((a, b) => a.at.localeCompare(b.at));
  if (!dated.length) rows.push(note("No money came in during this period."));
  rows.push(...dated.map((d) => d.row));

  const paymentsCents = cents(computeCollected(pays, []));
  const refundCents = refunds.reduce((s, r) => s + cents(r.amount), 0);
  const otherCents = other.reduce((s, o) => s + cents(o.amount), 0);
  rows.push(total("Payments", null, null, null, null, null, money(paymentsCents), money(cents(cur.totals.processorFees))));
  if (refundCents) rows.push(total("Refunds", null, null, null, null, null, money(-refundCents)));
  if (otherCents) rows.push(total("Other Income", null, null, null, null, null, money(otherCents)));
  rows.push(total("Received", null, null, null, null, null, money(cents(cur.totals.received))));

  // BY CUSTOMER (computeCustomerValue), BY JOB (job profit's cash rule), BY METHOD.
  const names = new Map<string, string>();
  for (const p of pays) if (p.invoices?.customer_id) names.set(String(p.invoices.customer_id), String(p.invoices?.customers?.name ?? "") || "A customer");
  rows.push(blank(), title("Payments By Customer"), head("Customer", "Received"));
  let byCustomer = 0;
  for (const c of computeCustomerValue(pays, new Map(), names)) {
    byCustomer += cents(c.collected);
    rows.push(line(c.customer, money(cents(c.collected))));
  }
  if (paymentsCents - byCustomer) rows.push(line("No Customer On The Invoice", money(paymentsCents - byCustomer)));
  rows.push(total("Total", money(paymentsCents)));

  rows.push(blank(), title("Payments By Job"), head("Job Number", "Job", "Received"));
  let byJob = 0;
  const jobRows = [...collectedByJob(pays).entries()].map(([id, amt]) => ({ j: jobOf(id), c: cents(amt) })).sort((a, b) => b.c - a.c);
  for (const r of jobRows) {
    byJob += r.c;
    rows.push(line(r.j?.job_number ?? null, r.j?.name ?? "A job", money(r.c)));
  }
  if (paymentsCents - byJob) rows.push(line(null, "No Job On The Invoice", money(paymentsCents - byJob)));
  rows.push(total("Total", null, money(paymentsCents)));

  rows.push(blank(), title("Payments By Method"), head("Method", "Received"));
  const byMethod = new Map<string, any[]>();
  for (const p of pays) {
    const k = methodLabel(p.method);
    byMethod.set(k, [...(byMethod.get(k) ?? []), p]);
  }
  for (const [k, list] of [...byMethod.entries()].filter(([, l]) => l.some((p) => p?.invoices?.status !== "void")).sort((a, b) => computeCollected(b[1], []) - computeCollected(a[1], []) || a[0].localeCompare(b[0]))) {
    rows.push(line(k, money(cents(computeCollected(list, [])))));
  }
  rows.push(total("Total", money(paymentsCents)));
  if (refundCents || otherCents) rows.push(note("Refunds and Other Income are in the list above and in Received, not in these three breakdowns."));

  rows.push(blank(), title("Sales Tax"));
  if (!input.salesTax) {
    rows.push(note("Sales Tax is switched off for this company, so none is listed."));
  } else {
    const inv = input.salesTax.invoices.filter((i) => i?.created_at && inPeriod(i.created_at));
    const s = summarizeSalesTax(inv, input.salesTax.taxRates);
    rows.push(note("Billed basis: counted on the day the invoice was made, not the day it was paid (the Tax Report's rule). Drafts and voided invoices are left out."));
    rows.push(head("Jurisdiction", "Rate (%)", "Invoices", "Taxable", "Tax"));
    for (const r of s.rows) rows.push(line(r.name, Math.round(r.pct * 1000) / 1000, r.count, money(cents(r.taxable)), money(cents(r.tax))));
    rows.push(total("Total", null, s.rows.reduce((n, r) => n + r.count, 0), money(cents(s.totalTaxable)), money(cents(s.totalTax))));
    rows.push(note("Taxable counts only invoices that carry a rate above 0%."));
  }
  return { name: "Income", rows, widths: [12, 28, 12, 12, 28, 18, 13, 11, 34] };
}

// ── Costs ────────────────────────────────────────────────────────────────────

function costsTab(input: AccountantWorkbookInput, cur: OwnerMoney, months: Set<string>, jobs: Map<string, { job_number: string | null; name: string | null }>, through: string): XlsxSheet {
  const { tz, todayYmd, money: inp, lists } = input;
  const lines = ownerMoneyCostLines(inp, tz).filter((l) => l.month && months.has(l.month));
  const order: Record<OwnerMoneyCostLine["source"], number> = { bill: 0, purchase_order: 1, petty_cash: 2, card_fee: 3, stock_move: 4 };
  lines.sort((a, b) => String(a.day).localeCompare(String(b.day)) || order[a.source] - order[b.source] || String(a.row?.id ?? "").localeCompare(String(b.row?.id ?? "")));
  const itemOfLot = new Map(lists.lots.map((l) => [String(l.lot_id), l.item_id]));
  const itemName = new Map(lists.items.map((i) => [String(i.id), i.name]));

  const rows: Row[] = [
    title(`Costs, ${input.period.label}`),
    note("Cash basis: each cost on its own date (a bill's date, an order's date, the day of a card fee). Goes To is the Summary row it adds to. Crew Pay and Crew Mileage Paid are on People."),
    blank(),
    head("Date", "Where", "Bill Number", "Job Number", "Job", "Goes To", "Amount", "What It Was"),
  ];
  const sums = new Map<string, number>();
  for (const l of lines) {
    const r = l.row ?? {};
    const j = r.job_id ? jobs.get(String(r.job_id)) : undefined;
    let where: string | null = null;
    let billNo: string | null = null;
    let what: string | null = null;
    if (l.source === "bill") {
      where = String(r.supplier ?? "").trim() || "A bill with no supplier named";
      billNo = r.bill_number ?? r.supplier_invoice_number ?? null;
      what = l.to === "stock" ? "The part of this ticket that went into stock" : l.to === "stock_lost" ? "Supplier credit for stock returned" : categoryWords(r.category);
    } else if (l.source === "purchase_order") {
      where = "Purchase Order";
      what = "Ordered, no bill yet";
    } else if (l.source === "petty_cash") {
      where = "Petty Cash";
      what = categoryWords(r.category);
    } else if (l.source === "card_fee") {
      where = "Card Fees";
      what = `Card fee on a payment of ${formatCurrency(Number(r.amount) || 0)}`;
    } else {
      where = "Stock";
      const item = itemName.get(String(itemOfLot.get(String(r.lot_id ?? "")) ?? ""));
      what = `${STOCK_MOVE_WORDS[String(r.kind)] ?? "Left stock"}${item ? `: ${item}` : ""}`;
    }
    const label = targetLabel(l.to);
    sums.set(label, (sums.get(label) ?? 0) + l.cents);
    rows.push(line(date(l.day), where, billNo, j?.job_number ?? null, j?.name ?? null, label, money(l.cents), what));
  }
  if (!lines.length) rows.push(note("No costs in this period."));

  // THE TOTALS, ROW FOR ROW WITH THE SUMMARY.
  rows.push(blank(), title("Totals By Where It Goes"), head("Goes To", "Amount"));
  let all = 0;
  for (const l of summaryLines(false).filter((x) => x.cost && x.label !== "Crew Pay (1099)" && x.label !== "Crew Mileage Paid")) {
    const c = sums.get(l.label) ?? 0;
    all += c;
    rows.push(line(l.label, money(c)));
  }
  rows.push(total("Total", money(all)));
  if (cur.totals.processorFees) rows.push(note(`Fees includes ${formatCurrency(cur.totals.processorFees)} of card fees.`));

  // WHAT WAS SENT TO EACH SUPPLIER (supplierBalance over the period's payments).
  const periodPayments = (inp.supplierPayments ?? []).filter((p) => months.has(String(p?.paid_on ?? "").slice(0, 7)));
  rows.push(blank(), title("Paid To Suppliers"), note("What was sent to each supplier account in the period, voided payments left out. Bills count on their own dates above; a payment is not a second cost."));
  rows.push(head("Supplier", "Payments", "Paid"));
  let paid = 0;
  let any = false;
  for (const acct of [...supplierAccountRowsOf(inp, tz, periodPayments).values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const bal = supplierBalance(acct, todayYmd);
    if (!bal.livePayments) continue;
    any = true;
    paid += cents(bal.paid);
    rows.push(line(acct.name, bal.livePayments, money(cents(bal.paid))));
  }
  if (!any) rows.push(note("No payments to supplier accounts in this period."));
  rows.push(total("Total", null, money(paid)));

  // TOOLS: already inside the costs above; listed so the accountant can tell them apart.
  const days = { from: input.period.start, to: through };
  rows.push(blank(), title("Tools The Company Kept"), note("Already counted above. Listed so tools can be told apart: depreciation is your accountant's call."));
  const kept = toolsList(lists, days, tz);
  if (kept.rows.length) rows.push(...tableRows(kept, [4], [0]));
  else rows.push(note("None in this period."));
  rows.push(blank(), title("Tools Billed To Customer"), note("Tools on a job's receipt that the customer was billed for, at cost. The customer paid for these; they are not the company's."));
  const billedAll = toolsBilledList(lists, tz);
  const billed: CsvTable = { header: billedAll.header, rows: billedAll.rows.filter((r) => typeof r[0] === "string" && r[0] >= days.from && r[0] <= days.to) };
  if (billed.rows.length) rows.push(...tableRows(billed, [5], [0]));
  else rows.push(note("None in this period."));
  return { name: "Costs", rows, widths: [12, 30, 14, 12, 28, 26, 13, 44] };
}

// ── People ───────────────────────────────────────────────────────────────────

function peopleTab(input: AccountantWorkbookInput, cur: OwnerMoney, months: Set<string>, through: string): XlsxSheet {
  const { tz, todayYmd, showOwner, money: inp, period } = input;
  const year = period.start.slice(0, 4);
  const yearFrom = `${year}-01-01`;
  const crew = crewPayByMonth(inp.entries ?? [], inp.runs ?? [], inp.people, tz);

  type Slot = { entries: any[]; runs: any[]; payments: PayPaymentRow[]; mileageRuns: any[] };
  const byPerson = new Map<string, Slot>();
  const slot = (pid: string) => {
    const s = byPerson.get(pid) ?? { entries: [], runs: [], payments: [], mileageRuns: [] };
    byPerson.set(pid, s);
    return s;
  };
  for (const e of inp.entries ?? []) if (e?.profile_id) slot(String(e.profile_id)).entries.push(e);
  for (const r of inp.runs ?? []) {
    if (!r?.profile_id) continue;
    if (r.kind === "mileage") slot(String(r.profile_id)).mileageRuns.push(r);
    else if (!r.kind || r.kind === "base") slot(String(r.profile_id)).runs.push({ period_start: String(r.period_start), period_end: String(r.period_end), gross: Number(r.gross ?? 0) });
  }
  for (const p of (inp.payPayments ?? []).map(toPayPaymentRow)) if (p.profileId) slot(p.profileId).payments.push(p);

  const rows: Row[] = [
    title(`People, ${period.label}`),
    note("Crew Pay (1099) counts when the hours were worked: the Pay board's Earned. Paid is what was handed over. Still Owed is as of the download day."),
    note("Miles are miles: North never turns them into dollars. Mileage Settled is only what a person typed when paying mileage."),
    ...(showOwner ? [note("The owner is paid by owner's draw: the owner's hours are shown, never as pay or a cost.")] : []),
    blank(),
    head("Person", "Paid By", "Hours", "Earned", "Paid In Period", `Still Owed (${todayYmd})`, `Paid In ${year} Through ${through}`, "Miles Logged", "Miles Past Daily Commute", "Mileage Settled", "Note"),
  ];
  const crewRows: Row[] = [];
  const ownerRows: Row[] = [];
  const t = { hours: 0, earned: 0, paid: 0, owed: 0, year: 0, miles: 0, business: 0, settled: 0 };
  for (const [pid, s] of byPerson) {
    const person = inp.people.get(pid);
    const isOwner = person?.paidByDraw === true;
    if (isOwner && !showOwner) continue;
    const name = person?.name?.trim() || String(s.entries.find((e) => e?.profiles?.full_name)?.profiles?.full_name ?? "").trim() || "Someone";
    const inMonth = (e: any) => months.has(String(recordDay(null, e?.clock_in, tz) ?? "").slice(0, 7));
    const worked = s.entries.filter((e) => e?.clock_out && inMonth(e));
    const hours = worked.reduce((h, e) => h + Math.round(hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) * 100), 0) / 100;
    const miles = summarizeMileage(s.entries.filter(inMonth), Number(person?.commuteBaselineMiles ?? 0) || 0, tz);
    const openShift = s.entries.some((e) => !e?.clock_out && inMonth(e));
    if (isOwner) {
      if (!hours && !miles.recorded) continue;
      ownerRows.push(line(name, "Owner (Owner's Draw)", hours, null, null, null, null, miles.recorded, miles.business, null, "Hours only: the owner's time is not pay or a cost."));
      continue;
    }
    let earned = 0;
    for (const [m, c] of crew.get(pid) ?? []) if (months.has(m)) earned += c;
    const live = s.payments.filter((p) => !p.voided);
    const paidPeriod = cents(sumPayments(live.filter((p) => months.has(p.paidOn.slice(0, 7)))));
    const paidYear = cents(sumPayments(live.filter((p) => p.paidOn >= yearFrom && p.paidOn <= through)));
    // Still Owed is the Pay board's You Owe: its own 18 months of shifts, whatever span was read.
    const owed = cents(
      balanceForPerson({ profileId: pid, name, entries: balanceEntries(s.entries, inp.balanceFrom, tz), lockedRuns: s.runs, payments: s.payments, tz, fallbackRate: Number(person?.hourlyRate ?? 0) || 0 }).owed,
    );
    const settled = s.mileageRuns.filter((r) => months.has(String(recordDay(null, r.created_at, tz) ?? "").slice(0, 7))).reduce((c, r) => c + cents(r.mileage_amount), 0);
    if (!hours && !earned && !paidPeriod && !paidYear && !owed && !miles.recorded && !settled) continue;
    t.hours += Math.round(hours * 100);
    t.earned += earned;
    t.paid += paidPeriod;
    t.owed += owed;
    t.year += paidYear;
    t.miles += Math.round(miles.recorded * 10);
    t.business += Math.round(miles.business * 10);
    t.settled += settled;
    crewRows.push(
      line(name, "Crew (1099)", hours, money(earned), money(paidPeriod), money(owed), money(paidYear), miles.recorded, miles.business, money(settled), openShift ? "A shift is still on the clock: its hours aren't in Earned yet." : null),
    );
  }
  const byName = (a: Row, b: Row) => String(a.cells[0]).localeCompare(String(b.cells[0]));
  rows.push(...crewRows.sort(byName));
  if (!crewRows.length) rows.push(note("No crew hours, pay or miles in this period."));
  rows.push(total("Crew Total", null, t.hours / 100, money(t.earned), money(t.paid), money(t.owed), money(t.year), t.miles / 10, t.business / 10, money(t.settled)));
  if (ownerRows.length) rows.push(blank(), ...ownerRows.sort(byName));
  if (!showOwner) rows.push(blank(), note(OWNER_ROWS_HIDDEN_NOTE));
  rows.push(blank(), note(`Paid In ${year} is what was handed over this calendar year, the figure a 1099-NEC is filed from. Who needs one is your accountant's call.`));
  // Never expected (both are the frozen-gross rule over the same rows), and never silent if it happens.
  if (Math.round(cur.totals.crewPay * 100) !== t.earned) rows.push(note("Earned here doesn't add up to the Summary's Crew Pay (1099); the Summary's figure is the one Money by Month shows."));
  return { name: "People", rows, widths: [26, 20, 9, 13, 14, 16, 24, 12, 14, 14, 44] };
}

// ── Open ─────────────────────────────────────────────────────────────────────

type OpenFigures = {
  customers: ReturnType<typeof computeArAging>;
  customersCents: number;
  suppliers: { name: string; cents: number; how: string }[];
  suppliersCents: number;
  /** Accounts paid ahead of the bills North has (a credit with that supplier): listed on their own,
   *  never taken off what the others are owed (/bills: "WHAT HE OWES, not a net position"). */
  ahead: { name: string; cents: number }[];
};

function openFigures(input: AccountantWorkbookInput): OpenFigures {
  const { money: inp, tz, todayYmd } = input;
  const customers = computeArAging(input.arInvoices ?? [], todayYmd);
  const suppliers: OpenFigures["suppliers"] = [];
  const ahead: OpenFigures["ahead"] = [];
  const accounts = supplierAccountRowsOf(inp, tz);
  for (const acct of accounts.values()) {
    const bal = supplierBalance(acct, todayYmd);
    if (bal.owed === null) {
      if (bal.unpaidOnRegisterAccount) suppliers.push({ name: acct.name, cents: cents(bal.charged), how: "Bills marked unpaid on a pay-at-the-register account" });
      continue;
    }
    const c = cents(bal.owed);
    // WHAT IS OWED, not a net position (/bills' rule): a credit with one supplier pays no other.
    if (c < 0) ahead.push({ name: acct.name, cents: -c });
    if (c <= 0) continue;
    suppliers.push({ name: acct.name, cents: c, how: bal.model === "supplier-invoices" ? "Their own open invoices" : "Bills minus payments" });
  }
  let n = 0;
  let loose = 0;
  for (const b of inp.bills ?? []) {
    if (!b || b.superseded_by_bill_id) continue;
    if (b.supplier_account_id && accounts.has(String(b.supplier_account_id))) continue;
    if (!isOnAccountBill({ status: String(b.status ?? "") })) continue;
    const c = cents(b.amount);
    if (!c) continue;
    n += 1;
    loose += c;
  }
  suppliers.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  if (loose) suppliers.push({ name: "Bills On No Supplier Account", cents: loose, how: `${n} ${n === 1 ? "bill" : "bills"} marked unpaid` });
  ahead.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  return { customers, customersCents: cents(customers.outstanding), suppliers, suppliersCents: suppliers.reduce((s, x) => s + x.cents, 0), ahead };
}

function openTab(input: AccountantWorkbookInput, open: OpenFigures): XlsxSheet {
  const day = input.todayYmd;
  const rows: Row[] = [
    title(`Open As Of ${day}`),
    note(`What customers owe and what suppliers say is owed on ${day}, the day this was downloaded, not at the end of ${input.period.label}.`),
    blank(),
    title("Customers Owe You"),
    head("Invoice", "Customer", "Total", "Paid", "Still Owed", "Days Late"),
  ];
  for (const i of open.customers.invoices) rows.push(line(i.invoice_number, i.customer, money(cents(i.total)), money(cents(i.amountPaid)), money(cents(i.balance)), i.daysLate));
  if (!open.customers.invoices.length) rows.push(note(`No customer owed anything on ${day}.`));
  rows.push(total("Total", null, null, null, money(open.customersCents)));
  rows.push(note("Drafts aren't counted: they haven't been sent."));
  rows.push(blank(), title("Suppliers Say You Owe"), head("Supplier", "Owed", "How North Knows"));
  for (const s of open.suppliers) rows.push(line(s.name, money(s.cents), s.how));
  if (!open.suppliers.length) rows.push(note(`No supplier was owed anything on ${day}.`));
  rows.push(total("Total", money(open.suppliersCents)));
  rows.push(note("A supplier that sends its own invoices is owed what those say is still open. Crew still owed is on People."));
  if (open.ahead.length) {
    rows.push(blank(), title("Paid Ahead (Credit With The Supplier)"), head("Supplier", "Credit"));
    for (const a of open.ahead) rows.push(line(a.name, money(a.cents)));
    rows.push(note("Paid ahead of the bills North has: the extra sits on that supplier's account and isn't taken off what the others are owed."));
  }
  return { name: "Open", rows, widths: [30, 26, 13, 13, 13, 10] };
}

// ── Stock ────────────────────────────────────────────────────────────────────

function stockTab(input: AccountantWorkbookInput, stock: CsvTable | null, through: string): XlsxSheet {
  const rows: Row[] = [title(`In Stock At The End Of ${through}`)];
  if (!stock) {
    rows.push(note("Shop Stock isn't set up in this database, so nothing is listed."));
    return { name: "Stock", rows, widths: [40] };
  }
  rows.push(note("Roll by roll, at cost. Stock Bought on the Summary is what went into stock during the period; this is what was left on its last day."), blank());
  if (!stock.rows.length) rows.push(head(...HEADERS.on_hand), note(`Nothing in stock on ${through}.`));
  else rows.push(...tableRows(stock, [3], [4]));
  return { name: "Stock", rows, widths: [34, 8, 10, 14, 12, 28, 14, 40] };
}

// ── Files ────────────────────────────────────────────────────────────────────

/** One tab as CSV text: every cell through toCsv (so nothing a spreadsheet would run), money to the
 *  cent, dates as YYYY-MM-DD. */
export function tabCsv(tab: XlsxSheet): string {
  const conv = (v: XlsxValue): Cell => {
    if (v == null) return null;
    if (typeof v === "number" || typeof v === "string") return v;
    if ("money" in v) return Math.round(Number(v.money) * 100) / 100;
    return v.date;
  };
  const rows = tab.rows.map((r) => r.cells.map(conv));
  const [first = [], ...rest] = rows.length ? rows : [[tab.name]];
  return toCsv({ header: first.map((c) => (c == null ? "" : String(c))), rows: rest });
}

export function workbookXlsx(wb: AccountantWorkbook, opts: { deflate?: DeflateRaw; modified?: Date } = {}): Uint8Array {
  return buildXlsx(wb.tabs, opts);
}

/** "Same Thing As CSV Files": a .zip with one CSV per tab, named by the tab. */
export function workbookCsvZip(wb: AccountantWorkbook, opts: { deflate?: DeflateRaw; modified?: Date } = {}): Uint8Array {
  return buildZip(
    wb.tabs.map((t) => ({ name: `${t.name}.csv`, data: tabCsv(t) })),
    opts,
  );
}
