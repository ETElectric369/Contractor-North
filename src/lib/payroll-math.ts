import { hoursBetween } from "@/lib/utils";
import { summarizeMileage } from "@/lib/mileage-math";

/** Coerce to a finite number, else 0 — payroll feeds real wages; one bad row must
 *  not poison gross pay or an employee's hours. */
const fin = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

export type PayrollRow = {
  profileId: string;
  name: string;
  rate: number; // base profile rate, for display only — gross is accumulated per entry below
  unpaidHours: number;
  unpaidMiles: number; // reimbursable BUSINESS miles (logged net of the daily commute baseline)
  unpaidGross: number; // Σ hours × payRateForEntry — honors per-entry rate_override
  paidHours: number;
  paidMiles: number; // reimbursable BUSINESS miles (logged net of the daily commute baseline)
  paidGross: number;
};

/** THE single source of truth for what an entry PAYS per hour: a per-entry
 *  rate_override (e.g. a supervisor rate for that shift) wins, else the person's
 *  profile hourly_rate (or an explicit fallback when the row carries no profile).
 *  PAY-rate only — what we CHARGE the customer is the bill_rate in labor-billing. */
export function payRateForEntry(e: any, fallbackRate?: number): number {
  const ov = Number(e?.rate_override);
  if (Number.isFinite(ov) && ov > 0) return ov;
  return fin(e?.profiles?.hourly_rate ?? fallbackRate);
}

/** Combine an already-accumulated gross with mileage pay into one rounded line.
 *  Use this (not payLine) when gross was summed per entry to honor mixed rates. */
export function payLineFromGross(gross: number, miles: number, mileageRate: number) {
  const g = Math.round(fin(gross) * 100) / 100;
  const mileagePay = Math.round(fin(miles) * fin(mileageRate) * 100) / 100;
  return { gross: g, mileagePay, total: Math.round((g + mileagePay) * 100) / 100 };
}

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
 *  employees with no hours; sorts by unpaid then paid hours desc.
 *
 *  Mileage pay reimburses BUSINESS miles — logged miles net of the person's daily
 *  commute_baseline_miles (subtracted once per day) — NOT raw logged miles, so we
 *  don't overpay the commute. The baseline is netted via the same summarizeMileage
 *  the timecard + tax report use; tz is the business timezone so the per-day grouping
 *  agrees with those surfaces. */
export function aggregatePayrollEntries(
  entries: any[],
  tz: string = "America/Los_Angeles",
): PayrollRow[] {
  type Acc = PayrollRow & { baseline: number; paidEntries: any[]; unpaidEntries: any[] };
  const byProfile = new Map<string, Acc>();
  for (const e of entries ?? []) {
    const rec =
      byProfile.get(e.profile_id) ?? {
        profileId: e.profile_id,
        name: e.profiles?.full_name ?? "—",
        rate: fin(e.profiles?.hourly_rate),
        baseline: Math.max(0, fin(e.profiles?.commute_baseline_miles)),
        paidEntries: [] as any[],
        unpaidEntries: [] as any[],
        unpaidHours: 0,
        unpaidMiles: 0,
        unpaidGross: 0,
        paidHours: 0,
        paidMiles: 0,
        paidGross: 0,
      };
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    // Gross is summed PER ENTRY at that entry's pay rate (rate_override ?? base), so a
    // mixed-rate week — a few supervisor-rate shifts among normal ones — pays correctly
    // instead of flattening everything to the profile's base rate.
    const gross = h * payRateForEntry(e);
    // Shape just what summarizeMileage reads, coercing miles to finite (one bad row
    // must not poison the per-day mileage sum the way it can't poison gross).
    const milesEntry = { clock_in: e.clock_in, miles: fin(e.miles) };
    if (e.paid_at) {
      rec.paidHours += h;
      rec.paidGross += gross;
      rec.paidEntries.push(milesEntry);
    } else {
      rec.unpaidHours += h;
      rec.unpaidGross += gross;
      rec.unpaidEntries.push(milesEntry);
    }
    byProfile.set(e.profile_id, rec);
  }
  return [...byProfile.values()]
    .filter((r) => r.unpaidHours > 0 || r.paidHours > 0)
    .map((r) => {
      // Net the daily commute baseline off logged miles → reimbursable business miles,
      // splitting paid vs unpaid the same way hours/gross are. summarizeMileage subtracts
      // the baseline once per day-driven and never goes negative.
      const { baseline, paidEntries, unpaidEntries, ...row } = r;
      row.paidMiles = summarizeMileage(paidEntries, baseline, tz).business;
      row.unpaidMiles = summarizeMileage(unpaidEntries, baseline, tz).business;
      return row;
    })
    .sort((a, b) => b.unpaidHours - a.unpaidHours || b.paidHours - a.paidHours);
}
