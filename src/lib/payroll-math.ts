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
  rate: number; // base profile rate, for display only — gross is accumulated per entry below
  unpaidHours: number;
  unpaidMiles: number;
  unpaidGross: number; // Σ hours × payRateForEntry — honors per-entry rate_override
  paidHours: number;
  paidMiles: number;
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
        unpaidGross: 0,
        paidHours: 0,
        paidMiles: 0,
        paidGross: 0,
      };
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    const m = fin(e.miles);
    // Gross is summed PER ENTRY at that entry's pay rate (rate_override ?? base), so a
    // mixed-rate week — a few supervisor-rate shifts among normal ones — pays correctly
    // instead of flattening everything to the profile's base rate.
    const gross = h * payRateForEntry(e);
    if (e.paid_at) {
      rec.paidHours += h;
      rec.paidMiles += m;
      rec.paidGross += gross;
    } else {
      rec.unpaidHours += h;
      rec.unpaidMiles += m;
      rec.unpaidGross += gross;
    }
    byProfile.set(e.profile_id, rec);
  }
  return [...byProfile.values()]
    .filter((r) => r.unpaidHours > 0 || r.paidHours > 0)
    .sort((a, b) => b.unpaidHours - a.unpaidHours || b.paidHours - a.paidHours);
}
