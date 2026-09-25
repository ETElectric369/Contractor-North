import { todayStrInTz } from "./tz";

const round1 = (n: number) => Math.round(n * 10) / 10;

export type MileageSummary = {
  recorded: number; // total miles logged
  daysDriven: number; // distinct days with miles
  commute: number; // non-reimbursable baseline portion (recorded - business)
  business: number; // reimbursable / deductible miles (net of the daily baseline)
};

/**
 * Split logged miles into the personal commute baseline vs reimbursable BUSINESS
 * miles. The commute is per-DAY, not per-trip (you commute once a day no matter how
 * many jobs), so miles are grouped by day in the business timezone and the baseline
 * is subtracted once per day-driven. A day under the baseline contributes 0 business
 * miles (never negative).
 *
 * ONE SHIFT, ONE DAY (audit v994 SW5). Since 0288 a shift can be cut into pieces (a Switch Job, a
 * split on Timecards), and its miles sit whole on ONE piece, which may start after midnight: an
 * 8 PM to 2 AM callback split at midnight with its miles moved onto the 12 AM piece was counted on
 * the next day, subtracting a second commute baseline (or merging into another day's driving). So a
 * piece is bucketed by the day its SHIFT began: the earliest clock-in among the entries handed in
 * that share its split family (coalesce(split_from, id)). Callers that hand in `id` and `split_from`
 * get this; an entry without them is its own shift, as before.
 */
export function summarizeMileage(
  entries: { clock_in: string; miles?: number | null; id?: string | null; split_from?: string | null }[],
  baselinePerDay: number,
  tz: string,
): MileageSummary {
  const base = Math.max(0, Number(baselinePerDay) || 0);
  // The start of each split family among these entries.
  const familyStart = new Map<string, number>();
  const familyOf = (e: { id?: string | null; split_from?: string | null }) => (e.split_from || e.id || null);
  for (const e of entries) {
    const f = familyOf(e);
    const t = Date.parse(e.clock_in);
    if (!f || !Number.isFinite(t)) continue;
    const had = familyStart.get(f);
    if (had == null || t < had) familyStart.set(f, t);
  }
  const byDay = new Map<string, number>();
  for (const e of entries) {
    const m = Number(e.miles ?? 0);
    if (m <= 0) continue;
    const f = familyOf(e);
    const anchor = (f && familyStart.get(f)) ?? Date.parse(e.clock_in);
    const day = todayStrInTz(tz, new Date(anchor));
    byDay.set(day, (byDay.get(day) ?? 0) + m);
  }
  let recorded = 0;
  let business = 0;
  for (const dayMiles of byDay.values()) {
    recorded += dayMiles;
    business += Math.max(0, dayMiles - base);
  }
  return {
    recorded: round1(recorded),
    daysDriven: byDay.size,
    commute: round1(recorded - business),
    business: round1(business),
  };
}
