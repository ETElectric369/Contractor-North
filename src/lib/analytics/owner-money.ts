import { BUSINESS_COST_BUCKETS, bucketOf, type BusinessCostBucket } from "@/lib/business-cost-buckets";
import { livePurchaseOrders } from "@/lib/job-progress-math";
import { balanceForPerson, payRateForEntry, toPayPaymentRow, type PayPaymentRow } from "@/lib/payroll-math";
import { attachRates, payRateMapRead, type PayRates } from "@/lib/profile-columns";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { formatCurrency, hoursBetween } from "@/lib/utils";
import { computeCollected, monthKeyInTz, trailing12Months } from "@/lib/analytics/money-metrics";

/**
 * LEFT FOR YOU: what the business kept for its owner (migration 0286's other half).
 *
 * Erik, 2026-09-23: "get rid of the owners wages and make everything not a cost part of the owners
 * draw", and "i need to see ... total received, total draw after expenses and payroll". ET Electric
 * is a sole proprietorship, so there is no owner salary: money received, minus the real costs, is
 * what is left for him. That one subtraction, done honestly, is this module.
 *
 *   left = received - materials_and_bills - crew_pay - crew_mileage_paid - business_costs
 *
 * EVERY LINE COMES FROM A RULE THAT ALREADY EXISTS, never a new definition:
 *   · received          = computeCollected (money-metrics), the /analytics "Collected" rule:
 *                         payments net of voided invoices, minus refunds, by the day received.
 *                         Payments on invoices with no job count, as they do there.
 *   · materials & bills = the job-cost inputs job profit uses (computeJobProfitRows): job bills
 *                         not superseded (0271), live purchase orders (livePurchaseOrders, 0142),
 *                         and the job's petty cash (not a `replenish`). Each on its own date: the
 *                         bill date, the order date, the petty-cash day; created_at when missing.
 *   · crew pay          = the Pay board's EARNED (balanceForPerson), for wages people only. Costs
 *                         count when the hours are worked, so it is bucketed by clock_in, not by
 *                         when money was handed over. See THE FROZEN-GROSS RULE below.
 *   · crew mileage      = human-typed settlement amounts only (kind='mileage' runs, 0095). Never a
 *                         rate times miles, and never folded into crew pay (the two-bucket law).
 *   · business costs    = bills and petty cash with no job, in the six buckets
 *                         (business-cost-buckets.ts). The Fees bucket also carries Stripe's real
 *                         card fee on each payment (payments.processor_fee, 0284). A NULL fee is
 *                         UNKNOWN, never $0: it is counted as a caveat, not as money.
 *
 * NO TAX MATH, NO DRAW LEDGER. What the owner actually took out is reconciliation and belongs in
 * the accountant's software (Erik: "start fresh on the draw"). This says what was LEFT, before
 * income tax, and the page says so directly under the number.
 *
 * Pure half (computeOwnerMoney) + a fetch half (getOwnerMoney) that reads the SAME row sources the
 * existing readers use, so the chart the next build puts on top of this cannot disagree with the
 * card. Everything is summed in integer CENTS so the invariant holds to the cent, per month and in
 * total: received = materials_and_bills + crew_pay + crew_mileage_paid + business_costs + left.
 */

// ── Windows ──────────────────────────────────────────────────────────────────

/** The three segments of the card's control. */
export type OwnerMoneySegmentKey = "this_month" | "last_month" | "this_year";
/** One calendar month, "YYYY-MM": the window a tap on the Money by Month chart selects. */
export type OwnerMoneyMonthKey = `${number}-${number}`;
/** What the card can be showing: a segment, or one month the chart selected. */
export type OwnerMoneyWindowKey = OwnerMoneySegmentKey | OwnerMoneyMonthKey;

export const OWNER_MONEY_WINDOWS: { key: OwnerMoneySegmentKey; label: string }[] = [
  { key: "this_month", label: "This Month" },
  { key: "last_month", label: "Last Month" },
  { key: "this_year", label: "This Year" },
];

export function isOwnerMoneySegmentKey(v: unknown): v is OwnerMoneySegmentKey {
  return v === "this_month" || v === "last_month" || v === "this_year";
}

const MONTH_KEY_RE =/^\d{4}-(0[1-9]|1[0-2])$/;

/** Shape only ("YYYY-MM" with a real month). Whether the page READ that month is
 *  parseOwnerMoneyMonthKey's question. */
export function isOwnerMoneyMonthKey(v: unknown): v is OwnerMoneyMonthKey {
  return typeof v === "string" && MONTH_KEY_RE.test(v);
}

const ymd = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

/** The months the chart covers: the last 12, ending with the org's current month, oldest first
 *  (the same trailing12Months the Collected tile reads). */
export function chartMonthKeys(todayYmd: string): OwnerMoneyMonthKey[] {
  return trailing12Months(todayYmd) as OwnerMoneyMonthKey[];
}

/**
 * A "?w=" value as a month the card may show, or null. VALIDATED ON THE SERVER: only a real
 * "YYYY-MM" inside the chart's 12 months passes, so a hand-typed ?w=2019-03 (rows the page never
 * reads) or ?w=2026-13 can never make the card print a month it did not fetch.
 */
export function parseOwnerMoneyMonthKey(v: unknown, todayYmd: string): OwnerMoneyMonthKey | null {
  if (!isOwnerMoneyMonthKey(v)) return null;
  return chartMonthKeys(todayYmd).includes(v) ? v : null;
}

/**
 * What the card shows, from the page's search params. `w` is a segment or a month; `from` remembers
 * the segment a month was tapped from, so tapping that month again goes back to it. Anything invalid
 * falls back to This Year (the card's default), never to an error.
 */
export function resolveOwnerMoneySelection(
  w: unknown,
  from: unknown,
  todayYmd: string,
): { windowKey: OwnerMoneyWindowKey; segment: OwnerMoneySegmentKey; month: OwnerMoneyMonthKey | null } {
  if (isOwnerMoneySegmentKey(w)) return { windowKey: w, segment: w, month: null };
  const segment: OwnerMoneySegmentKey = isOwnerMoneySegmentKey(from) ? from : "this_year";
  const month = parseOwnerMoneyMonthKey(w, todayYmd);
  return { windowKey: month ?? segment, segment, month };
}

/** "August 2026" for "2026-08". */
export function monthLongLabel(month: string): string {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** A window of ORG-LOCAL days: `start` inclusive, `end` exclusive, both "YYYY-MM-DD". The chart's
 *  own window is "last_12_months". */
export type OwnerMoneyWindow = { key: OwnerMoneyWindowKey | "last_12_months"; label: string; start: string; end: string };

/** The window for a key, relative to the org's today. Month arithmetic is day-1-pinned. A month key
 *  is that calendar month (the page validated it with parseOwnerMoneyMonthKey). */
export function ownerMoneyWindow(key: OwnerMoneyWindowKey, todayYmd: string): OwnerMoneyWindow {
  const [y, m] = todayYmd.split("-").map(Number);
  if (isOwnerMoneyMonthKey(key)) {
    const [ky, km] = key.split("-").map(Number);
    return { key, label: monthLongLabel(key), start: ymd(ky, km), end: ymd(ky, km + 1) };
  }
  const label = OWNER_MONEY_WINDOWS.find((w) => w.key === key)?.label ?? "This Year";
  if (key === "this_month") return { key, label, start: ymd(y, m), end: ymd(y, m + 1) };
  if (key === "last_month") return { key, label, start: ymd(y, m - 1), end: ymd(y, m) };
  return { key, label, start: `${y}-01-01`, end: `${y + 1}-01-01` };
}

/** The chart's window: the last 12 months, ending with the org's current month. */
export function ownerMoneyChartWindow(todayYmd: string): OwnerMoneyWindow {
  const [y, m] = todayYmd.split("-").map(Number);
  return { key: "last_12_months", label: "Last 12 Months", start: ymd(y, m - 11), end: ymd(y, m + 1) };
}

/**
 * ONE READ FOR EVERY WINDOW ON THE PAGE: the span covering all of them, earliest start to latest
 * end. computeOwnerMoney buckets every row into its own month and ignores months outside the window
 * it is asked for, so a window computed from rows read over a WIDER span is exactly that window
 * computed from its own read. That is what lets the chart and the card below it share one read and
 * never disagree.
 */
export function ownerMoneyReadSpan(windows: { start: string; end: string }[]): { start: string; end: string } {
  if (!windows.length) throw new Error("ownerMoneyReadSpan needs at least one window");
  let { start, end } = windows[0];
  for (const w of windows) {
    if (w.start < start) start = w.start;
    if (w.end > end) end = w.end;
  }
  return { start, end };
}

/** True when every day of `win` is inside what a read over `span` fetched. */
export function windowInsideSpan(win: { start: string; end: string }, span: { start: string; end: string }): boolean {
  return win.start >= span.start && win.end <= span.end;
}

/** The "YYYY-MM" months a window covers, oldest first, never past the org's current month. */
export function windowMonths(win: { start: string; end: string }, todayYmd?: string): string[] {
  const out: string[] = [];
  const cap = todayYmd ? todayYmd.slice(0, 7) : null;
  let [y, m] = win.start.split("-").map(Number);
  const endKey = win.end.slice(0, 7);
  for (let i = 0; i < 240; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key >= endKey) break;
    if (cap && key > cap) break;
    out.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

// ── Shapes ───────────────────────────────────────────────────────────────────

export type BucketAmounts = Record<BusinessCostBucket, number>;

/** One month (or the window's total). Dollars, rounded to cents; every sum was done in cents. */
export type OwnerMoneyFigures = {
  received: number;
  materialsAndBills: number;
  crewPay: number;
  crewMileagePaid: number;
  /** The six buckets. Fees INCLUDES processorFees below. */
  businessCosts: BucketAmounts;
  businessCostsTotal: number;
  /** Stripe's real card/bank fees on payments received in the period (already inside Fees). */
  processorFees: number;
  left: number;
  ownerHours: number;
  /** left / ownerHours, or null when the owner logged no hours. */
  perOwnerHour: number | null;
};

export type OwnerMoneyMonth = OwnerMoneyFigures & { month: string };

export type OwnerMoneyCaveat =
  | { kind: "unknown_fees"; count: number }
  | { kind: "credit_memos"; count: number; total: number }
  | { kind: "service_charges"; count: number; total: number }
  | { kind: "open_shifts"; count: number }
  | { kind: "crew_owed"; total: number }
  | { kind: "unpaid_bills"; count: number; total: number }
  | { kind: "records_start"; date: string };

export type OwnerMoney = {
  window: OwnerMoneyWindow;
  totals: OwnerMoneyFigures;
  /** One row per month in the window, oldest first: the chart's series. Sums to `totals`. */
  months: OwnerMoneyMonth[];
  caveats: OwnerMoneyCaveat[];
  /** The owners whose hours are counted (paid by owner's draw). */
  owners: { id: string; name: string }[];
};

export type OwnerMoneyPerson = { name: string; paidByDraw: boolean; hourlyRate: number | null };

export type OwnerMoneyInputs = {
  /** payments: amount, paid_at, processor_fee, stripe_payment_intent, invoices { status }. */
  payments: any[];
  /** customer_credits with disposition 'refund': amount, created_at. */
  refunds: any[];
  /** bills: id, job_id, amount, bill_date, created_at, category, status, po_id, superseded_by_bill_id.
   *  ALL of them, not just the window's: a PO is superseded by its bill whenever the bill is dated. */
  bills: any[];
  /** purchase_orders: id, job_id, total, status, ordered_at, created_at. All of them. */
  pos: any[];
  /** petty_cash: job_id, amount, kind, category, tx_date, created_at. */
  pettyCash: any[];
  /** time_entries (closed AND open) with profiles merged from the rates read (attachRates):
   *  id, profile_id, status, clock_in, clock_out, lunch_minutes, rate_override, paid_at. The rows
   *  the Pay board reads, so crew pay and its "owed" agree with it. */
  entries: any[];
  /** payroll_runs, every kind: profile_id, kind, period_start, period_end, gross, mileage_amount, created_at. */
  runs: any[];
  /** pay_payments rows (raw), for the "earned but not recorded as paid" caveat. */
  payPayments: any[];
  /** supplier_invoices whose kind is 'credit_memo' and that NO bill covers: total, invoice_date,
   *  created_at. A memo a bill covers is already inside Materials & Bills as that negative bill, so
   *  naming it as "not counted" too would contradict the card (see supplierDocsNoBillCovers). */
  creditMemos: any[];
  /** Everyone the rates read returned, by profile id. */
  people: Map<string, OwnerMoneyPerson>;
  /** The org-local day of the first payment or first shift (when the books began being kept), or
   *  null when unknown. Backdated receipts do not move it; see getOwnerMoney. */
  recordsStart: string | null;
  /** The org-local day of the first payment ever received (all time, not just the span read), or
   *  null when there is none. The chart's empty state reads it: an empty 12 months with money before
   *  them is "nothing in the last 12 months", not "nothing yet". */
  firstPaymentDay?: string | null;
  /** supplier_invoices whose kind is 'service_charge' and that no bill covers: late interest the
   *  supplier charged that is not on the books as a cost. total, invoice_date, created_at. */
  unbilledServiceCharges?: any[];
};

// ── Arithmetic helpers (cents) ───────────────────────────────────────────────

const toCents = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
};
const fromCents = (c: number): number => Math.round(c) / 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The ORG-LOCAL day of a record: its own DATE column when it has one, else its timestamp read in
 *  the org's zone (a 6 PM Pacific receipt on Jun 30 is a June cost), else null. */
export function recordDay(dateCol: unknown, fallbackTs: unknown, tz: string): string | null {
  const d = String(dateCol ?? "").slice(0, 10);
  if (DATE_RE.test(d)) return d;
  if (fallbackTs == null || fallbackTs === "") return null;
  const t = new Date(String(fallbackTs));
  return Number.isFinite(t.getTime()) ? todayStrInTz(tz, t) : null;
}

/**
 * Split `totalCents` over keys in proportion to `weights`, by largest remainder, so the parts are
 * whole cents and ALWAYS sum to the total exactly. Weights at or below zero get nothing; if none is
 * positive the result is empty and the caller decides where the money goes.
 */
export function allocateCents(totalCents: number, weights: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const entries = [...weights.entries()].filter(([, w]) => Number.isFinite(w) && w > 0);
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  if (!entries.length || !(sum > 0)) return out;
  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(Math.round(totalCents));
  let given = 0;
  const parts = entries.map(([k, w]) => {
    const exact = (abs * w) / sum;
    const floor = Math.floor(exact);
    given += floor;
    return { k, floor, rem: exact - floor };
  });
  // Hand the leftover cents to the largest remainders; ties go to the earlier key (stable order).
  const order = parts.map((p, i) => ({ i, rem: p.rem })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let j = 0; j < abs - given; j++) parts[order[j % order.length].i].floor += 1;
  for (const p of parts) out.set(p.k, sign * p.floor);
  return out;
}

const emptyBuckets = (): Record<BusinessCostBucket, number> =>
  Object.fromEntries(BUSINESS_COST_BUCKETS.map((b) => [b, 0])) as Record<BusinessCostBucket, number>;

type Acc = {
  received: number;
  materials: number;
  crewPay: number;
  mileage: number;
  buckets: Record<BusinessCostBucket, number>;
  fees: number;
  ownerHours: number; // hundredths of an hour, summed from hoursBetween's 2-decimal hours
};
const newAcc = (): Acc => ({ received: 0, materials: 0, crewPay: 0, mileage: 0, buckets: emptyBuckets(), fees: 0, ownerHours: 0 });

// ── THE FROZEN-GROSS RULE ────────────────────────────────────────────────────
/**
 * CREW PAY, BY THE MONTH THE HOURS WERE WORKED, AND EQUAL TO THE PAY BOARD'S EARNED.
 *
 * Earned (balanceForPerson) has two halves, and each gets a month the honest way:
 *
 *   1. UNLOCKED closed hours are priced live (hours x payRateForEntry, the rate_override honored),
 *      exactly as the Pay board prices them, and each shift's gross belongs to the month of its
 *      clock_in. The person's live total is rounded ONCE, as balanceForPerson rounds it, and those
 *      cents are spread back over the months by largest remainder, so the months add up to it.
 *
 *   2. A LOCKED pay period is worth the gross FROZEN on its payroll_runs row(s) when it locked
 *      (Erik 2026-09-17: a raise applies forward only, so a locked period never re-prices). That
 *      frozen figure has no month of its own and a biweekly period can straddle two. So it is spread
 *      over the months of the shifts it locked (paid_at set, clock_in's org-local day inside
 *      [period_start, period_end)), IN PROPORTION TO WHAT EACH SHIFT WOULD PRICE AT TODAY'S RATES.
 *      The ratio is what matters, and a raise moves every shift in the period by the same factor,
 *      so the split stays true even though the dollars are the frozen ones. If today's rates price
 *      the period at nothing, the split falls back to hours; if no locked shift can be found for it
 *      (rows outside what was read), the whole period lands in the month its period starts.
 *      Two runs for the same period (a late shift locked afterwards) are one frozen total.
 *
 * Only kind 'base' runs are wages; a kind 'mileage' run is reimbursement and never lands here.
 * Owners (paid by owner's draw) are skipped entirely, including any old run of theirs.
 */
function crewPayByMonth(
  entries: any[],
  runs: any[],
  people: Map<string, OwnerMoneyPerson>,
  tz: string,
): Map<string, Map<string, number>> {
  // person -> month -> cents
  const out = new Map<string, Map<string, number>>();
  const add = (pid: string, month: string, cents: number) => {
    if (!cents) return;
    const per = out.get(pid) ?? new Map<string, number>();
    per.set(month, (per.get(month) ?? 0) + cents);
    out.set(pid, per);
  };
  const isDraw = (pid: string) => people.get(pid)?.paidByDraw === true;
  const fallbackOf = (pid: string) => Number(people.get(pid)?.hourlyRate ?? 0) || 0;

  const closedBy = new Map<string, any[]>();
  for (const e of entries ?? []) {
    const pid = e?.profile_id ? String(e.profile_id) : "";
    if (!pid || isDraw(pid) || !e.clock_out) continue;
    const list = closedBy.get(pid) ?? [];
    list.push(e);
    closedBy.set(pid, list);
  }

  // 1. The live half.
  for (const [pid, list] of closedBy) {
    const raw = new Map<string, number>();
    let total = 0;
    for (const e of list) {
      if (e.paid_at) continue;
      const g = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) * payRateForEntry(e, fallbackOf(pid));
      if (!(g > 0)) continue;
      const month = recordDay(null, e.clock_in, tz)?.slice(0, 7);
      if (!month) continue;
      raw.set(month, (raw.get(month) ?? 0) + g);
      total += g;
    }
    const cents = allocateCents(Math.round(total * 100), raw);
    for (const [month, c] of cents) add(pid, month, c);
  }

  // 2. The frozen half.
  type Group = { pid: string; start: string; end: string; cents: number };
  const groups = new Map<string, Group>();
  for (const r of runs ?? []) {
    if (r?.kind && r.kind !== "base") continue;
    const pid = r?.profile_id ? String(r.profile_id) : "";
    if (!pid || isDraw(pid)) continue;
    const start = String(r.period_start ?? "").slice(0, 10);
    const end = String(r.period_end ?? "").slice(0, 10);
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) continue;
    const key = `${pid}|${start}|${end}`;
    const g = groups.get(key) ?? { pid, start, end, cents: 0 };
    g.cents += toCents(r.gross);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (!g.cents) continue;
    const byGross = new Map<string, number>();
    const byHours = new Map<string, number>();
    for (const e of closedBy.get(g.pid) ?? []) {
      if (!e.paid_at) continue;
      const day = recordDay(null, e.clock_in, tz);
      if (!day || day < g.start || day >= g.end) continue;
      const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
      const month = day.slice(0, 7);
      byHours.set(month, (byHours.get(month) ?? 0) + h);
      byGross.set(month, (byGross.get(month) ?? 0) + h * payRateForEntry(e, fallbackOf(g.pid)));
    }
    let split = allocateCents(g.cents, byGross);
    if (!split.size) split = allocateCents(g.cents, byHours);
    if (!split.size) split = new Map([[g.start.slice(0, 7), g.cents]]);
    for (const [month, c] of split) add(g.pid, month, c);
  }
  return out;
}

// ── THE PURE HALF ────────────────────────────────────────────────────────────

export function computeOwnerMoney(inp: OwnerMoneyInputs, win: OwnerMoneyWindow, tz: string, todayYmd?: string): OwnerMoney {
  const months = windowMonths(win, todayYmd);
  const inWindow = new Set(months);
  const acc = new Map<string, Acc>(months.map((m) => [m, newAcc()]));
  const at = (month: string | null | undefined): Acc | null => (month && inWindow.has(month) ? acc.get(month)! : null);
  const monthOfDay = (day: string | null) => (day ? day.slice(0, 7) : null);
  const inDays = (day: string | null) => !!day && day >= win.start && day < win.end;
  const winStartMonth = win.start.slice(0, 7);
  const winEndMonth = win.end.slice(0, 7);

  // RECEIVED: computeCollected per month, over exactly that month's rows. The same function
  // /billing and /payments headline with, the same void rule computeRevenueTrend applies.
  const payByMonth = new Map<string, any[]>();
  for (const p of inp.payments ?? []) {
    if (!p?.paid_at) continue;
    const k = monthKeyInTz(p.paid_at, tz);
    if (!inWindow.has(k)) continue;
    const list = payByMonth.get(k) ?? [];
    list.push(p);
    payByMonth.set(k, list);
  }
  const refundByMonth = new Map<string, any[]>();
  for (const r of inp.refunds ?? []) {
    if (!r?.created_at) continue;
    const k = monthKeyInTz(r.created_at, tz);
    if (!inWindow.has(k)) continue;
    const list = refundByMonth.get(k) ?? [];
    list.push(r);
    refundByMonth.set(k, list);
  }
  for (const m of months) acc.get(m)!.received = toCents(computeCollected(payByMonth.get(m) ?? [], refundByMonth.get(m) ?? []));

  // CARD FEES: Stripe's real fee on each payment received in the window, into the Fees bucket. A
  // Stripe payment whose fee is still NULL is UNKNOWN: it is counted as a caveat, never as $0.
  let unknownFees = 0;
  for (const [m, list] of payByMonth) {
    const a = acc.get(m)!;
    for (const p of list) {
      if (p.processor_fee != null && p.processor_fee !== "") a.fees += toCents(p.processor_fee);
      else if (p.stripe_payment_intent) unknownFees += 1;
    }
  }

  // MATERIALS & BILLS: exactly the job-cost inputs job profit uses.
  const liveBills = (inp.bills ?? []).filter((b) => b && !b.superseded_by_bill_id);
  for (const b of liveBills) {
    if (!b.job_id) continue;
    const a = at(monthOfDay(recordDay(b.bill_date, b.created_at, tz)));
    if (a) a.materials += toCents(b.amount);
  }
  // Live POs over ALL live bills: a PO is superseded by its bill whatever month the bill is in.
  for (const p of livePurchaseOrders((inp.pos ?? []) as any[], liveBills as any[])) {
    if (!(p as any).job_id) continue;
    const a = at(monthOfDay(recordDay(null, (p as any).ordered_at ?? (p as any).created_at, tz)));
    if (a) a.materials += toCents((p as any).total);
  }
  for (const pc of inp.pettyCash ?? []) {
    if (!pc || pc.kind === "replenish") continue;
    const a = at(monthOfDay(recordDay(pc.tx_date, pc.created_at, tz)));
    if (!a) continue;
    if (pc.job_id) a.materials += toCents(pc.amount);
    else a.buckets[bucketOf(pc.category)] += toCents(pc.amount);
  }
  // BUSINESS COSTS: bills with no job, in their bucket.
  for (const b of liveBills) {
    if (b.job_id) continue;
    const a = at(monthOfDay(recordDay(b.bill_date, b.created_at, tz)));
    if (a) a.buckets[bucketOf(b.category)] += toCents(b.amount);
  }

  // CREW PAY: earned, by the month the hours were worked (the frozen-gross rule above).
  const crew = crewPayByMonth(inp.entries ?? [], inp.runs ?? [], inp.people, tz);
  for (const per of crew.values()) for (const [m, c] of per) {
    const a = at(m);
    if (a) a.crewPay += c;
  }

  // CREW MILEAGE: human-typed settlement amounts only, on the day the settlement was recorded (the
  // amount does not exist before a person types it). Its own line, never inside crew pay.
  for (const r of inp.runs ?? []) {
    if (r?.kind !== "mileage") continue;
    const pid = r.profile_id ? String(r.profile_id) : "";
    if (pid && inp.people.get(pid)?.paidByDraw) continue;
    const a = at(monthOfDay(recordDay(null, r.created_at, tz)));
    if (a) a.mileage += toCents(r.mileage_amount);
  }

  // OWNER HOURS: every owner's closed shifts, by the month worked.
  const owners = new Map<string, { id: string; name: string }>();
  for (const [id, p] of inp.people) if (p.paidByDraw) owners.set(id, { id, name: p.name });
  let openShifts = 0;
  for (const e of inp.entries ?? []) {
    const day = recordDay(null, e?.clock_in, tz);
    if (!e?.clock_out) {
      if (inDays(day)) openShifts += 1;
      continue;
    }
    const pid = e.profile_id ? String(e.profile_id) : "";
    if (!pid || !inp.people.get(pid)?.paidByDraw) continue;
    const a = at(monthOfDay(day));
    if (a) a.ownerHours += Math.round(hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) * 100);
  }

  // ── Figures ──
  const figures = (a: Acc): OwnerMoneyFigures => {
    const buckets = { ...a.buckets };
    buckets.Fees += a.fees;
    const bizCents = BUSINESS_COST_BUCKETS.reduce((s, b) => s + buckets[b], 0);
    const leftCents = a.received - a.materials - a.crewPay - a.mileage - bizCents;
    const hours = a.ownerHours / 100;
    return {
      received: fromCents(a.received),
      materialsAndBills: fromCents(a.materials),
      crewPay: fromCents(a.crewPay),
      crewMileagePaid: fromCents(a.mileage),
      businessCosts: Object.fromEntries(BUSINESS_COST_BUCKETS.map((b) => [b, fromCents(buckets[b])])) as BucketAmounts,
      businessCostsTotal: fromCents(bizCents),
      processorFees: fromCents(a.fees),
      left: fromCents(leftCents),
      ownerHours: hours,
      perOwnerHour: hours > 0 ? Math.round((leftCents / 100 / hours) * 100) / 100 : null,
    };
  };
  const total = newAcc();
  for (const a of acc.values()) {
    total.received += a.received;
    total.materials += a.materials;
    total.crewPay += a.crewPay;
    total.mileage += a.mileage;
    total.fees += a.fees;
    total.ownerHours += a.ownerHours;
    for (const b of BUSINESS_COST_BUCKETS) total.buckets[b] += a.buckets[b];
  }

  // ── Caveats (each only when it applies) ──
  const caveats: OwnerMoneyCaveat[] = [];
  if (unknownFees > 0) caveats.push({ kind: "unknown_fees", count: unknownFees });

  let memoCount = 0;
  let memoCents = 0;
  for (const cm of inp.creditMemos ?? []) {
    if (!inDays(recordDay(cm?.invoice_date, cm?.created_at, tz))) continue;
    memoCount += 1;
    memoCents += Math.abs(toCents(cm.total));
  }
  if (memoCount > 0) caveats.push({ kind: "credit_memos", count: memoCount, total: fromCents(memoCents) });

  // A supplier's late interest that no bill covers is a real cost the books do not hold yet. Named,
  // never guessed into a bucket: the person who files it decides (the Fees bucket's own rule).
  let scCount = 0;
  let scCents = 0;
  for (const sc of inp.unbilledServiceCharges ?? []) {
    if (!inDays(recordDay(sc?.invoice_date, sc?.created_at, tz))) continue;
    scCount += 1;
    scCents += Math.abs(toCents(sc.total));
  }
  if (scCount > 0) caveats.push({ kind: "service_charges", count: scCount, total: fromCents(scCents) });

  if (openShifts > 0) caveats.push({ kind: "open_shifts", count: openShifts });

  // Crew pay earned but not recorded as paid, FOR THIS WINDOW. The card prints it as "Counted, though
  // not paid yet: $X of crew pay", so it may only name pay that is inside the Crew Pay line above.
  // Each person's all-time unpaid balance is the Pay board's You Owe (the SAME balanceForPerson over
  // the same rows). Payments are unallocated amounts, so they pay the OLDEST earnings first and the
  // unpaid dollars are the NEWEST ones: of a balance B, the months after the window absorb theirs
  // first (E_after), and what remains, up to what the window earned (E_window), is this window's:
  //   unpaid in window = clamp(B - E_after, 0, E_window)
  // So Last Month never names September's pay, and a This Year read in January names none of 2026's.
  {
    const byPerson = new Map<string, { entries: any[]; runs: any[]; payments: PayPaymentRow[] }>();
    const slot = (pid: string) => {
      const s = byPerson.get(pid) ?? { entries: [], runs: [], payments: [] };
      byPerson.set(pid, s);
      return s;
    };
    for (const e of inp.entries ?? []) if (e?.profile_id) slot(String(e.profile_id)).entries.push(e);
    for (const r of inp.runs ?? []) {
      if (!r?.profile_id || (r.kind && r.kind !== "base")) continue;
      slot(String(r.profile_id)).runs.push({ period_start: String(r.period_start), period_end: String(r.period_end), gross: Number(r.gross ?? 0) });
    }
    for (const p of (inp.payPayments ?? []).map(toPayPaymentRow)) if (p.profileId) slot(p.profileId).payments.push(p);
    let owedCents = 0;
    for (const [pid, s] of byPerson) {
      const person = inp.people.get(pid);
      if (person?.paidByDraw) continue;
      const b = balanceForPerson({
        profileId: pid,
        name: person?.name ?? "",
        entries: s.entries,
        lockedRuns: s.runs,
        payments: s.payments,
        tz,
        fallbackRate: Number(person?.hourlyRate ?? 0) || 0,
      });
      if (!(b.owed > 0.005)) continue;
      let eWindow = 0;
      let eAfter = 0;
      for (const [m, c] of crew.get(pid) ?? []) {
        if (m >= winEndMonth) eAfter += c;
        else if (m >= winStartMonth) eWindow += c;
      }
      owedCents += Math.min(Math.max(toCents(b.owed) - eAfter, 0), eWindow);
    }
    if (owedCents > 0) caveats.push({ kind: "crew_owed", total: fromCents(owedCents) });
  }

  {
    let n = 0;
    let c = 0;
    for (const b of liveBills) {
      if (String(b.status ?? "").toLowerCase() !== "unpaid") continue;
      if (!inDays(recordDay(b.bill_date, b.created_at, tz))) continue;
      n += 1;
      c += toCents(b.amount);
    }
    if (n > 0) caveats.push({ kind: "unpaid_bills", count: n, total: fromCents(c) });
  }

  if (inp.recordsStart && inp.recordsStart > win.start && inp.recordsStart < win.end) {
    caveats.push({ kind: "records_start", date: inp.recordsStart });
  }

  return {
    window: win,
    totals: figures(total),
    months: months.map((m) => ({ month: m, ...figures(acc.get(m)!) })),
    caveats,
    owners: [...owners.values()],
  };
}

// ── Words ────────────────────────────────────────────────────────────────────

const shortDay = (ymdStr: string) =>
  new Date(`${ymdStr}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A cost line's figure on the receipt: "−$1,200.00" for money out. A line that nets NEGATIVE (a
 *  supplier credit filed as a negative bill, J-011's -$51.58) is money back and reads "+$51.58",
 *  never "−-$51.58". Zero is plain "$0.00". */
export function costFigure(n: number): string {
  if (Math.abs(n) < 0.005) return formatCurrency(0);
  return n > 0 ? `\u2212${formatCurrency(n)}` : `+${formatCurrency(Math.abs(n))}`;
}

/** "This Year (records start Jun 11)": the window, with the honest start when records begin late. */
export function windowLabel(m: OwnerMoney): string {
  const start = m.caveats.find((c) => c.kind === "records_start") as { date: string } | undefined;
  return start ? `${m.window.label} (records start ${shortDay(start.date)})` : m.window.label;
}

/** The one short "Not counted:" line, or null when everything is counted. */
export function notCountedLine(m: OwnerMoney): string | null {
  const parts: string[] = [];
  for (const c of m.caveats) {
    if (c.kind === "unknown_fees") parts.push(`card fees on ${c.count} ${c.count === 1 ? "payment" : "payments"} Stripe has not reported yet`);
    if (c.kind === "credit_memos") parts.push(`${money(c.total)} of supplier credit memos (${c.count})`);
    if (c.kind === "service_charges") parts.push(`${money(c.total)} of supplier late charges not filed as bills (${c.count})`);
    if (c.kind === "open_shifts") parts.push(`${c.count} ${c.count === 1 ? "shift" : "shifts"} still on the clock`);
  }
  return parts.length ? `Not counted: ${parts.join("; ")}.` : null;
}

/** What IS counted but has not been paid yet: said so a figure that is still owed never reads as
 *  money already gone. Null when there is none. */
export function countedNotPaidLine(m: OwnerMoney): string | null {
  const parts: string[] = [];
  for (const c of m.caveats) {
    if (c.kind === "crew_owed") parts.push(`${money(c.total)} of crew pay`);
    if (c.kind === "unpaid_bills") parts.push(`${money(c.total)} of supplier bills`);
  }
  return parts.length ? `Counted, though not paid yet: ${parts.join(" and ")}.` : null;
}

// ── THE FETCH HALF ───────────────────────────────────────────────────────────

const PAGE_ROWS = 1000;
const MAX_PAGES = 50;

/** Page a read to the end by the rows actually returned (PostgREST caps a page silently), or say
 *  which read did not come back whole. Money is subtraction: half a list is a confident wrong number. */
async function readEvery<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; problem: string | null }> {
  const out: T[] = [];
  for (let i = 0, from = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error || !Array.isArray(data)) return { rows: [], problem: `the ${what} could not be read` };
    if (!data.length) return { rows: out, problem: null };
    out.push(...data);
    from += data.length;
  }
  return { rows: [], problem: `there are too many ${what} to read at once` };
}

/**
 * Supplier credit memos and service charges that NO bill covers (rows carry bill_supplier_invoices).
 * Once a bill covers a document it is already in Materials & Bills as that bill (a credit memo as a
 * negative bill, the 518 Crater Lake correction), so it must not also be named as "not counted".
 */
export function supplierDocsNoBillCovers(rows: any[]): { creditMemos: any[]; unbilledServiceCharges: any[] } {
  const uncovered = (rows ?? []).filter(
    (s: any) => s && !(Array.isArray(s.bill_supplier_invoices) && s.bill_supplier_invoices.length),
  );
  return {
    creditMemos: uncovered.filter((s: any) => s.kind === "credit_memo"),
    unbilledServiceCharges: uncovered.filter((s: any) => s.kind === "service_charge"),
  };
}

/** How far back hours are read: the Pay board's own bound (payroll/page.tsx BALANCE_MONTHS), so the
 *  crew-owed caveat and crew pay are built from the rows that board reads. */
const BALANCE_MONTHS = 18;

/**
 * Everything computeOwnerMoney needs, fetched through the same row sources the existing readers use
 * (the RLS-scoped caller's own org), then computed. Returns `problem` instead of figures when any
 * read did not come back whole, so the card can refuse rather than print a wrong number.
 */
export async function getOwnerMoney(
  supabase: any,
  key: OwnerMoneyWindowKey,
  /** The org's timezone. The caller already read the org's settings (/analytics does, for its own
   *  month buckets), so this takes it rather than spending a round trip on a second settings read
   *  before every other read could start. */
  tz: string,
  now: Date = new Date(),
): Promise<{ money: OwnerMoney | null; problem: string | null }> {
  const todayYmd = todayStrInTz(tz, now);
  const { views, problem } = await getOwnerMoneyViews(supabase, [ownerMoneyWindow(key, todayYmd)], tz, todayYmd);
  return { money: views?.[0] ?? null, problem };
}

/**
 * SEVERAL WINDOWS, ONE READ (/analytics: the Money by Month chart's 12 months and the card's window).
 * The rows are read ONCE over the span covering every window, then each window is computed from
 * those same rows with the pure computeOwnerMoney, so the chart's August and the card's August are
 * the same arithmetic over the same rows. A window outside the span it was read over would be
 * computed from partial rows and print a confident wrong number; the span is built from the windows
 * so that cannot happen, and it is checked anyway: the check refuses rather than computes.
 */
export async function getOwnerMoneyViews(
  supabase: any,
  windows: OwnerMoneyWindow[],
  tz: string,
  todayYmd: string,
): Promise<{ views: OwnerMoney[] | null; problem: string | null; firstPaymentDay: string | null }> {
  const span = ownerMoneyReadSpan(windows);
  if (!windows.every((w) => windowInsideSpan(w, span))) return { views: null, problem: "the months asked for were not all read", firstPaymentDay: null };
  const { inputs, problem } = await readOwnerMoneyInputs(supabase, span, tz, todayYmd);
  if (!inputs) return { views: null, problem, firstPaymentDay: null };
  return { views: windows.map((w) => computeOwnerMoney(inputs, w, tz, todayYmd)), problem: null, firstPaymentDay: inputs.firstPaymentDay ?? null };
}

/** The rows computeOwnerMoney needs for any window inside `span`, read once. */
export async function readOwnerMoneyInputs(
  supabase: any,
  span: { start: string; end: string },
  tz: string,
  todayYmd: string,
): Promise<{ inputs: OwnerMoneyInputs | null; problem: string | null }> {
  const startIso = tzDayStartUtc(span.start, tz).toISOString();
  const endIso = tzDayStartUtc(span.end, tz).toISOString();
  const balanceStart = (() => {
    const d = new Date(`${todayYmd}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - BALANCE_MONTHS);
    const ymdStr = d.toISOString().slice(0, 10);
    return (ymdStr < span.start ? ymdStr : span.start);
  })();
  // A locked period can start up to a month before the window and still spread pay into it.
  const entriesFrom = tzDayStartUtc(balanceStart, tz).toISOString();

  const [payments, refunds, bills, pos, petty, entries, runs, payPayments, memos, ratesRead, names, firsts] = await Promise.all([
    readEvery<any>("payments", (f, t) =>
      supabase
        .from("payments")
        .select("id, amount, paid_at, processor_fee, stripe_payment_intent, invoices(status)")
        .gte("paid_at", startIso)
        .lt("paid_at", endIso)
        .order("id")
        .range(f, t),
    ),
    readEvery<any>("refunds", (f, t) =>
      supabase
        .from("customer_credits")
        .select("id, amount, created_at")
        .eq("disposition", "refund")
        .gte("created_at", startIso)
        .lt("created_at", endIso)
        .order("id")
        .range(f, t),
    ),
    // Every live bill (0271: a superseded one is a duplicate): the window's are costs, and every
    // one of them can supersede a purchase order.
    readEvery<any>("bills", (f, t) =>
      supabase
        .from("bills")
        .select("id, job_id, amount, bill_date, created_at, category, status, po_id, superseded_by_bill_id")
        .is("superseded_by_bill_id", null)
        .order("id")
        .range(f, t),
    ),
    readEvery<any>("purchase orders", (f, t) =>
      supabase.from("purchase_orders").select("id, job_id, total, status, ordered_at, created_at").order("id").range(f, t),
    ),
    readEvery<any>("petty cash", (f, t) =>
      supabase.from("petty_cash").select("id, job_id, amount, kind, category, tx_date, created_at").order("id").range(f, t),
    ),
    readEvery<any>("hours", (f, t) =>
      supabase
        .from("time_entries")
        .select("id, profile_id, status, clock_in, clock_out, lunch_minutes, rate_override, paid_at, mileage_paid_at, miles, profiles(full_name)")
        .gte("clock_in", entriesFrom)
        .order("id")
        .range(f, t),
    ),
    readEvery<any>("pay periods", (f, t) =>
      supabase
        .from("payroll_runs")
        .select("id, profile_id, kind, period_start, period_end, gross, mileage_amount, created_at")
        .order("id")
        .range(f, t),
    ),
    readEvery<any>("crew payments", (f, t) =>
      supabase
        .from("pay_payments")
        .select("id, profile_id, amount, paid_on, method, reference, note, needs_check, voided_at")
        .order("id")
        .range(f, t),
    ),
    // Credit memos (named, not subtracted, until a bill covers one) and service charges, each with
    // the bills that cover it, so a memo or late charge already filed is not named twice.
    readEvery<any>("supplier credit memos", (f, t) =>
      supabase
        .from("supplier_invoices")
        .select("id, kind, total, invoice_date, created_at, bill_supplier_invoices(id)")
        .in("kind", ["credit_memo", "service_charge"])
        .order("id")
        .range(f, t),
    ),
    payRateMapRead(supabase),
    supabase.from("profile_pay").select("id, full_name"),
    // WHERE THE RECORDS START: the first payment received or the first shift clocked, whichever is
    // earlier. That is when the books began being kept here. A bill is NOT a start: receipts get
    // entered after the fact with their own older dates (ET's first two are dated Apr 20 and May 30
    // and were entered Jun 10), and "records start Apr 20" would claim two months of books that were
    // never kept. Those receipts still count, in their own months.
    Promise.all([
      supabase.from("payments").select("paid_at").order("paid_at", { ascending: true }).limit(1),
      supabase.from("time_entries").select("clock_in").order("clock_in", { ascending: true }).limit(1),
    ]),
  ]);

  const problem =
    [payments, refunds, bills, pos, petty, entries, runs, payPayments, memos].map((r) => r.problem).find(Boolean) ??
    ratesRead.problem ??
    ((names as any)?.error ? "the names could not be read" : null);
  if (problem) return { inputs: null, problem };

  const people = new Map<string, OwnerMoneyPerson>();
  const nameOf = new Map<string, string>();
  for (const n of ((names as any)?.data ?? []) as { id: string; full_name: string | null }[]) {
    if (n?.id) nameOf.set(String(n.id), n.full_name ?? "");
  }
  for (const [id, r] of ratesRead.rates as Map<string, PayRates>) {
    people.set(id, { name: nameOf.get(id) ?? "", paidByDraw: r.paid_by_draw, hourlyRate: r.hourly_rate });
  }
  // Rates onto each shift the way the Pay board merges them (0215/0216: never an embed).
  attachRates(entries.rows, ratesRead.rates, (e: any) => ({ id: e.profile_id, holder: e }));

  const [firstPay, firstShift] = firsts as any[];
  const starts = [recordDay(null, firstPay?.data?.[0]?.paid_at, tz), recordDay(null, firstShift?.data?.[0]?.clock_in, tz)].filter(
    (d): d is string => !!d,
  );
  const recordsStart = starts.length ? starts.sort()[0] : null;
  const firstPaymentDay = recordDay(null, firstPay?.data?.[0]?.paid_at, tz);

  return {
    inputs: {
      payments: payments.rows,
      refunds: refunds.rows,
      bills: bills.rows,
      pos: pos.rows,
      pettyCash: petty.rows,
      entries: entries.rows,
      runs: runs.rows,
      payPayments: payPayments.rows,
      ...supplierDocsNoBillCovers(memos.rows),
      people,
      recordsStart,
      firstPaymentDay,
    },
    problem: null,
  };
}
