import { namesABucket } from "@/lib/business-cost-buckets";
import {
  computeOwnerMoney,
  countedNotPaidLine,
  crewPayByMonth,
  notCountedLine,
  balanceEntries,
  hasOwnerBuildTime,
  hasOwnerDraw,
  hasOwnerMoneyIn,
  ownerMoneyCostLines,
  ownerMoneyReadSpan,
  recordDay,
  supplierAccountRowsOf,
  supplierIdentityOf,
  windowMonths,
  type OwnerMoney,
  type OwnerMoneyCostLine,
  type OwnerMoneyFigures,
  type OwnerMoneyInputs,
  type OwnerMoneyWindow,
} from "@/lib/analytics/owner-money";
import {
  PNL_KIND_SHAPE,
  PNL_WORDS,
  cogsWords,
  isBelowNetProfit,
  overheadWords,
  pnlKeyOfCostTarget,
  pnlLines,
  pnlRow,
  profitAndLoss,
  type PnlKey,
  type PnlLine,
} from "@/lib/analytics/profit-and-loss";
import { buildTimeNotCostedSentence } from "@/lib/build-time-cost";
import { computeArAging, computeCollected, computeCustomerValue, monthKeyInTz } from "@/lib/analytics/money-metrics";
import { collectedByJob } from "@/lib/analytics/job-profitability";
import { HEADERS, onHandList, toCsv, toolsBilledList, toolsList, type AccountantInputs, type Cell, type CsvTable } from "@/lib/accountant-lists";
import { summarizeSalesTax } from "@/lib/sales-tax";
import { invoiceBalance } from "@/lib/invoice-math";
import { isOwedInvoice } from "@/lib/open-counts";
import { balanceForPerson, sumPayments, toPayPaymentRow, type PayPaymentRow } from "@/lib/payroll-math";
import { summarizeMileage } from "@/lib/mileage-math";
import { formatCurrency, hoursBetween } from "@/lib/utils";
import { tzMinutesOfDay } from "@/lib/tz";
import { isOnAccountBill, supplierBalance } from "@/app/(app)/bills/supplier-balance";
import { openOwed, whatISupplierOwed, type SupplierOwedHow } from "@/lib/supplier-owed";
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
 *            the period before and the change, laid out as the accounting industry lays out a profit
 *            and loss (profit-and-loss.ts, Erik 2026-09-28): Revenue; Cost of Goods Sold (COGS) and
 *            Total COGS; Gross Profit and Gross Margin %; Overhead and Total Overhead; and the bottom
 *            line, named exactly "Net Profit", with Owner's Draw below it as equity. Every business-cost bucket is its own
 *            row, in the half BUCKET_SECTION puts it in, so a new bucket shows up by itself.
 *   Income   every payment (computeCollected's rows: the same read), by customer
 *            (computeCustomerValue), by job (collectedByJob, job profit's cash rule) and by method;
 *            EVERY INVOICE MADE IN THE PERIOD, every status, labeled billed basis, and the sales tax
 *            summarized from those same rows when the company has it switched on.
 *   Costs    every cost line Money by Month adds up (ownerMoneyCostLines), their totals under the
 *            Summary's two headings, what was paid to each supplier (supplierBalance), and the tools
 *            lists (depreciation is the accountant's call).
 *   People   earned (the frozen-gross rule), paid, still owed (balanceForPerson), paid this calendar
 *            year; MILES AS MILES, never dollars; the owner's HOURS, never pay; and, for whoever may see
 *            the owner's money, every bank line of his draw and his money in (the rows behind the
 *            Summary's two equity figures).
 *   Open     what customers owe (computeArAging) and what suppliers say is owed (supplierBalance),
 *            AS OF THE DOWNLOAD DAY, with that date printed (Erik's answer 1).
 *   Stock    what was in stock on the period's last day, roll by roll (onHandList).
 *
 * THE OWNER'S SWITCH: when the owner has not shared the owner's money with the office
 * (office_sees_owner_money), the bottom line is the owner's. An office download then carries NO
 * bottom-line figure on ANY tab: no Revenue (the Summary's or the Income tab's), no Total COGS, no
 * Gross Profit or Gross Margin %, no Total Overhead, no Net Profit, no change on them, and no owner
 * rows; the Summary keeps the cost rows one by one under their two headings and says "The totals
 * are the owner's." The itemized tabs stay with each list's own total (Payments, what
 * went to each supplier, Crew Total...): the office already sees those records in the app, and the
 * page says so in as many words (OWNER_HIDDEN_WHY) rather than promise a secret the lists can't keep.
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

/** The page opens on this year: the same window the Net Profit card opens on. */
export function defaultAccountantPeriod(todayYmd: string): AccountantPeriod {
  return periodContaining("year", todayYmd);
}

/** The period just before, of the same kind. */
export function previousPeriod(p: AccountantPeriod): AccountantPeriod {
  const day = new Date(Date.parse(`${p.start}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return periodContaining(p.kind, day);
}

/** The periods the page offers, newest first: 24 months, 8 quarters or 6 years. `keep` (the period
 *  the page is showing) is always among them, in date order, so an older bookmarked period is what
 *  the picker shows too, never the first choice in its place. */
export function periodChoices(kind: AccountantPeriodKind, todayYmd: string, keep?: AccountantPeriod | null): AccountantPeriod[] {
  const count = kind === "month" ? 24 : kind === "quarter" ? 8 : 6;
  const out: AccountantPeriod[] = [periodContaining(kind, todayYmd)];
  while (out.length < count) out.push(previousPeriod(out[out.length - 1]));
  if (keep && keep.kind === kind && !out.some((p) => p.key === keep.key)) {
    out.push(keep);
    out.sort((a, b) => b.start.localeCompare(a.start));
  }
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

/** The bottom line's name, exactly: plain Net Profit (Erik, 2026-10-01: "lets get rid of the
 *  terminology owners draw and use only net profit"). It is before income tax, and the Summary and the
 *  page say so under it. What the owner TOOK OUT is DRAW_LABEL below: equity, under the bottom line. */
export const NET_LABEL = PNL_WORDS.netProfit;
/** The equity line's name: what the owner actually drew. Never an expense, never subtracted. */
export const DRAW_LABEL = PNL_WORDS.ownerDraw;
export const STOCK_BOUGHT_LABEL = PNL_WORDS.stockBought;
export const STOCK_LOST_LABEL = PNL_WORDS.stockLost;
export const TAB_NAMES = ["Summary", "Income", "Costs", "People", "Open", "Stock"] as const;
/** What an office download's Summary says when the owner hasn't shared the owner's money (never a total). */
export const OWNER_HIDDEN_NOTE = "The totals are the owner's.";
/** The page's line for that office viewer: why, what the file leaves out, and what it keeps (the
 *  lists the office already sees in the app, each with its own total). Never shown to the owner. */
export const OWNER_HIDDEN_WHY =
  "The owner hasn't shared the owner's money with the office, so Revenue, Total COGS, Gross Profit and Gross Margin %, Total Overhead, Net Profit, the owner's own build time, his Owner's Draw and his Owner's Money In are left out, here and in the file. The file still lists each payment, cost and crew member, with each list's own total, as the app shows them.";
/** Under the bottom line, for whoever sees it. */
export const BEFORE_TAX_NOTE = `${PNL_WORDS.netProfit} is before income tax.`;
/**
 * WHY THE OWNER'S BUILD TIME IS IN COGS AND STILL CHANGES NOTHING - the sentence an accountant needs,
 * because this is the one place the two reports are told to disagree on purpose. Erik's on-site hours
 * are charged to the jobs so each job's margin is honest; a sole proprietor cannot deduct his own
 * labour, so the identical amount comes straight back on the contra line and the bottom line does not
 * move. Said whenever the pair is on the sheet.
 */
export const OWNER_BUILD_TIME_NOTE = `${PNL_WORDS.ownerBuildTime} charges the owner's on-site hours to the jobs at his cost rate, so each job's margin is honest. ${PNL_WORDS.ownerBuildTimeContra} books the same amount straight back, because a sole proprietor cannot deduct his own labour: the two net to zero, so ${PNL_WORDS.totalCogs}, ${PNL_WORDS.grossProfit} and ${PNL_WORDS.netProfit} are the same figures without them. His office hours are in ${PNL_WORDS.overhead}, never on a job.`;
/** Under the equity line: what it is, and which draws the figure can see. */
export const DRAW_NOTE = `${PNL_WORDS.ownerDraw} is equity, not an expense: it is what the owner took out and it is never subtracted to reach ${PNL_WORDS.netProfit}.`;
/** 0376: the same note for the line the other way, appended only when that line is on the sheet. Money
 *  the owner put in is equity too - never Revenue, which is what it had to be filed as before 0376 and
 *  is why a Revenue figure of a company with one of these used to read high by the whole amount. */
export const OWNER_IN_NOTE = `${PNL_WORDS.ownerMoneyIn} is equity the other way: money the owner put in, never ${PNL_WORDS.revenue} and never added to ${PNL_WORDS.netProfit}.`;
/** What the two halves of the costs are, in the accounting industry's own test (Erik, 2026-09-28),
 *  with the lines from the data (profit-and-loss.ts), so the sentence moves when a line does. */
export function cogsOverheadNote(): string {
  return `${PNL_WORDS.cogs} is what doing the jobs costs: ${cogsWords()}. ${PNL_WORDS.overhead} is what keeps running whether there is work or not: ${overheadWords()}.`;
}
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
  /** The owner, or an office viewer the owner has shared the owner's money with. */
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
  /** EVERY invoice made in the period, drafts and voids included (ACCOUNTANT_PERIOD_INVOICE_COLS).
   *  ONE read: the Invoices Made In This Period list and the Sales Tax rows are both built from it, so
   *  their tax figures cannot drift, and the list exists whether Sales Tax is switched on or off. */
  periodInvoices: any[];
  /** Null when Sales Tax is switched off; otherwise the company's named rates. The invoices the rows
   *  are built from are `periodInvoices`. */
  salesTax: { taxRates: any[] } | null;
};

/**
 * THE INVOICE COLUMNS THE INCOME TAB'S REGISTER PRINTS, in one string so what is read and what is
 * printed cannot come apart. It is a SUPERSET of SALES_TAX_INVOICE_COLS (sales-tax.ts): the Sales Tax
 * rows below the register are summarized from these same rows, so a column dropped here would take the
 * tax figures with it rather than just blanking a cell.
 */
export const ACCOUNTANT_PERIOD_INVOICE_COLS =
  "id, invoice_number, invoice_kind, status, subtotal, tax_rate, tax, total, amount_paid, due_date, created_at, job_id, customers(name)";

export type AccountantWorkbook = {
  tabs: XlsxSheet[];
  /** The period's Revenue, Gross Profit and Net Profit, from the profit and loss. All
   *  null when the viewer may not see the totals (the owner's switch). */
  figures: { revenue: number | null; grossProfit: number | null; net: number | null };
};

type Row = XlsxRow;
const title = (s: string): Row => ({ cells: [s], bold: true });
const note = (s: string): Row => ({ cells: [s] });
const blank = (): Row => ({ cells: [] });
const head = (...cells: XlsxValue[]): Row => ({ cells, bold: true });
const line = (...cells: XlsxValue[]): Row => ({ cells });
const total = (...cells: XlsxValue[]): Row => ({ cells, bold: true });
/** A line under its heading on a profit and loss: its name indented one step. */
const under = (...cells: XlsxValue[]): Row => ({ cells, indent: true });
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
const round3 = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
};
const round1 = (n: number) => Math.round(n * 10) / 10 + 0; // + 0: never -0
/** A timestamp as a clock time in the company's zone ("10:00 AM"), never the reader's phone. */
const clockTime = (at: unknown, tz: string): string | null => {
  if (at == null || at === "") return null;
  const d = new Date(String(at));
  if (!Number.isFinite(d.getTime())) return null;
  const mins = tzMinutesOfDay(d, tz);
  const h = Math.floor(mins / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mins % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
/** "Yes" / "No" — a flag an accountant reads, never a bare true/false in a cell. */
const yesNo = (v: unknown, no: string | null = "No"): string | null => (v === true ? "Yes" : no);

/**
 * A BLANK ROW BETWEEN A LIST'S LAST DATA ROW AND ITS TOTALS.
 *
 * The totals used to sit flush under the rows they add up. Click one cell of such a list in Excel and
 * press Sort or Filter: Excel takes the whole unbroken block, so the Total row is sorted into the
 * middle of the data or hidden by a filter, and a reader adding the rows that are left gets a figure
 * nothing in this file claims. One blank row is the break Excel reads as the end of a list.
 *
 * An autoFilter or an Excel Table would say it properly, and neither is written here: an autoFilter
 * that opens with a repair prompt is worse than none, and nothing in this repo can prove how real
 * Excel opens it.
 */
const beforeTotals = (): Row => blank();

/**
 * WHAT A PERSON TYPED ON A BANK LINE, AND WHICH ACCOUNT IT POSTED TO - for whoever may see the owner's
 * money, and nobody else.
 *
 * A bank download is the owner's money line by line (bank-viewer.ts), so bank_lines' own row rules
 * (viewer_sorts_bank, 0363) already hand an office viewer without the switch no rows at all - these
 * cells would be empty for that reader anyway. The gate is written here too because the rule that keeps
 * a bank memo out of an office file must be IN the file that prints it: a later read that reaches the
 * table some other way would otherwise put the owner's bank description in an office download with
 * nothing here to stop it. 0363's CHECK has already cut any run of 6+ digits down to its last 4.
 */
const bankWords = (l: any, showOwner: boolean): { description: string | null; last4: string | null } => ({
  description: showOwner ? String(l?.description ?? "").trim() || null : null,
  last4: showOwner ? String(l?.account_last4 ?? "").trim() || null : null,
});

/**
 * THE OWNER'S ACCOUNT DIGITS, OUT OF A NOTE BOUND FOR AN OFFICE FILE.
 *
 * bankWords above keeps the last 4 out of the bank-line COLUMNS, and its own comment says a later path
 * to the same digits must not slip past it. This is that later path: the bank door writes its own
 * sentence onto the money rows it files — "From the bank download (••4417) of May 1–May 31." onto a
 * bill, onto a supplier payment and onto an invoice payment (bills/bank-core.ts) — and all three of
 * those notes print in a Memo cell on Costs or Income, which every office viewer reads. The account the
 * gate hid in one column was walking into the same file in another.
 *
 * The TAG comes out, not the sentence: "From the bank download of May 1–May 31." still tells the
 * accountant the row came off a bank download, which is the whole use of it, and says nothing about
 * which account. Dropping the sentence instead would leave a blank cell and no way to tell a
 * bank-sorted row from a typed one.
 */
const ACCOUNT_TAG = /\s*\(?••\s*\d{3,4}\)?/g;
const withoutAccountDigits = (s: string): string => s.replace(ACCOUNT_TAG, "").replace(/\s{2,}/g, " ").trim();

/**
 * THE NOTE SAVED ON A RECORD, as a cell: trimmed, never long enough to push a column off the screen,
 * and without the owner's account digits when this reader may not see the owner's money.
 *
 * `showOwner` is REQUIRED and has no default: a Memo cell cannot be added without answering whose file
 * it is, and the type checker is the only guard that still holds when the next column is written a year
 * from now.
 *
 * A Memo column holds WHATEVER WAS SAVED on the record — a person's handwriting, or North's own filing
 * sentence when the app filed the row itself (a card payment, a bank-sorted deposit, a recurring
 * expense, a receipt out of the tray). This used to promise handwriting only, which is false for every
 * row the app filed; the Note column beside it is the one that is always North's own mark about the row.
 */
const MEMO_CAP = 200;
const memo = (v: unknown, showOwner: boolean): string | null => {
  const raw = String(v ?? "").trim();
  const s = showOwner ? raw : withoutAccountDigits(raw);
  if (!s) return null;
  return s.length <= MEMO_CAP ? s : `${s.slice(0, MEMO_CAP - 1)}…`;
};

/** A CsvTable (the stock and tools lists) as sheet rows: its header bold, its Total rows bold, the
 *  money columns as money and the date columns as dates. */
function tableRows(t: CsvTable, moneyCols: number[], dateCols: number[]): Row[] {
  const firstTotal = t.rows.length - (t.summaryRows ?? 0);
  return [
    head(...t.header),
    ...t.rows.flatMap((r, i) => {
      const row: Row = {
        cells: r.map((v, c) => {
          if (v == null) return null;
          if (moneyCols.includes(c) && typeof v === "number") return { money: v };
          if (dateCols.includes(c) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v };
          return v;
        }),
        bold: i >= firstTotal,
      };
      // THE SAME BREAK EVERY OTHER LIST HERE GETS (beforeTotals): these tables carry their totals as the
      // last rows of `rows`, so without it the stock and tools lists were the ones Excel's Sort and
      // Filter could still sweep a Total into.
      return i === firstTotal && i > 0 ? [beforeTotals(), row] : [row];
    }),
  ];
}

/** Every profit-and-loss line's name, by its key: what a cost line's Goes To says. */
const PNL_LABEL = new Map<PnlKey, string>(pnlLines().map((l) => [l.key, l.label]));
/** The profit-and-loss lines whose rows are on the People tab, not the Costs list. */
/**
 * COGS LINES WHOSE ITEMISED ROWS ARE ON THE PEOPLE TAB, not the Costs tab, so the Costs tab's "Totals
 * By Where It Goes" does not list a line it has no rows for and total it as $0.
 *
 * The owner's build-time pair joins crew pay and mileage here for the same reason and one more: it is
 * not an ownerMoneyCostLine at all (no bill, no ticket, no receipt - it is hours at a rate), so the
 * Costs tab has nothing to sum for it and its Total would have gone quietly SHORT of Total COGS with
 * nothing saying why. The hours behind it are on People, where the owner's row already is.
 */
const ON_PEOPLE = new Set<PnlKey>(["crew_pay", "crew_mileage", "owner_build_time", "owner_build_time_contra"]);

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
  if (!showOwner) return { tabs, figures: { revenue: null, grossProfit: null, net: null } };
  const pnl = profitAndLoss(cur.totals);
  const amount = (key: PnlKey) => pnlRow(pnl, key)?.amount ?? null;
  return { tabs, figures: { revenue: amount("revenue"), grossProfit: amount("gross_profit"), net: amount("net_profit") } };
}

/** True when every figure of the period is zero: nothing came in, nothing went out, no crew pay, no
 *  owner hours. */
export function nothingInFigures(f: OwnerMoneyFigures): boolean {
  const nums: unknown[] = [...Object.values(f), ...Object.values(f.businessCosts ?? {})];
  return nums.every((v) => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) < 0.005);
}

/**
 * A PERIOD THAT ENDS BEFORE NORTH'S RECORDS BEGIN (the first payment or shift). A bill is never a
 * start (owner-money.ts): a receipt entered later with an older date still counts in its own month.
 * So the period "has nothing in it" ONLY when every figure is zero, and then the page says so in
 * place of $0.00 (`nothing`). Otherwise the figures are shown, with the records-start caveat under
 * them. Null when the period isn't before the records.
 */
export function beforeRecordsLine(
  p: AccountantPeriod,
  recordsStart: string | null | undefined,
  f: OwnerMoneyFigures,
): { text: string; nothing: boolean } | null {
  if (!recordsStart || recordsStart < p.end) return null;
  const when = `${shortDay(recordsStart)}, ${recordsStart.slice(0, 4)}`;
  if (nothingInFigures(f)) return { text: `North has no records before ${when}, so ${p.label} has nothing in it.`, nothing: true };
  return {
    text: `North's records start ${when}. What ${p.label} shows was dated before then (a receipt entered later still counts in its own month).`,
    nothing: false,
  };
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * THE SUMMARY'S LINES: the profit and loss (profit-and-loss.ts) for this viewer, Other Income inside
 * Revenue when either column has some, and Gross Margin % (a spreadsheet has room for a percent).
 * An office viewer the owner hasn't shared the owner's money with gets the headings and the cost rows.
 */
export function summaryLines(opts: { hasOtherIncome: boolean; showOwner: boolean; ownerBuildTime?: boolean; ownerDraw?: boolean; ownerMoneyIn?: boolean }): PnlLine[] {
  return pnlLines({
    otherIncome: opts.hasOtherIncome,
    margin: true,
    showOwner: opts.showOwner,
    ownerBuildTime: opts.ownerBuildTime,
    ownerDraw: opts.ownerDraw,
    ownerMoneyIn: opts.ownerMoneyIn,
  });
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
  // THE OWNER'S SWITCH: an office viewer the owner hasn't shared the owner's money with gets the cost rows
  // one by one under their two headings and no total at all (no Revenue, no Total COGS, no Gross
  // Profit or margin, no Total Overhead, no Net Profit): the totals are the owner's.
  // THROUGH THE ONE PREDICATE (owner-money.ts), not written out here. Both this file and the Net Profit
  // card used to hand-write `Math.abs(f.ownerBuildTimeOnJobs ?? 0) >= 0.005`, so the file and the screen
  // could quietly start disagreeing about whether the lines were on the sheet at all.
  const hasBuildTime = hasOwnerBuildTime(cur.totals, prev.totals);
  // AND OWNER'S DRAW IS ALWAYS A ROW FOR WHOEVER SEES THE OWNER'S MONEY, $0.00 included. It was switched
  // on only when the figure was non-zero, and the figure comes from bank lines sorted as Owner's Draw
  // and nothing else - so a company that has not sorted a bank download got a Summary with no equity
  // line, no zero and no disclosure, and an accountant could not tell a draw of nothing from a draw the
  // app cannot see. The note below the line says which it is.
  // MONEY IN FROM THE OWNER (0376) is a row only when either column has some: the draw is the figure an
  // accountant looks for every period, money in is the unusual direction, and hasOwnerMoneyIn is where
  // that difference is written down. The note under the block says which lines are there.
  const hasOwnerIn = hasOwnerMoneyIn(cur.totals, prev.totals);
  const lines = summaryLines({ hasOtherIncome: hasOther, showOwner, ownerBuildTime: hasBuildTime, ownerDraw: showOwner, ownerMoneyIn: showOwner && hasOwnerIn });
  const moneyCols = (l: PnlLine): XlsxValue[] => {
    const now = l.cents(cur.totals) ?? 0;
    const before = l.cents(prev.totals) ?? 0;
    return [...(byMonth ? cur.months.map((m) => money(l.cents(m) ?? 0)) : []), money(now), money(before), money(now - before)];
  };
  // Gross Margin %: a plain number of percent (the row's name carries the unit), its change in points.
  const pctCols = (l: PnlLine): XlsxValue[] => {
    const now = l.pct(cur.totals);
    const before = l.pct(prev.totals);
    return [...(byMonth ? cur.months.map((m) => l.pct(m)) : []), now, before, now != null && before != null ? round1(now - before) : null];
  };
  // A period not over yet: the period before through the same day, and the change so far.
  const prevHead = prevThrough ? `${prevPeriod.label} Through ${shortDay(prevThrough)}` : prevPeriod.label;
  const changeHead = prevThrough ? "Change So Far" : "Change";
  const rows: Row[] = [
    title(`${fileSafeName(input.company)}: For Your Accountant, ${period.label}`),
    note(`Cash basis: money counts on the day it came in or went out.${unfinished ? ` The period isn't over: figures run through ${through}.` : ""} Downloaded ${input.todayYmd}.`),
    blank(),
    head("", ...(byMonth ? cur.months.map((m) => shortMonth(m.month)) : []), `Total ${period.label}`, prevHead, changeHead),
  ];
  // THE PROFIT AND LOSS, as an accountant lays one out: the headings and the figures that are totals
  // (Revenue, Total COGS, Gross Profit, Total Overhead, Net Profit) bold, each line under its heading
  // indented.
  //
  // HOW A ROW IS WEIGHTED IS THE LAYOUT'S ANSWER, NOT THIS FILE'S (PNL_KIND_SHAPE, pnl-shape.ts). This
  // used to end `else rows.push(total(...))`, so any kind it had never heard of printed BOLD, like a
  // total - and the kind it had never heard of turned out to be `equity`, which would have put a bold
  // Owner's Draw directly under Net Profit, reading exactly like a total of it. A Record that does not
  // compile until a new kind declares its weight is the fix; `never` here is the compiler's proof that
  // this switch has heard of all of them.
  const pushLine = (l: PnlLine) => {
    const { weight } = PNL_KIND_SHAPE[l.kind];
    const cols = l.kind === "margin" ? pctCols(l) : moneyCols(l);
    if (weight === "heading") rows.push(head(l.label));
    else if (weight === "line") rows.push(under(l.label, ...cols));
    else if (weight === "strong") rows.push(total(l.label, ...cols));
    else {
      const unreachable: never = weight;
      throw new Error(`accountant Summary: no weight for ${unreachable}`);
    }
  };
  // ABOVE THE BOTTOM LINE, then a blank row, then what is BELOW it. The blank is not decoration: an
  // indented Owner's Draw sitting flush under a bold Net Profit reads as part of it, which is the one
  // thing this line must never read as. Which side a row is on is isBelowNetProfit's answer.
  for (const l of lines) if (!isBelowNetProfit(l.kind)) pushLine(l);
  const below = lines.filter((l) => isBelowNetProfit(l.kind));
  if (below.length) {
    rows.push(blank());
    for (const l of below) pushLine(l);
    // WHAT THE EQUITY LINE IS, AND WHAT ITS FIGURE CAN SEE - and, when the figure is empty, that an empty
    // one is not a claim that nothing was drawn. Same words as the Net Profit card, same predicate.
    //
    // IT SAYS "NO DRAW", because that is the only thing it knows. It used to say "Nothing this period
    // that the app can see" on a sheet whose Owner's Money In row was showing $800: one sentence
    // describing one of the two lines above it, in words that read as describing both.
    const drawn = hasOwnerDraw(cur.totals) ? "" : " No draw this period that the app can see.";
    rows.push(note([DRAW_NOTE, showOwner && hasOwnerIn ? OWNER_IN_NOTE : "", `${cur.ownerDrawSeen}${drawn}`].filter(Boolean).join(" ")));
  }
  if (showOwner) {
    // THE OWNER'S HOURS, AND WHICH OF THEM ARE BUILD TIME. His hours are never PAY - he is not on
    // payroll and there is no wage to deduct. The ON-SITE half is charged to the jobs (the pair above,
    // which nets to zero here), and the OFFICE half is Overhead and on no job: the two rows are what
    // the allocation is made of, so an accountant can tie the COGS line back to hours.
    const hours = (x: OwnerMoneyFigures) => round2(x.ownerHours);
    const onSite = (x: OwnerMoneyFigures) => round2(x.ownerOnSiteHours ?? 0);
    const office = (x: OwnerMoneyFigures) => round2(x.ownerOfficeHours ?? 0);
    rows.push(line("Owner Hours (Not Pay)", ...(byMonth ? cur.months.map(hours) : []), hours(cur.totals), hours(prev.totals), round2(cur.totals.ownerHours - prev.totals.ownerHours)));
    rows.push(
      line(
        "Owner Hours On Jobs",
        ...(byMonth ? cur.months.map(onSite) : []),
        onSite(cur.totals),
        onSite(prev.totals),
        round2((cur.totals.ownerOnSiteHours ?? 0) - (prev.totals.ownerOnSiteHours ?? 0)),
      ),
    );
    rows.push(
      line(
        "Owner Hours In The Office (Overhead)",
        ...(byMonth ? cur.months.map(office) : []),
        office(cur.totals),
        office(prev.totals),
        round2((cur.totals.ownerOfficeHours ?? 0) - (prev.totals.ownerOfficeHours ?? 0)),
      ),
    );
    if ((cur.totals.ownerUncostedBuildTimeHours ?? 0) > 0) {
      rows.push(note(buildTimeNotCostedSentence(round2(cur.totals.ownerUncostedBuildTimeHours), "The owner")));
    }
  } else {
    rows.push(note(OWNER_HIDDEN_NOTE));
  }

  rows.push(blank(), head(`Open As Of ${input.todayYmd}`, "Amount"));
  rows.push(line("Customers Owe You", money(open.customersCents)));
  rows.push(line("Suppliers Say You Owe", money(open.suppliersCents)));
  if (stock) rows.push(line(`In Stock At The End Of ${through}`, money(cents(stock.total ?? 0))));

  rows.push(blank());
  if (showOwner) rows.push(note(BEFORE_TAX_NOTE));
  // THE ONE PLACE AN ACCOUNTANT IS TOLD THE TWO REPORTS DISAGREE ON PURPOSE. Only when the pair is on
  // the sheet: a note about lines that are not there would be its own small lie.
  if (showOwner && hasBuildTime) rows.push(note(OWNER_BUILD_TIME_NOTE));
  rows.push(note(cogsOverheadNote()));
  if (prevThrough) {
    rows.push(note(`${changeHead} compares ${period.label} through ${input.todayYmd} with the same days of ${prevPeriod.label} (through ${prevThrough}), not the whole of it.`));
  }
  if (open.ahead.length) {
    const aheadCents = open.ahead.reduce((s, a) => s + a.cents, 0);
    rows.push(note(`Paid ahead with ${open.ahead.length === 1 ? "1 supplier" : `${open.ahead.length} suppliers`} by ${formatCurrency(aheadCents / 100)}: that credit isn't taken off Suppliers Say You Owe (see Open).`));
  }
  if (cur.totals.processorFees) rows.push(note(`Fees includes ${formatCurrency(cur.totals.processorFees)} of card fees on payments received.`));
  const records = input.money.recordsStart ?? null;
  // "Has nothing in it" only when every figure is zero: a backdated receipt still counts.
  const before = beforeRecordsLine(period, records, cur.totals);
  if (before) rows.push(note(before.text));
  const start = cur.caveats.find((c) => c.kind === "records_start") as { date: string } | undefined;
  if (start) rows.push(note(`Records in North start ${start.date}.`));
  if (!before?.nothing && records && records > prevPeriod.start) {
    rows.push(note(`Records in North start ${records}, so ${prevPeriod.label} isn't a full comparison.`));
  }
  const notCounted = notCountedLine(cur);
  if (notCounted) rows.push(note(notCounted));
  const notPaid = countedNotPaidLine(cur);
  if (notPaid) rows.push(note(notPaid));
  rows.push(note(`Open is as of the day this was downloaded (${input.todayYmd}), not the end of the period. Stock is at cost.`));
  // What the other tabs hold, named by what is itemized on them (80cbd6fa) — every claim here is a
  // section on one of them: each payment in, each cost and the lines of each ticket, each shift and
  // each payment handed to a person, each unpaid ticket.
  rows.push(
    note(
      `Tabs: Income, Costs, People, Open and Stock hold the rows behind these figures — each payment in and each invoice made, each cost and the lines of each ticket, each shift and each payment handed over, each ticket still unpaid${showOwner ? ", and each bank line of the owner's own money" : ""}.`,
    ),
  );
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
    // MEMO is the LAST column and is the note SAVED on the record (payments.note, a refund's note, a
    // bank line's own description) - a person's handwriting, or North's own sentence when the app filed
    // the row ("Online payment", "Deposit of 2026-04-10. From the bank download of Apr 1-Apr 30.").
    // Note beside it stays North's own words. Each payment used to carry neither: the memo was never
    // read (projection law), so a payment noted "Check 4411" - the one string an accountant matches to
    // a bank statement - printed as a blank cell.
    head("Date", "Customer", "Invoice", "Job Number", "Job", "Method", "Amount", "Card Fee", "Note", "Memo"),
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
        memo(p.note, input.showOwner),
      ),
    });
  }
  for (const r of refunds) {
    const inv = r.invoices ?? {};
    const j = jobOf(inv.job_id);
    dated.push({
      at: String(r.created_at),
      row: line(date(recordDay(null, r.created_at, tz)), inv.customers?.name ?? null, inv.invoice_number ?? null, j?.job_number ?? null, j?.name ?? null, "Refund", money(-cents(r.amount)), null, null, memo(r.note, input.showOwner)),
    });
  }
  for (const o of other) {
    // The bank's own description: without it one $800 deposit is indistinguishable from another, which
    // is the whole of what an accountant wants from a bank-sorted row.
    dated.push({ at: `${o.posted_on}T12:00:00Z`, row: line(date(o.posted_on), null, null, null, null, "Other Income (Bank)", money(cents(o.amount)), null, null, memo(bankWords(o, input.showOwner).description, input.showOwner)) });
  }
  dated.sort((a, b) => a.at.localeCompare(b.at));
  if (!dated.length) rows.push(note("No money came in during this period."));
  rows.push(...dated.map((d) => d.row));

  const paymentsCents = cents(computeCollected(pays, []));
  const refundCents = refunds.reduce((s, r) => s + cents(r.amount), 0);
  const otherCents = other.reduce((s, o) => s + cents(o.amount), 0);
  rows.push(beforeTotals());
  rows.push(total("Payments", null, null, null, null, null, money(paymentsCents), money(cents(cur.totals.processorFees))));
  if (refundCents) rows.push(total("Refunds", null, null, null, null, null, money(-refundCents)));
  if (otherCents) rows.push(total("Other Income", null, null, null, null, null, money(otherCents)));
  // THE OWNER'S SWITCH: Revenue (all of it: payments, less refunds, plus Other Income) is the top of
  // the Summary's profit and loss, one subtraction from its bottom line; the lists' own sums stay.
  if (input.showOwner) rows.push(total(PNL_WORDS.revenue, null, null, null, null, null, money(cents(cur.totals.received))));
  rows.push(
    note(
      "Memo is the note saved on the record: a payment's note, a refund's note, or a bank line's own description. Somebody typed most of them; North writes its own when it files the row itself, such as a card payment or a deposit off a bank download. Note beside it is always North's own words about the row.",
    ),
  );

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
  rows.push(beforeTotals());
  rows.push(total("Total", money(paymentsCents)));

  rows.push(blank(), title("Payments By Job"), head("Job Number", "Job", "Received"));
  let byJob = 0;
  const jobRows = [...collectedByJob(pays).entries()].map(([id, amt]) => ({ j: jobOf(id), c: cents(amt) })).sort((a, b) => b.c - a.c);
  for (const r of jobRows) {
    byJob += r.c;
    rows.push(line(r.j?.job_number ?? null, r.j?.name ?? "A job", money(r.c)));
  }
  if (paymentsCents - byJob) rows.push(line(null, "No Job On The Invoice", money(paymentsCents - byJob)));
  rows.push(beforeTotals());
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
  rows.push(beforeTotals());
  rows.push(total("Total", money(paymentsCents)));
  if (refundCents || otherCents) {
    rows.push(note(`Refunds and Other Income are in the list above${input.showOwner ? ` and in ${PNL_WORDS.revenue}` : ""}, not in these three breakdowns.`));
  }

  // EVERY INVOICE MADE IN THE PERIOD (80cbd6fa: the download "needs to have ALL the data available to
  // be itemized"). The list at the top of this tab is cash: what came IN, on the day it came in. This
  // is the other half of the question an accountant asks of a period, and until now it was nowhere in
  // the file at all - the only invoices read were the ones still unpaid TODAY (Open, with no date made,
  // no kind and no tax on them) and, when Sales Tax happened to be switched on, enough columns to add
  // the tax up by rate and nothing to say which invoice each row came from.
  //
  // ONE READ FEEDS THIS LIST AND THE SALES TAX ROWS BELOW IT, so the two tie by construction rather
  // than by two reads happening to agree - and the list is here whether Sales Tax is on or off.
  const periodInvoices = (input.periodInvoices ?? []).filter((i) => i?.created_at && inPeriod(i.created_at));
  rows.push(blank(), title("Invoices Made In This Period"));
  rows.push(
    note(
      "Billed basis: each invoice on the day it was made, not the day it was paid — a different count from the payments above, which are cash. Drafts and voided invoices are listed and marked, are in no Total, and are owed nothing: a draft hasn't been sent and a void isn't a bill. Paid To Date and Still Owed To Date are rolled up to the day this was downloaded, not to the end of the period.",
    ),
  );
  // DATE MADE, CUSTOMER, INVOICE, JOB NUMBER, JOB — the SAME first five columns, in the same order, as
  // the payments list at the top of this tab. One sheet has one set of column widths (below), so a field
  // that appears in both lists has to sit in the same column letter in both or one of the two gets the
  // other's width: with Kind third, this list's Customer landed in a 14-wide column and its Job in an
  // 18-wide one, so a property-management company's full name and a job named for its street were both
  // cut off at the column edge — in the one list that exists to be filtered by customer and by job —
  // while the same two names fitted in the list above. Nothing here wraps and the cell to the right is
  // always filled. Kind and Status follow, where no column of the list above needs the room.
  rows.push(head("Date Made", "Customer", "Invoice", "Job Number", "Job", "Kind", "Status", "Subtotal", "Rate (%)", "Tax", "Total", "Paid To Date", "Still Owed To Date", "Due Date", "Note"));
  const madeRows: { at: string; row: Row }[] = [];
  const made = { subtotal: 0, tax: 0, total: 0, paid: 0, owed: 0, counted: 0, uncounted: 0 };
  for (const i of periodInvoices) {
    const status = String(i?.status ?? "");
    // A draft or a void is LISTED and marked, exactly as Income marks a payment on a voided invoice,
    // and counts in nothing: summarizeSalesTax leaves the same two out, which is why the Tax total
    // below this list is the Sales Tax total.
    const counts = status !== "draft" && status !== "void";
    const j = jobOf(i?.job_id);
    const rate = Number(i?.tax_rate ?? 0) * 100;
    // STILL OWED IS THE ONE RECEIVABLE RULE'S ANSWER (isOwedInvoice), and invoiceBalance is THE balance
    // under it (invoice-math.ts: it floors at zero and rounds to the cent, which is why eighteen other
    // places call it instead of subtracting).
    //
    // The cell used to be invoiceBalance for EVERY status, with only the Total row leaving a draft or a
    // void out. A void keeps its stored total (setInvoiceStatus writes `status` alone), so a voided
    // $5,000 invoice with nothing paid printed "Still Owed To Date $5,000.00" on a row the Total already
    // excluded — one invoice with two answers in the one file whose job is to let an accountant
    // reconcile them, and a filter on this column handing back receivables Open's Customers Owe You and
    // the Summary's figure do not have. invoice-amount.ts fixed this same fault on screen already: "$X
    // due of $X" beside a void badge told the office it was still owed.
    //
    // Nothing owed reads $0.00, the same as a paid invoice's does, so the column is numeric all the way
    // down and sums to the Total row: owedCents is already zero for anything not owed, so the `counts`
    // gate below adds exactly the figures printed above it.
    const owedCents = isOwedInvoice(i ?? {}) ? cents(invoiceBalance(i?.total, i?.amount_paid)) : 0;
    if (counts) {
      made.counted += 1;
      made.subtotal += cents(i?.subtotal);
      made.tax += cents(i?.tax);
      made.total += cents(i?.total);
      made.paid += cents(i?.amount_paid);
      made.owed += owedCents;
    } else made.uncounted += 1;
    const day = recordDay(null, i?.created_at, tz);
    madeRows.push({
      at: `${day ?? "9999-99-99"} ${String(i?.id ?? "")}`,
      row: line(
        date(day),
        i?.customers?.name ?? null,
        i?.invoice_number ?? null,
        j?.job_number ?? null,
        j?.name ?? null,
        methodLabel(i?.invoice_kind ?? "standard"),
        methodLabel(status),
        money(cents(i?.subtotal)),
        round3(rate),
        money(cents(i?.tax)),
        money(cents(i?.total)),
        money(cents(i?.amount_paid)),
        money(owedCents),
        date(String(i?.due_date ?? "").slice(0, 10)),
        status === "draft" ? "Draft: not counted" : status === "void" ? "Voided: not counted" : null,
      ),
    });
  }
  madeRows.sort((a, b) => a.at.localeCompare(b.at));
  if (!madeRows.length) rows.push(note(`No invoice was made in ${input.period.label}.`));
  rows.push(...madeRows.map((d) => d.row));
  rows.push(beforeTotals());
  // MONEY ONLY IN THE MONEY COLUMNS. The count of invoices used to sit in this row under Status, where a
  // bare "2" reads as neither a status nor a figure; how many are in the Total and how many are not is a
  // sentence, said below, where a sentence belongs.
  rows.push(total("Total", null, null, null, null, null, null, money(made.subtotal), null, money(made.tax), money(made.total), money(made.paid), money(made.owed)));
  const says = (n: number) => (n === 1 ? "1 invoice" : `${n} invoices`);
  rows.push(
    note(
      made.uncounted
        ? `${says(made.counted)} ${made.counted === 1 ? "is" : "are"} in this Total; ${says(made.uncounted)} above ${made.uncounted === 1 ? "is a draft or voided and is" : "are drafts or voided and are"} in none.`
        : `${says(made.counted)} ${made.counted === 1 ? "is" : "are"} in this Total; no invoice of this period is a draft or voided.`,
    ),
  );

  rows.push(blank(), title("Sales Tax"));
  if (!input.salesTax) {
    rows.push(note("Sales Tax is switched off for this company, so none is listed. The invoices above still carry what tax was billed on each."));
  } else {
    // THE SAME ROWS THE LIST ABOVE PRINTED, so the Tax total here and the Tax total there cannot drift.
    const s = summarizeSalesTax(periodInvoices, input.salesTax.taxRates);
    rows.push(note("Billed basis: counted on the day the invoice was made, not the day it was paid (the Tax Report's rule). Drafts and voided invoices are left out, as they are above."));
    rows.push(head("Jurisdiction", "Rate (%)", "Invoices", "Taxable", "Tax"));
    for (const r of s.rows) rows.push(line(r.name, Math.round(r.pct * 1000) / 1000, r.count, money(cents(r.taxable)), money(cents(r.tax))));
    rows.push(beforeTotals());
    rows.push(total("Total", null, s.rows.reduce((n, r) => n + r.count, 0), money(cents(s.totalTaxable)), money(cents(s.totalTax))));
    rows.push(note("Taxable counts only invoices that carry a rate above 0%."));
    // Never expected (one read, one filter), and never silent if it happens.
    if (cents(s.totalTax) !== made.tax) rows.push(note("The tax here doesn't add up to the Tax column of Invoices Made In This Period, though both read the same invoices."));
  }
  // ONE WIDTH PER COLUMN FOR THE WHOLE SHEET, so every list on it has to agree about what each column
  // letter holds. Nothing here wraps or auto-fits (xlsx-write.ts writes the widths literally), and a
  // cell whose neighbour is filled is cut off at the column edge, so a column too narrow for the longest
  // thing printed in it loses text. Column M is 19 rather than 16 because its own header, "Still Owed To
  // Date", is 18 characters and was being clipped by Due Date beside it.
  return { name: "Income", rows, widths: [13, 28, 14, 14, 28, 18, 14, 13, 30, 24, 13, 14, 19, 13, 24] };
}

// ── Costs ────────────────────────────────────────────────────────────────────

function costsTab(input: AccountantWorkbookInput, cur: OwnerMoney, months: Set<string>, jobs: Map<string, { job_number: string | null; name: string | null }>, through: string): XlsxSheet {
  const { tz, todayYmd, money: inp, lists } = input;
  const lines = ownerMoneyCostLines(inp, tz).filter((l) => l.month && months.has(l.month));
  const order: Record<OwnerMoneyCostLine["source"], number> = { bill: 0, purchase_order: 1, petty_cash: 2, card_fee: 3, stock_move: 4 };
  lines.sort((a, b) => String(a.day).localeCompare(String(b.day)) || order[a.source] - order[b.source] || String(a.row?.id ?? "").localeCompare(String(b.row?.id ?? "")));
  const itemOfLot = new Map(lists.lots.map((l) => [String(l.lot_id), l.item_id]));
  const itemName = new Map(lists.items.map((i) => [String(i.id), i.name]));

  // WHICH ACCOUNT EACH TICKET BELONGS TO, AND WHETHER NORTH STILL CALLS IT UNPAID - the SAME two
  // functions the Open tab's lists ask (supplierIdentityOf, isOnAccountBill with settledBySupplier), so
  // a ticket cannot read one way here and another way there. "Where" beside them is the free-text
  // SPELLING, which is why a supplier written five ways cannot be filtered as one company without this.
  const { of: costIdentity } = supplierIdentityOf(inp);
  const costAcctName = new Map((inp.supplierAccounts ?? []).map((a: any) => [String(a?.id), String(a?.name ?? "").trim()]));
  /** The supplier account a ticket belongs to, by IDENTITY (filed, alias or the account's own name) -
   *  never `bills.supplier_account_id` alone, which is null on more than half a real book. */
  const accountOf = (billId: unknown): string => {
    const id = costIdentity.get(String(billId))?.accountId ?? null;
    if (!id) return "No supplier account";
    return costAcctName.get(String(id)) || "An account North can't name";
  };

  const rows: Row[] = [
    title(`Costs, ${input.period.label}`),
    note("Cash basis: each cost on its own date (a bill's date, an order's date, the day of a card fee). Goes To is the Summary row it adds to. Crew Pay and Crew Mileage Paid are on People."),
    blank(),
    head("Date", "Where", "Bill Number", "Job Number", "Job", "Goes To", "Amount", "What It Was", "Marked Unpaid", "Supplier Account", "Memo"),
  ];
  const sums = new Map<PnlKey, number>();
  /** The period's tickets, by the SAME day and the same set the cost list above counts, so the lines
   *  section can't list a ticket on a day the cost line calls something else. */
  const ticket = new Map<string, { day: string | null; supplier: string | null; billNo: string | null; jobId: string | null; cents: number }>();
  for (const l of lines) {
    const r = l.row ?? {};
    const j = r.job_id ? jobs.get(String(r.job_id)) : undefined;
    if (l.source === "bill" && r.id != null) {
      const id = String(r.id);
      const seen = ticket.get(id);
      ticket.set(id, {
        day: l.day ?? seen?.day ?? null,
        supplier: String(r.supplier ?? "").trim() || null,
        billNo: r.bill_number ?? r.supplier_invoice_number ?? null,
        jobId: r.job_id ? String(r.job_id) : null,
        // Every part of the ticket the Summary counted (its materials half and its shelf half).
        cents: (seen?.cents ?? 0) + l.cents,
      });
    }
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
    const key = pnlKeyOfCostTarget(l.to);
    sums.set(key, (sums.get(key) ?? 0) + l.cents);
    // Only a ticket has a supplier account, an unpaid mark or a memo: the other sources (an order, petty
    // cash, a card fee, a stock move) leave those cells BLANK rather than answer "No" for a question
    // that was never asked of them.
    const isBill = l.source === "bill" && r.id != null;
    rows.push(
      line(
        date(l.day),
        where,
        billNo,
        j?.job_number ?? null,
        j?.name ?? null,
        PNL_LABEL.get(key) ?? key,
        money(l.cents),
        what,
        isBill ? yesNo(isOnAccountBill({ status: String(r.status ?? ""), amount: r.amount, amountPaid: r.amount_paid == null ? null : Number(r.amount_paid) || 0 })) : null,
        isBill ? accountOf(r.id) : null,
        isBill ? memo(r.notes, input.showOwner) : null,
      ),
    );
  }
  if (!lines.length) rows.push(note("No costs in this period."));

  // THE TOTALS, ROW FOR ROW WITH THE SUMMARY, UNDER THE SAME TWO HEADINGS (the profit and loss's own
  // lines, profit-and-loss.ts). Crew pay and mileage are COGS too, but their rows are on People.
  rows.push(blank(), title("Totals By Where It Goes"), head("Goes To", "Amount"));
  let all = 0;
  for (const l of pnlLines()) {
    if (l.kind === "heading") {
      rows.push(head(l.label));
      continue;
    }
    if (l.kind !== "cost" || ON_PEOPLE.has(l.key)) continue;
    const c = sums.get(l.key) ?? 0;
    all += c;
    rows.push(under(l.label, money(c)));
  }
  rows.push(beforeTotals());
  rows.push(total("Total", money(all)));
  // No figure here: an office file the owner hasn't shared carries no bottom line, so the note says
  // where the rest is rather than adding it up.
  rows.push(
    note(
      `${PNL_WORDS.crewPay}, ${PNL_WORDS.crewMileage} and the owner's build time are in ${PNL_WORDS.cogs} too, but they are hours rather than paper, so their rows are on the People tab and they are not in this total.`,
    ),
  );
  if (cur.totals.processorFees) rows.push(note(`Fees includes ${formatCurrency(cur.totals.processorFees)} of card fees.`));
  // WHAT THE THREE LAST COLUMNS OF THE LIST ARE, said once. Supplier Account is the one that earns the
  // sentence: a filter on Where groups a spelling, a filter on Supplier Account groups a company.
  rows.push(
    note(
      "Marked Unpaid is what North's own books say about a ticket as of the download day — the same answer as Bills North Has Marked Unpaid on Open. Supplier Account is the company a ticket belongs to however it was spelled, so one supplier written several ways filters as one; Where is the spelling on the paper. Memo is the note saved on the ticket: somebody typed most of them, and North writes its own when it files the ticket itself, off a bank download, a recurring expense or a receipt out of the tray.",
    ),
  );

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
  rows.push(beforeTotals());
  rows.push(total("Total", null, money(paid)));

  // EACH PAYMENT, NOT JUST HOW MANY (Erik, report 80cbd6fa, 2026-09-30: the download "needs to have
  // ALL the data available to be itemized"). The rollup above says "Northline Supply · 1 · $500"; this
  // is the $500, on its day, by its method. A voided payment is listed and marked, as a payment on a
  // voided invoice is on Income, so the figure above can be checked and nothing is quietly dropped.
  rows.push(blank(), title("Each Payment To A Supplier"), note("Every payment that made up the figures above, voided ones marked. They add up to the same Total."));
  // CHECK OR REFERENCE, by the name People's Each Payment Handed Over already gives it: 0270 calls the
  // column "Check number, confirmation code, whatever he can match to his bank". It was never read, so
  // the one list an accountant reconciles a bank statement against was the one list without it.
  rows.push(head("Date", "Supplier", "Method", "Amount", "Note", "Check Or Reference", "Memo"));
  let paidEach = 0;
  const payRows = [...periodPayments].sort(
    (a, b) => String(a?.paid_on).localeCompare(String(b?.paid_on)) || String(a?.id ?? "").localeCompare(String(b?.id ?? "")),
  );
  for (const p of payRows) {
    const voided = !!p?.voided_at;
    if (!voided) paidEach += cents(p?.amount);
    rows.push(
      line(
        date(String(p?.paid_on ?? "").slice(0, 10)),
        costAcctName.get(String(p?.supplier_account_id)) || "A supplier account North can't name",
        methodLabel(p?.method),
        money(cents(p?.amount)),
        voided ? "Voided: not counted" : null,
        memo(p?.reference, input.showOwner),
        memo(p?.note, input.showOwner),
      ),
    );
  }
  if (!payRows.length) rows.push(note("No payments to supplier accounts in this period."));
  rows.push(beforeTotals());
  rows.push(total("Total", null, null, money(paidEach)));
  // Never expected (both are the same rows), and never silent if it happens.
  if (paidEach !== paid) rows.push(note("These payments don't add up to Paid To Suppliers above; the figure above is the one /bills shows."));

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

  // EVERY LINE ON EVERY TICKET (80cbd6fa). The list at the top of this tab is one row per ticket: a
  // $1,200 receipt from Northline. This is what was ON it, line by line, as the person entering it
  // itemized the paper — what it was, how many, at what price, what it was filed as, whether the
  // customer was billed for it and whether the container went on the shelf. Nothing new is read: these
  // are the receipt's own lines, the same ones the Materials tab and the Tools lists work from.
  rows.push(blank(), title("Every Line On Every Ticket"));
  rows.push(note("The lines of each ticket counted above, in the order they were entered. Already counted: a ticket's own total is its row at the top of this tab, not these lines added again."));
  rows.push(head("Date", "Supplier", "Bill Number", "Job Number", "Job", "Filed As", "Amount", "What", "Quantity", "Unit Price", "Billable", "Part Billed", "Into Stock"));
  /** A line whose container went onto the shelf: a stock lot points at it (0303's bill_line_id). */
  const shelved = new Set((lists.lots ?? []).map((l) => String(l.bill_line_id ?? "")).filter(Boolean));
  const linesOf = new Map<string, typeof lists.lines>();
  for (const l of lists.lines ?? []) {
    const id = String(l.bill_id);
    linesOf.set(id, [...(linesOf.get(id) ?? []), l]);
  }
  const tickets = [...ticket.entries()].sort(
    (a, b) => String(a[1].day).localeCompare(String(b[1].day)) || a[0].localeCompare(b[0]),
  );
  let lineCents = 0;
  let listed = 0;
  let bare = 0;
  let bareCents = 0;
  for (const [id, t] of tickets) {
    const own = linesOf.get(id) ?? [];
    if (!own.length) {
      bare += 1;
      bareCents += t.cents;
      continue;
    }
    listed += 1;
    const j = t.jobId ? jobs.get(t.jobId) : undefined;
    for (const l of own) {
      const c = cents(l.amount);
      lineCents += c;
      rows.push(
        line(
          date(t.day),
          t.supplier ?? "A bill with no supplier named",
          t.billNo ?? null,
          j?.job_number ?? null,
          j?.name ?? null,
          String(l.category ?? "").trim() || null,
          money(c),
          String(l.description ?? "").trim() || null,
          // A line entered without a count or an each-price leaves those cells BLANK: a 0 there would
          // read as "none at $0.00" instead of "nobody typed it".
          l.quantity == null || l.quantity === "" ? null : round3(l.quantity),
          l.unit_price == null || l.unit_price === "" ? null : money(cents(l.unit_price)),
          // billable false is 0268's "the company eats this line": it never reaches an invoice.
          yesNo(l.billable !== false, "No (the company's)"),
          l.billed_amount == null ? null : money(cents(l.billed_amount)),
          yesNo(shelved.has(String(l.id)), null),
        ),
      );
    }
  }
  if (!listed) rows.push(note("No ticket in this period was entered line by line."));
  rows.push(beforeTotals());
  rows.push(total("Total Of The Lines", null, null, null, null, null, money(lineCents)));
  rows.push(note("Part Billed is the dollars of a line this job took when only part of it was the customer's; blank means the whole line."));
  // THE GAP, SAID. A ticket is counted by its own total, so the lines are never added up instead of it
  // — and a ticket entered as a total only, or one whose lines don't cover it, leaves a difference
  // somebody would otherwise hunt for. Both halves of it are named here rather than left to arithmetic.
  const ticketCents = [...ticket.values()].reduce((s, x) => s + x.cents, 0);
  rows.push(
    note(
      `The tickets of this period come to ${formatCurrency(ticketCents / 100)} in the list at the top of this tab, and their lines name ${formatCurrency(lineCents / 100)} of it.` +
        (bare ? ` ${bare === 1 ? "1 ticket" : `${bare} tickets`} (${formatCurrency(bareCents / 100)}) ${bare === 1 ? "was" : "were"} entered as a total only, with no lines to list.` : "") +
        " A ticket is always counted by its own total, never by adding its lines.",
    ),
  );
  // Thirteen columns is the widest list on this tab (Every Line On Every Ticket); the cost list's three
  // new ones share 9-11 with it, so each width is the wider of the two things that land in that column.
  return { name: "Costs", rows, widths: [12, 30, 14, 12, 28, 26, 13, 44, 15, 26, 30, 13, 11] };
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
    // THE OWNER'S HOURS, SAID EXACTLY. Never a WAGE: he is not on payroll, there is no Earned and no
    // Still Owed on his row, and nothing on the profit and loss deducts his labour. AND a real cost of
    // the job he worked: his on-site hours are charged there at his cost rate, which is what the
    // Summary's build-time pair is. Both halves, because either one alone has been wrong before.
    ...(showOwner
      ? [
          note(
            "The owner is paid by owner's draw, never wages: there is no Earned and no Still Owed on the owner's row. The owner's hours on jobs ARE charged to those jobs at the owner's cost rate, so each job's margin is honest; the Summary books the same amount straight back, so it is not deducted on the profit and loss.",
          ),
        ]
      : []),
    blank(),
    head("Person", "Paid By", "Hours", "Earned", "Paid In Period", `Still Owed (${todayYmd})`, `Paid In ${year} Through ${through}`, "Miles Logged", "Miles Past Daily Commute", "Mileage Settled", "Note"),
  ];
  const crewRows: Row[] = [];
  const ownerRows: Row[] = [];
  // THE ROWS BEHIND THE ROWS (Erik, report 80cbd6fa: the download "needs to have ALL the data
  // available to be itemized"). Each person's line above is a period's worth of figures; these three
  // lists are what those figures are made of — every shift, every payment handed over, every pay
  // period that locked. Each row carries the day it belongs to so the lists read in date order.
  type Dated = { at: string; row: Row };
  const shiftRows: Dated[] = [];
  const personPayRows: Dated[] = [];
  const lockedRows: Row[] = [];
  const t = { hours: 0, earned: 0, paid: 0, owed: 0, year: 0, miles: 0, business: 0, settled: 0 };
  const tHandedOver = { pay: 0, mileage: 0 };
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
    // EVERY SHIFT, HOURS ONLY. What a shift is WORTH is the Pay board's rule (a locked pay period is
    // worth the gross frozen on it), so an hourly multiply here would not add up to Earned — the note
    // under the list says so rather than print a figure that argues with the one above.
    for (const e of s.entries) {
      if (!inMonth(e)) continue;
      const day = recordDay(null, e?.clock_in, tz);
      shiftRows.push({
        at: `${day ?? "9999-99-99"} ${String(e?.clock_in ?? "")}`,
        row: line(
          name,
          date(day),
          clockTime(e?.clock_in, tz),
          e?.clock_out ? clockTime(e.clock_out, tz) : null,
          Number(e?.lunch_minutes) || 0,
          e?.clock_out ? round2(hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes)) : null,
          round3(e?.miles ?? 0) ?? 0,
          e?.clock_out
            ? e?.split_from
              ? "Split off another shift of the same day."
              : null
            : "Still on the clock: these hours aren't in Earned yet.",
        ),
      });
    }
    if (isOwner) {
      if (!hours && !miles.recorded) continue;
      ownerRows.push(
        line(
          name,
          "Owner (Owner's Draw)",
          hours,
          null,
          null,
          null,
          null,
          miles.recorded,
          miles.business,
          null,
          "Hours only: never a wage. Hours on a job are charged to the job at the owner's cost rate, and booked straight back on the profit and loss.",
        ),
      );
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
    const periodMileage = s.mileageRuns.filter((r) => months.has(String(recordDay(null, r.created_at, tz) ?? "").slice(0, 7)));
    const settled = periodMileage.reduce((c, r) => c + cents(r.mileage_amount), 0);

    // EVERY PAYMENT HANDED TO THIS PERSON in the period — the pay and the mileage settlements, each on
    // its own day, with its method and its check or transfer number. This is the list a 1099-NEC is
    // filed from; the per-person "Paid In Period" above is its total. Voided payments are listed and
    // marked (the figures above leave them out), so the total can be checked.
    for (const p of s.payments) {
      if (!months.has(p.paidOn.slice(0, 7))) continue;
      if (!p.voided) tHandedOver.pay += cents(p.amount);
      personPayRows.push({
        at: `${p.paidOn} ${p.id}`,
        row: line(
          date(p.paidOn),
          name,
          "Pay",
          methodLabel(p.method),
          p.reference ?? null,
          money(cents(p.amount)),
          p.voided ? "Voided: not counted" : p.needsCheck ? `Marked to check${p.note ? `: ${p.note}` : ""}` : p.note ?? null,
        ),
      });
    }
    for (const r of periodMileage) {
      const day = recordDay(null, r.created_at, tz);
      tHandedOver.mileage += cents(r.mileage_amount);
      personPayRows.push({
        at: `${day ?? "9999-99-99"} ${String(r?.id ?? "")}`,
        row: line(
          date(day),
          name,
          "Mileage Settled",
          null,
          null,
          money(cents(r.mileage_amount)),
          `What was typed for the miles of ${r.period_start} to ${r.period_end}`,
        ),
      });
    }
    // EVERY PAY PERIOD THAT LOCKED and touches this one: the gross FROZEN on it when it locked, which
    // is what Earned uses for those shifts (a raise applies forward only). A period can straddle the
    // edge of this one, which is why its own two dates are printed beside it.
    for (const r of s.runs) {
      if (!(r.period_start < period.end && r.period_end >= period.start)) continue;
      lockedRows.push(line(name, date(r.period_start), date(r.period_end), money(cents(r.gross))));
    }
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
  rows.push(beforeTotals());
  rows.push(total("Crew Total", null, t.hours / 100, money(t.earned), money(t.paid), money(t.owed), money(t.year), t.miles / 10, t.business / 10, money(t.settled)));
  if (ownerRows.length) rows.push(blank(), ...ownerRows.sort(byName));
  if (!showOwner) rows.push(blank(), note(OWNER_ROWS_HIDDEN_NOTE));
  rows.push(blank(), note(`Paid In ${year} is what was handed over this calendar year, the figure a 1099-NEC is filed from. Who needs one is your accountant's call.`));
  // Never expected (both are the frozen-gross rule over the same rows), and never silent if it happens.
  if (Math.round(cur.totals.crewPay * 100) !== t.earned) rows.push(note("Earned here doesn't add up to the Summary's Crew Pay (1099); the Summary's figure is the one Money by Month shows."));

  rows.push(blank(), title("Each Payment Handed Over"));
  rows.push(note("Every payment in the period, on its own day: pay, and mileage a person was settled for. Voided ones are listed and marked, and are in neither Total."));
  rows.push(head("Date", "Person", "Kind", "Method", "Check Or Reference", "Amount", "Note"));
  personPayRows.sort((a, b) => a.at.localeCompare(b.at));
  if (!personPayRows.length) rows.push(note("Nothing was handed over in this period."));
  rows.push(...personPayRows.map((d) => d.row));
  rows.push(beforeTotals());
  rows.push(total("Total Pay", null, null, null, null, money(tHandedOver.pay)));
  rows.push(total("Total Mileage Settled", null, null, null, null, money(tHandedOver.mileage)));
  rows.push(note("Pay and mileage settle separately and are never added into one figure: a payable number North invented is how a wrong amount lands on a check."));

  rows.push(blank(), title("Every Shift"));
  rows.push(note("Each shift in the period, in the company's time zone, with its lunch and its miles. Hours only: what a shift is worth follows the Pay board's rule (a locked pay period is worth the gross frozen on it), so Earned above is the figure, not hours times a rate."));
  rows.push(head("Person", "Date", "Clock In", "Clock Out", "Lunch (Minutes)", "Hours", "Miles Logged", "Note"));
  shiftRows.sort((a, b) => a.at.localeCompare(b.at));
  if (!shiftRows.length) rows.push(note("No shifts in this period."));
  rows.push(...shiftRows.map((d) => d.row));
  rows.push(beforeTotals());
  rows.push(total("Total Hours", null, null, null, null, round2(shiftRows.length ? sumHours(shiftRows) : 0)));
  rows.push(note("Total Hours counts every shift listed, the owner's among them when they are shown, so it is not Crew Total's Hours."));

  rows.push(blank(), title("Pay Periods Locked"));
  rows.push(note("A locked period's gross is frozen the day it locks: a later raise applies forward only. Earned spreads a frozen period over the months of the shifts it locked, which is why a period that straddles this one's edge still shows here with both its own dates."));
  rows.push(head("Person", "From", "To", "Gross Frozen"));
  if (!lockedRows.length) rows.push(note("No pay period that locked touches this period."));
  rows.push(...lockedRows.sort((a, b) => String(a.cells[0]).localeCompare(String(b.cells[0]))));
  // No total on purpose, said out loud: adding frozen grosses across the edge is not this period's pay.
  if (lockedRows.length) rows.push(note("No total here: a period that straddles this one's edge is only partly in it, so adding the frozen grosses would not be Earned."));

  if (showOwner) rows.push(...ownerEquityRows(input, cur, months));
  return { name: "People", rows, widths: [26, 20, 14, 30, 18, 16, 24, 14, 14, 14, 44] };
}

/**
 * THE OWNER'S OWN MONEY, LINE BY LINE (80cbd6fa: the download "needs to have ALL the data available to
 * be itemized"). The Summary has carried Owner's Draw and Owner's Money In as two equity figures below
 * Net Profit since 0376, and NOTHING in the file said what either was made of: $2,400 drawn and $800 put
 * in were two cells with no row anywhere behind them, which is the one shape an accountant cannot sign.
 *
 * ON THE PEOPLE TAB, where the owner's row already is, and INSIDE the owner's switch - the same gate the
 * Summary's two rows sit behind, so an office viewer without it gains nothing here either.
 *
 * AMOUNTS ARE POSITIVE in both directions, because the engine's figures are (computeOwnerMoney takes
 * Math.abs of a signed bank amount) and the Summary prints them that way. Direction is the column that
 * says which way the money went; a sign would have been a second answer to the same question.
 *
 * ONE READ, THE SAME ONE: these are inp.ownerDraws and inp.ownerMoneyIn, the rows the figures above were
 * added up from, filtered by the month of posted_on exactly as the Income tab filters Other Income.
 * posted_on is a DATE on the row (0363), so the month is its first seven characters - never a timezone
 * conversion, which is how a bank line on the first of a month lands in the one before.
 */
function ownerEquityRows(input: AccountantWorkbookInput, cur: OwnerMoney, months: Set<string>): Row[] {
  const { money: inp, showOwner } = input;
  const rows: Row[] = [blank(), title(`${DRAW_LABEL} And ${PNL_WORDS.ownerMoneyIn}`)];
  rows.push(
    note(
      `Equity, not income and not a cost: these are the rows behind the two lines below ${PNL_WORDS.netProfit} on the Summary, and neither is added to or subtracted from it. Amounts are positive in both directions; Direction says which way the money went.`,
    ),
  );
  rows.push(head("Date", "Direction", "Amount", "Bank Description", "Account (Last 4)"));
  type Dated = { at: string; row: Row };
  const dated: Dated[] = [];
  const sums = { out: 0, in: 0 };
  const push = (l: any, direction: "Taken Out" | "Put In") => {
    const day = String(l?.posted_on ?? "").slice(0, 10);
    if (!months.has(day.slice(0, 7))) return;
    const c = Math.abs(cents(l?.amount));
    if (direction === "Taken Out") sums.out += c;
    else sums.in += c;
    const words = bankWords(l, showOwner);
    dated.push({ at: `${day} ${String(l?.id ?? "")}`, row: line(date(day), direction, money(c), memo(words.description, showOwner), words.last4) });
  };
  for (const l of inp.ownerDraws ?? []) push(l, "Taken Out");
  for (const l of inp.ownerMoneyIn ?? []) push(l, "Put In");
  dated.sort((a, b) => a.at.localeCompare(b.at));
  if (!dated.length) rows.push(note("No bank line in this period was sorted as the owner's money."));
  rows.push(...dated.map((d) => d.row));
  rows.push(beforeTotals());
  rows.push(total("Total Taken Out", null, money(sums.out)));
  rows.push(total("Total Put In", null, money(sums.in)));
  rows.push(
    note(
      `Total Taken Out is the Summary's ${DRAW_LABEL} for this period, and Total Put In is its ${PNL_WORDS.ownerMoneyIn} — a row the Summary carries only when there is some.`,
    ),
  );
  // WHICH DRAWS THE FIGURE CAN SEE AT ALL, in the engine's own words: both figures come from bank lines
  // somebody sorted, so cash out of the till is in neither, and an empty list is not a claim that
  // nothing was taken. Said here beside the rows, as the Summary says it beside the totals.
  rows.push(note(`${cur.ownerDrawSeen}${dated.length ? "" : " Nothing this period that the app can see, in either direction."}`));
  // Never expected (these are the rows the engine added up), and never silent if it happens.
  const drawCents = cents(cur.totals.ownerDraw ?? 0);
  const inCents = cents(cur.totals.ownerMoneyIn ?? 0);
  if (sums.out !== drawCents || sums.in !== inCents) {
    rows.push(note(`These rows don't add up to the Summary's ${DRAW_LABEL} and ${PNL_WORDS.ownerMoneyIn}; the Summary's figures are the ones Money by Month shows.`));
  }
  return rows;
}

/** The Hours column of the shift rows, added up (a null hour — a shift still on the clock — is 0). */
function sumHours(rows: { row: Row }[]): number {
  return rows.reduce((h, d) => h + (typeof d.row.cells[5] === "number" ? d.row.cells[5] : 0), 0);
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

  // ── QUESTION (a), THE SAME FUNCTION /bills READS (8a982483) ────────────────────────────────
  //
  // This tab used to build its own total: a per-account figure from supplierBalance PLUS one lump
  // row called "Bills On No Supplier Account", the first reached through `bills.supplier_account_id`
  // and the second by whatever was left over. That is the same mixture the Suppliers card was
  // making, in the accountant's deliverable, under a heading saying the suppliers had said it.
  //
  // It reads `whatISupplierOwed` now, so this tab's total and the figure on his card are the same
  // number by construction rather than by two pieces of arithmetic happening to agree. A paper on
  // no account still gets a row - one per spelling, named, never a lump - and the "How North Knows"
  // column says whose word each row is, which was always this tab's best idea.
  const { of: identity } = supplierIdentityOf(inp);
  const owed = whatISupplierOwed({
    accounts: [...accounts.values()].map((acct) => {
      const bal = supplierBalance(acct, todayYmd);
      return {
        accountId: acct.id,
        name: acct.name,
        onAccount: acct.onAccount,
        owed: bal.owed,
        model: bal.model,
        theirs: bal.supplierSays ? bal.supplierSays.gross : null,
        unmatched: bal.unmatched,
        openPapers: bal.chargedBills,
      };
    }),
    papers: (inp.bills ?? [])
      .filter((b: any) => b?.id && !b.superseded_by_bill_id)
      .map((b: any) => ({
        id: String(b.id),
        supplierAccountId: b.supplier_account_id ?? null,
        supplier: b.supplier ?? null,
        amount: b.amount,
        amountPaid: b.amount_paid == null ? null : Number(b.amount_paid) || 0,
        status: b.status ?? null,
      })),
    identity,
  });

  const HOW: Record<SupplierOwedHow, string> = {
    "my-open-bills": "What is open on North's bills after the payments matched to them",
    "my-tickets-no-account": "North's own tickets - the supplier has sent no balance",
  };
  for (const l of owed.lines) {
    suppliers.push({
      name: l.name || "A supplier North can't name",
      cents: cents(l.owed),
      how: l.accountId ? HOW[l.how] : `${HOW[l.how]}, and not on a supplier account yet`,
    });
  }
  // WHAT IS OWED, not a net position (/bills' rule): a credit with one supplier pays no other.
  for (const a of owed.ahead) ahead.push({ name: a.name, cents: cents(a.credit) });

  suppliers.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  ahead.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  return { customers, customersCents: cents(customers.outstanding), suppliers, suppliersCents: cents(owed.total), ahead };
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
  rows.push(beforeTotals());
  rows.push(total("Total", null, null, null, money(open.customersCents)));
  // WHERE THE REST OF AN OPEN INVOICE IS, said only of the invoices that are actually over there. This
  // list is as of the download day, so most of it on any past-period download was made before the
  // period; Income's register is filtered to the period (inPeriod on created_at, and the read's own
  // window). The sentence used to send the reader to Income for every row on this list, and an invoice
  // made in August is in no cell of a Q2 file.
  rows.push(
    note(
      `Drafts aren't counted: they haven't been sent. For an invoice made inside ${input.period.label}, when it was made, what kind it is and what tax it carried are on Income, under Invoices Made In This Period; one made before or after the period isn't in that list, and this row is all the file has on it.`,
    ),
  );
  rows.push(blank(), title("Suppliers Say You Owe"), head("Supplier", "Owed", "How North Knows"));
  for (const s of open.suppliers) rows.push(line(s.name, money(s.cents), s.how));
  if (!open.suppliers.length) rows.push(note(`No supplier was owed anything on ${day}.`));
  rows.push(beforeTotals());
  rows.push(total("Total", money(open.suppliersCents)));
  rows.push(note("What is open on North's own bills to each supplier, by the number each bill carries (a payment matched to a bill has come off it). Where a supplier sends its own invoices, what those say is listed below, beside it. Crew still owed is on People."));

  // THE PAPERS BEHIND THAT FIGURE (Erik, report 80cbd6fa: the download "needs to have ALL the data
  // available to be itemized"). One row per supplier above is a balance; these are the documents it is
  // read from — North's own unpaid tickets, and what each supplier's own invoices say is left on them.
  // Both lists, always, because which one DECIDES an account is the account's own model (/bills): a
  // supplier that sends invoices is owed what those say, and North's tickets are only its copy.
  const inp = input.money;
  const acctName = new Map((inp.supplierAccounts ?? []).map((a: any) => [String(a?.id), String(a?.name ?? "").trim()]));
  // THE BEST LABEL IN THE TREE, KEPT: it says WHOSE claim the figure is and does not call it a
  // debt - which is exactly what every screen reader got wrong (8a982483). It gains the one
  // exclusion it was missing: a ticket the supplier's own closed paper covers is counted inside
  // that paper already, so counting it here overstated what North had bought and not squared.
  const { of: identityHere } = supplierIdentityOf(inp);
  rows.push(blank(), title("Bills North Has Marked Unpaid"));
  rows.push(
    note(
      `Every bill on the books with money still open on it, as of ${day}, at what is open (a part-paid bill at its balance). A payment matched to a bill has already come off it (each payment is on Costs); a payment matched to no bill is money ahead on the account and is not in these figures.`,
    ),
  );
  // NAME JOBS, NOT NUMBERS: the job's own number beside its name, the way every other list on this
  // tab's neighbours prints a job.
  rows.push(head("Date", "Supplier", "Bill Number", "Amount", "Supplier Account", "Job", "Job Number"));
  const unpaid: { at: string; row: Row }[] = [];
  let unpaidCents = 0;
  for (const b of inp.bills ?? []) {
    if (!b || b.superseded_by_bill_id) continue;
    const paper = { status: String(b.status ?? ""), amount: b.amount, amountPaid: b.amount_paid == null ? null : Number(b.amount_paid) || 0 };
    if (!isOnAccountBill(paper)) continue;
    // AT WHAT IS OPEN (0383): a part-paid bill at its balance, as the figure above counts it.
    const c = cents(openOwed(paper));
    if (!c) continue;
    unpaidCents += c;
    const at = recordDay(b.bill_date, b.created_at, input.tz);
    const j = b.job_id ? input.lists.jobs.find((x) => String(x.id) === String(b.job_id)) : undefined;
    // THE ACCOUNT BY IDENTITY, NOT BY THE STORED COLUMN. This cell read `b.supplier_account_id` alone
    // while the figure it explains (openFigures -> whatISupplierOwed) resolves a ticket by the account
    // it is filed on OR a filed alias OR the account's own name. So a ticket spelled exactly like an
    // existing account but never filed landed inside "Northline Supply $60.00, Bills minus payments" in
    // the list above and read "No supplier account" in the list below it - one ticket, two answers, in
    // the deliverable whose whole job is to let the two be reconciled.
    const accountId = identityHere.get(String(b.id))?.accountId ?? null;
    unpaid.push({
      at: `${at ?? "9999-99-99"} ${String(b.id ?? "")}`,
      row: line(
        date(at),
        String(b.supplier ?? "").trim() || "A bill with no supplier named",
        b.bill_number ?? b.supplier_invoice_number ?? null,
        money(c),
        accountId ? acctName.get(String(accountId)) || "An account North can't name" : "No supplier account",
        j?.name ?? null,
        j?.job_number ?? null,
      ),
    });
  }
  unpaid.sort((a, b) => a.at.localeCompare(b.at));
  if (!unpaid.length) rows.push(note("No ticket on the books is marked unpaid."));
  rows.push(...unpaid.map((u) => u.row));
  rows.push(beforeTotals());
  rows.push(total("Total", null, null, money(unpaidCents)));
  rows.push(note("Supplier Account is the company a ticket belongs to however it was spelled — filed on the account, a spelling somebody filed, or the account's own name — which is how the figure above reaches it. Costs answers the same way for every ticket of the period."));

  rows.push(blank(), title("What Each Supplier's Own Invoices Say Is Still Open"));
  rows.push(note("The supplier's own paper, not North's: a statement invoice, a credit memo or a service charge that isn't closed. Still Open is what that document says is left on it, read exactly as the balance above reads it (openBalanceOf, /bills), so this list adds up to the supplier-invoices figure."));
  rows.push(head("Date", "Supplier", "Invoice Number", "Kind", "Total", "Still Open"));
  const docs: { at: string; row: Row }[] = [];
  let docCents = 0;
  let unfigured = 0;
  for (const d of inp.supplierDocuments ?? []) {
    if (!d || d.closed) continue;
    // STILL OPEN IS WHAT THE FIGURE ABOVE READ, both halves of it (openBalanceOf, supplier-balance.ts):
    //  - A CREDIT MEMO'S NEGATIVE STAYS NEGATIVE. It is money the supplier takes OFF the account, and
    //    the balance subtracts it, so dropping it made this list come out LARGER than the figure it
    //    exists to explain ($3,304.73 listed against a $3,273.94 balance) - the accountant could not
    //    reconcile the one to the other, which is the reverse of why the section was added.
    //  - A DOCUMENT WITH NO BALANCE RECORDED falls back to its Total, exactly as openBalanceOf does:
    //    the supplier figure counts it in full, deliberately, so a missing figure never makes what is
    //    owed look smaller than it is. Counting it as 0 here understated the list by the whole paper.
    const stated = d.open_balance == null ? cents(d.total) : cents(d.open_balance);
    // Open paper the supplier itself says has nothing left on it: it adds nothing here and nothing above.
    if (d.open_balance != null && stated === 0) continue;
    if (d.open_balance == null) unfigured += 1;
    docCents += stated;
    const at = recordDay(d.invoice_date, d.created_at, input.tz);
    docs.push({
      at: `${at ?? "9999-99-99"} ${String(d.id ?? "")}`,
      row: line(
        date(at),
        d.supplier_account_id ? acctName.get(String(d.supplier_account_id)) || "An account North can't name" : "No supplier account",
        d.invoice_number ?? null,
        // The mark rides on the row it is about, not in a sentence underneath: a reader checking one
        // line sees on that line where its Still Open came from.
        d.open_balance == null ? `${methodLabel(d.kind)} (No Balance Recorded)` : methodLabel(d.kind),
        money(cents(d.total)),
        money(stated),
      ),
    });
  }
  docs.sort((a, b) => a.at.localeCompare(b.at));
  if (!docs.length) rows.push(note("No supplier has an open document of its own on the books."));
  rows.push(...docs.map((d) => d.row));
  rows.push(beforeTotals());
  rows.push(total("Total", null, null, null, null, money(docCents)));
  if (unfigured) {
    rows.push(note("A row marked No Balance Recorded came from before North recorded one, so its Still Open is the paper's own Total. The supplier's balance above counts it the same way, in full — nothing here is left out of that figure."));
  }

  if (open.ahead.length) {
    rows.push(blank(), title("Paid Ahead (Credit With The Supplier)"), head("Supplier", "Credit"));
    for (const a of open.ahead) rows.push(line(a.name, money(a.cents)));
    rows.push(note("Paid ahead of the bills North has: the extra sits on that supplier's account and isn't taken off what the others are owed."));
  }
  // Column 4 holds the longest thing on this tab now - a Kind carrying its No Balance Recorded mark -
  // and Still Open holds a credit memo's negative, so neither is cut off in the sheet.
  return { name: "Open", rows, widths: [30, 26, 18, 28, 26, 28, 13] };
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
