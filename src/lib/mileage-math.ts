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
 */
export function summarizeMileage(
  entries: { clock_in: string; miles?: number | null }[],
  baselinePerDay: number,
  tz: string,
): MileageSummary {
  const base = Math.max(0, Number(baselinePerDay) || 0);
  const byDay = new Map<string, number>();
  for (const e of entries) {
    const m = Number(e.miles ?? 0);
    if (m <= 0) continue;
    const day = todayStrInTz(tz, new Date(e.clock_in));
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
