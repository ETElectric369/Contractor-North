import { computeCollected } from "@/lib/analytics/money-metrics";
import { bucketCategoryPattern, bucketOf } from "@/lib/business-cost-buckets";
import { readAllPages } from "@/lib/read-all-pages";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

/**
 * THE FUEL TREND (Erik, 2026-09-27: "ok so how much fuel am i burning is the main one i want to
 * evaluate and put into the app").
 *
 * Fuel is a business-cost bucket of its own (0362, business-cost-buckets.ts): a bill with no job
 * whose category is Fuel, however it came in (a fill-up tapped Fuel on a bank download or placed by
 * the company's own answer, a pump receipt filed as Fuel, Add By Hand, a recurring expense),
 * and petty cash with no job filed as Fuel (never a replenish). The same costs the Owner's Draw card
 * counts on its Fuel line and Money by Month draws as fuel. This reads them over the last 13
 * weeks, Monday to Sunday on the company's own
 * calendar, and says one number: what fuel costs a week. Under the bars, one line: fuel as a share
 * of money in (the Owner's Draw card's Received: computeCollected, the /analytics "Collected" rule,
 * plus a bank download's Other Income, over the same weeks), the average fill, and how many fills.
 *
 * THE AVERAGE COUNTS ONLY WEEKS THE BOOKS COVER: from the first week any fuel was recorded (or the
 * window's start, when fuel was recorded before it) to the last FINISHED week the bank downloads
 * reach (a company that sorts its downloads gets most fills from them; one that never drops a
 * download is covered through yesterday). A company whose first fuel is 5 weeks old is averaged
 * over 5 weeks, never 13; and this week, still going (or past the last download, where fuel isn't
 * in yet), is drawn but never averaged, or every Monday would read about a thirteenth low.
 *
 * PURE: rows in, figures out, integer cents throughout. getFuelTrend is the one read.
 */

export const FUEL_WEEKS = 13;

export type FuelBillRow = {
  amount: number | string | null;
  bill_date: string | null;
  created_at?: string | null;
  category?: string | null;
  job_id?: string | null;
};

export type FuelWeek = { start: string; end: string; cents: number; fills: number };

export type FuelTrend = {
  weeks: FuelWeek[];
  /** The weeks the average is over (from the first fuel recorded, never before the window). */
  weeksCounted: number;
  totalCents: number;
  fills: number;
  avgWeekCents: number;
  avgFillCents: number;
  moneyInCents: number;
  /** Fuel as a whole percent of money in over the counted weeks; null with no money in. */
  sharePct: number | null;
  hasFuel: boolean;
};

const DAY = 86_400_000;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The Monday on or before a day ("YYYY-MM-DD"). */
export function mondayOf(ymd: string): string {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 Sunday … 6 Saturday
  return addDays(ymd, -((dow + 6) % 7));
}

/** The 13 weeks ending with this one: start inclusive, end exclusive (next Monday). */
export function fuelWindow(todayYmd: string): { start: string; end: string } {
  const thisMonday = mondayOf(todayYmd);
  return { start: addDays(thisMonday, -7 * (FUEL_WEEKS - 1)), end: addDays(thisMonday, 7) };
}

const cents = (v: unknown) => Math.round((Number(v) || 0) * 100);

/** Is this bill fuel: a business cost (no job) in the Fuel bucket? bucketOf, the rule the Owner's
 *  Draw card sums buckets by, so the two never disagree about which bill is fuel. */
export function isFuelBill(r: FuelBillRow): boolean {
  return !r.job_id && bucketOf(r.category) === "Fuel";
}

export type FuelPettyCashRow = {
  amount: number | string | null;
  tx_date: string | null;
  created_at?: string | null;
  category?: string | null;
  job_id?: string | null;
  kind?: string | null;
};

/** A petty cash row as a fuel row, on its own day (tx_date, created_at when missing), or null when it
 *  isn't fuel. The Owner's Draw card's rule (computeOwnerMoney): a replenish is cash moving, never a
 *  cost; one with no job is a business cost in bucketOf(category). */
export function fuelRowOfPettyCash(pc: FuelPettyCashRow): FuelBillRow | null {
  if (!pc || pc.kind === "replenish") return null;
  const row: FuelBillRow = { amount: pc.amount, bill_date: pc.tx_date ?? null, created_at: pc.created_at ?? null, category: pc.category ?? null, job_id: pc.job_id ?? null };
  return isFuelBill(row) ? row : null;
}

/**
 * The trend over the 13 weeks ending with the org's today. `moneyIn` is computeCollected over
 * payments and refunds already cut to the counted weeks by the caller (getFuelTrend), or a figure in
 * dollars a test hands in.
 */
export function computeFuelTrend(
  rows: readonly FuelBillRow[],
  moneyIn: number | ((from: string, to: string) => number),
  todayYmd: string,
  tz = "UTC",
  /** The last day a bank download reached (most fills come from them); null: today. */
  coveredThrough: string | null = null,
): FuelTrend {
  const win = fuelWindow(todayYmd);
  const weeks: FuelWeek[] = [];
  for (let i = 0; i < FUEL_WEEKS; i++) {
    const start = addDays(win.start, 7 * i);
    weeks.push({ start, end: addDays(start, 6), cents: 0, fills: 0 });
  }
  let earliest: string | null = null;
  for (const r of rows) {
    if (!isFuelBill(r)) continue;
    const day = r.bill_date ?? (r.created_at ? todayStrInTz(tz, new Date(r.created_at)) : null);
    if (!day) continue;
    if (!earliest || day < earliest) earliest = day;
    if (day < win.start || day >= win.end) continue;
    const w = weeks[Math.floor((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${win.start}T12:00:00Z`)) / (7 * DAY))];
    if (!w) continue;
    const c = cents(r.amount);
    w.cents += c;
    // A refund (a negative fuel row) takes money off; it is not a fill.
    if (c > 0) w.fills += 1;
  }
  const firstWeek = earliest && earliest > win.start ? mondayOf(earliest) : win.start;
  // FINISHED WEEKS ONLY, up to the last day the downloads reach (and never today, still going).
  const yesterday = addDays(todayYmd, -1);
  const through = coveredThrough && coveredThrough < yesterday ? coveredThrough : yesterday;
  const finished = weeks.filter((w) => w.start >= firstWeek && w.end <= through);
  // Every week of it still going (fuel first recorded this week): the weeks there are, as before.
  const counted = finished.length ? finished : weeks.filter((w) => w.start >= firstWeek);
  const totalCents = counted.reduce((n, w) => n + w.cents, 0);
  const fills = counted.reduce((n, w) => n + w.fills, 0);
  const spanEnd = counted.length ? addDays(counted[counted.length - 1].start, 7) : win.end;
  const inCents = typeof moneyIn === "function" ? cents(moneyIn(firstWeek, spanEnd)) : cents(moneyIn);
  return {
    weeks,
    weeksCounted: earliest ? counted.length : 0,
    totalCents,
    fills,
    avgWeekCents: counted.length && earliest ? Math.round(totalCents / counted.length) : 0,
    avgFillCents: fills ? Math.round(totalCents / fills) : 0,
    moneyInCents: inCents,
    sharePct: inCents > 0 ? Math.round((totalCents / inCents) * 100) : null,
    hasFuel: !!earliest && weeks.some((w) => w.cents !== 0),
  };
}

/** "Sep 14". */
export function weekLabel(start: string): string {
  return new Date(`${start}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/**
 * THE READS: the business costs inside the 13 weeks (every page of them: PostgREST cuts a select at
 * 1,000 rows without a word, and a busy fleet passes that), the one earliest fuel bill ever (so the
 * average knows the first week the books have fuel), and the money received over the window, every
 * page. RLS holds all of them to the signed-in company's staff. A company with no fuel simply gets
 * no card.
 *
 * WHICH BILL IS FUEL IS isFuelBill'S CALL, never the query's. Postgres `=` is exact, and a no-job bill
 * whose category nobody bucketed ("gas", "fuel") is one bucketOf counts, so the Owner's Draw card has
 * it on its Fuel line. The window's read takes every business cost and keeps isFuelBill's; the
 * earliest-ever read, which can only ask for one row, asks with bucketCategoryPattern (bucketOf's
 * own words, any letter case) and keeps isFuelBill's too.
 *
 * PETTY CASH IS READ THE SAME WAY, twice: the rows with no job in the window (never a replenish), and
 * the earliest fuel one before it. fuelRowOfPettyCash keeps the fuel, on its own day, as the Owner's
 * Draw card does; without it a fill-up paid from the cash box was on that card's Fuel line and Money
 * by Month's fuel, and never here.
 */
export async function getFuelTrend(supabase: any, tz: string, todayYmd: string): Promise<FuelTrend | null> {
  const win = fuelWindow(todayYmd);
  const fuelWords = bucketCategoryPattern("Fuel");
  const businessBills = () =>
    supabase.from("bills").select("id, amount, bill_date, created_at, category, job_id").is("job_id", null).is("superseded_by_bill_id", null);
  const businessPettyCash = () =>
    supabase.from("petty_cash").select("id, amount, tx_date, created_at, category, job_id, kind").is("job_id", null).neq("kind", "replenish");
  const [inside, first, pettyInside, pettyFirst] = await Promise.all([
    readAllPages<FuelBillRow & { id: string }>((f, t) => businessBills().or(`bill_date.gte.${win.start},bill_date.is.null`).order("id").range(f, t), 20),
    businessBills().filter("category", "imatch", fuelWords).not("bill_date", "is", null).order("bill_date", { ascending: true }).limit(1),
    readAllPages<FuelPettyCashRow & { id: string }>((f, t) => businessPettyCash().gte("tx_date", win.start).order("id").range(f, t), 20),
    businessPettyCash().filter("category", "imatch", fuelWords).lt("tx_date", win.start).order("tx_date", { ascending: true }).limit(1),
  ]);
  if (inside.error || first.error || !Array.isArray(first.data)) return null;
  if (pettyInside.error || pettyFirst.error || !Array.isArray(pettyFirst.data)) return null;
  // The earliest fuel ever, when it is before the window: it says when the books start, nothing more.
  const before = (first.data as FuelBillRow[]).filter((r) => isFuelBill(r) && (r.bill_date ?? "") < win.start);
  const petty = [...(pettyFirst.data as FuelPettyCashRow[]), ...pettyInside.rows].map(fuelRowOfPettyCash).filter((r): r is FuelBillRow => !!r);
  const fuelRows = [...before, ...inside.rows.filter(isFuelBill), ...petty];
  if (!fuelRows.length) return computeFuelTrend([], 0, todayYmd, tz);
  // How far the bank downloads reach: most fills are written from them, so a week past the last one
  // isn't in yet. No bank lines (or none readable): today.
  const { data: reach } = await supabase.from("bank_lines").select("posted_on").order("posted_on", { ascending: false }).limit(1);
  const coveredThrough = Array.isArray(reach) && reach[0]?.posted_on ? String(reach[0].posted_on).slice(0, 10) : null;
  const startIso = tzDayStartUtc(win.start, tz).toISOString();
  const endIso = tzDayStartUtc(win.end, tz).toISOString();
  const [{ rows: pays, error: payErr }, { rows: refunds, error: refErr }] = await Promise.all([
    readAllPages<any>((f, t) => supabase.from("payments").select("id, amount, paid_at, invoices(status)").gte("paid_at", startIso).lt("paid_at", endIso).order("id").range(f, t), 50),
    readAllPages<any>(
      (f, t) => supabase.from("customer_credits").select("id, amount, created_at").eq("disposition", "refund").gte("created_at", startIso).lt("created_at", endIso).order("id").range(f, t),
      50,
    ),
  ]);
  if (payErr || refErr) return null;
  // OTHER INCOME (0363) is money in, the same as the Owner's Draw card's Received counts it. No
  // bank_lines table yet: none.
  const other = await readAllPages<{ amount: number | string; posted_on: string }>(
    (f, t) => supabase.from("bank_lines").select("id, amount, posted_on").eq("choice", "other_income").gte("posted_on", win.start).lt("posted_on", win.end).order("id").range(f, t),
    20,
  );
  const otherRows = other.error ? [] : other.rows;
  const moneyIn = (from: string, to: string) => {
    const f = tzDayStartUtc(from, tz).getTime();
    const t = tzDayStartUtc(to, tz).getTime();
    const inside = (at: unknown) => {
      const ms = Date.parse(String(at ?? ""));
      return ms >= f && ms < t;
    };
    const otherCents = otherRows.filter((o) => String(o.posted_on) >= from && String(o.posted_on) < to).reduce((n, o) => n + cents(o.amount), 0);
    return (
      computeCollected(
        ((pays ?? []) as any[]).filter((p) => inside(p.paid_at)),
        ((refunds ?? []) as any[]).filter((r) => inside(r.created_at)),
      ) +
      otherCents / 100
    );
  };
  return computeFuelTrend(fuelRows, moneyIn, todayYmd, tz, coveredThrough);
}
