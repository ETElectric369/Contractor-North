import { hoursBetween } from "@/lib/utils";

/** Coerce to a finite number, else 0 — payroll feeds real wages; one bad row must
 *  not poison gross pay or an employee's hours. */
const fin = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

export type PayrollRow = {
  profileId: string;
  name: string;
  rate: number;
  unpaidHours: number;
  unpaidMiles: number;
  paidHours: number;
  paidMiles: number;
};

/** Gross pay for a set of hours/miles: gross = hours × hourly rate; mileagePay =
 *  miles × mileage rate; total = both, all finite + rounded to cents. Gross only —
 *  tax/withholding is the accountant's job by design. */
export function payLine(
  hours: number,
  rate: number,
  miles: number,
  mileageRate: number,
): { gross: number; mileagePay: number; total: number } {
  const gross = Math.round(fin(hours) * fin(rate) * 100) / 100;
  const mileagePay = Math.round(fin(miles) * fin(mileageRate) * 100) / 100;
  return { gross, mileagePay, total: Math.round((gross + mileagePay) * 100) / 100 };
}

/** Aggregate a pay period's time entries into one row per employee: hours (via
 *  hoursBetween, lunch-deducted) + miles, split paid vs unpaid by paid_at. Drops
 *  employees with no hours; sorts by unpaid then paid hours desc. */
export function aggregatePayrollEntries(entries: any[]): PayrollRow[] {
  const byProfile = new Map<string, PayrollRow>();
  for (const e of entries ?? []) {
    const rec =
      byProfile.get(e.profile_id) ?? {
        profileId: e.profile_id,
        name: e.profiles?.full_name ?? "—",
        rate: fin(e.profiles?.hourly_rate),
        unpaidHours: 0,
        unpaidMiles: 0,
        paidHours: 0,
        paidMiles: 0,
      };
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    const m = fin(e.miles);
    if (e.paid_at) {
      rec.paidHours += h;
      rec.paidMiles += m;
    } else {
      rec.unpaidHours += h;
      rec.unpaidMiles += m;
    }
    byProfile.set(e.profile_id, rec);
  }
  return [...byProfile.values()]
    .filter((r) => r.unpaidHours > 0 || r.paidHours > 0)
    .sort((a, b) => b.unpaidHours - a.unpaidHours || b.paidHours - a.paidHours);
}
