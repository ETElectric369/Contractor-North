import { computeCollected } from "@/lib/analytics/money-metrics";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

/**
 * THE FUEL TREND (Erik, 2026-09-27: "ok so how much fuel am i burning is the main one i want to
 * evaluate and put into the app").
 *
 * Fuel is a kind inside the Gas & Truck bucket (bills.cost_kind = 'fuel', 0362): a business cost
 * with no job, tagged when a person tapped Fuel on a bank download (or a rule the company made from
 * such a tap). This reads those bills over the last 13 weeks, Monday to Sunday on the company's own
 * calendar, and says one number: what fuel costs a week. Under the bars, one line: fuel as a share
 * of money in (computeCollected, the /analytics "Collected" rule, over the same weeks), the average
 * fill, and how many fills.
 *
 * THE AVERAGE COUNTS ONLY WEEKS THE BOOKS COVER: from the first week any fuel was recorded (or the
 * window's start, when fuel was recorded before it) to the last FINISHED week the bank downloads
 * reach. A company whose first fuel is 5 weeks old is averaged over 5 weeks, never 13; and this
 * week, still going (or past the last download, where fuel isn't in yet), is drawn but never
 * averaged, or every Monday would read about a thirteenth low.
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
  cost_kind?: string | null;
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

/** Is this bill fuel: a Gas & Truck business cost (no job) tagged fuel? */
export function isFuelBill(r: FuelBillRow): boolean {
  return r.cost_kind === "fuel" && r.category === "Gas & Truck" && !r.job_id;
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
  /** The last day a bank download reached (fuel is written from them); null: today. */
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
 * THE ONE READ: every fuel bill (a company's fuel rows are few) and the money received over the
 * window. RLS holds both to the signed-in company's staff. A database before 0362 has no cost_kind:
 * there is no fuel yet, and the card simply isn't drawn (never an error).
 */
export async function getFuelTrend(supabase: any, tz: string, todayYmd: string): Promise<FuelTrend | null> {
  const win = fuelWindow(todayYmd);
  const { data: bills, error } = await supabase
    .from("bills")
    .select("amount, bill_date, created_at, category, job_id, cost_kind")
    .eq("cost_kind", "fuel")
    .eq("category", "Gas & Truck")
    .is("job_id", null)
    .is("superseded_by_bill_id", null)
    .order("bill_date", { ascending: true })
    .limit(5000);
  if (error || !Array.isArray(bills)) return null;
  if (!bills.length) return computeFuelTrend([], 0, todayYmd, tz);
  // How far the bank downloads reach: fuel is written from them, so a week past the last one isn't
  // in yet. No bank lines (or none readable): today.
  const { data: reach } = await supabase.from("bank_lines").select("posted_on").order("posted_on", { ascending: false }).limit(1);
  const coveredThrough = Array.isArray(reach) && reach[0]?.posted_on ? String(reach[0].posted_on).slice(0, 10) : null;
  const startIso = tzDayStartUtc(win.start, tz).toISOString();
  const endIso = tzDayStartUtc(win.end, tz).toISOString();
  const [{ data: pays, error: payErr }, { data: refunds, error: refErr }] = await Promise.all([
    supabase.from("payments").select("amount, paid_at, invoices(status)").gte("paid_at", startIso).lt("paid_at", endIso).limit(50000),
    supabase.from("customer_credits").select("amount, created_at").eq("disposition", "refund").gte("created_at", startIso).lt("created_at", endIso).limit(50000),
  ]);
  if (payErr || refErr) return null;
  const moneyIn = (from: string, to: string) => {
    const f = tzDayStartUtc(from, tz).getTime();
    const t = tzDayStartUtc(to, tz).getTime();
    const inside = (at: unknown) => {
      const ms = Date.parse(String(at ?? ""));
      return ms >= f && ms < t;
    };
    return computeCollected(
      ((pays ?? []) as any[]).filter((p) => inside(p.paid_at)),
      ((refunds ?? []) as any[]).filter((r) => inside(r.created_at)),
    );
  };
  return computeFuelTrend(bills as FuelBillRow[], moneyIn, todayYmd, tz, coveredThrough);
}
