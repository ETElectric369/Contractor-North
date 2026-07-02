import { hoursBetween } from "@/lib/utils";
import { summarizeMileage } from "@/lib/mileage-math";

/** Coerce to a finite number, else 0 — payroll feeds real wages; one bad row must
 *  not poison gross pay or an employee's hours. */
const fin = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Hours worked at one specific pay rate — a mixed-rate period renders as an
 *  explicit split ("26h × $40 + 8h × $75"), never a silently blended $/hr. */
export type RateHours = { rate: number; hours: number };

export type PayrollRow = {
  profileId: string;
  name: string;
  rate: number; // base profile rate, for display only — gross is accumulated per entry below
  // BASE bucket — hours × payRateForEntry ⇒ gross; lock = paid_at (base settled ONLY).
  unpaidHours: number;
  unpaidGross: number; // Σ hours × payRateForEntry — honors per-entry rate_override
  paidHours: number;
  paidGross: number;
  /** Per-rate hours breakdowns, sorted by rate asc. Plain arrays (not Maps) so
   *  they serialize cleanly across the RSC prop boundary. */
  unpaidRates: RateHours[];
  paidRates: RateHours[];
  // MILEAGE bucket — miles are DATA (business = logged net of the daily commute
  // baseline); lock = mileage_paid_at, independent of paid_at. Dollars are
  // deliberately ABSENT here: a settlement amount is human-stated and lives on
  // the kind='mileage' payroll_run — never computed from a rate.
  heldMiles: number; // business miles not yet settled
  settledMiles: number; // business miles already settled
  loggedMiles: number; // raw recorded miles, display context only
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

/** Round an already-accumulated gross to cents, with mileage pay alongside —
 *  as two SEPARATE figures. There is deliberately no combined total: base pay
 *  and mileage are settled independently and must never be summed into one
 *  payable number (that fold is how an app-invented figure lands on a check). */
export function payLineFromGross(gross: number, miles: number, mileageRate: number) {
  const g = Math.round(fin(gross) * 100) / 100;
  const mileagePay = Math.round(fin(miles) * fin(mileageRate) * 100) / 100;
  return { gross: g, mileagePay };
}

/** Gross pay for a set of hours/miles: gross = hours × hourly rate; mileagePay =
 *  miles × mileage rate — SEPARATE figures, never combined (see payLineFromGross).
 *  Gross only — tax/withholding is the accountant's job by design. */
export function payLine(
  hours: number,
  rate: number,
  miles: number,
  mileageRate: number,
): { gross: number; mileagePay: number } {
  const gross = Math.round(fin(hours) * fin(rate) * 100) / 100;
  const mileagePay = Math.round(fin(miles) * fin(mileageRate) * 100) / 100;
  return { gross, mileagePay };
}

/** Aggregate a pay period's time entries into one row per employee, as TWO
 *  independent buckets: BASE (hours via hoursBetween, lunch-deducted, × per-entry
 *  pay rate ⇒ gross; split paid/unpaid by paid_at) and MILEAGE (business miles,
 *  split held/settled by mileage_paid_at — no dollars). Drops employees with no
 *  hours; sorts by unpaid then paid hours desc.
 *
 *  Business miles = logged miles net of the person's daily commute_baseline_miles
 *  (subtracted once per day-driven) — NOT raw logged miles, so a settlement isn't
 *  anchored to the commute. Netted via the same summarizeMileage the timecard +
 *  tax report use; tz is the business timezone so the per-day grouping agrees. */
export function aggregatePayrollEntries(
  entries: any[],
  tz: string = "America/Los_Angeles",
): PayrollRow[] {
  type Acc = PayrollRow & {
    baseline: number;
    heldEntries: any[];
    settledEntries: any[];
    unpaidRateMap: Map<number, number>;
    paidRateMap: Map<number, number>;
  };
  const byProfile = new Map<string, Acc>();
  for (const e of entries ?? []) {
    const rec =
      byProfile.get(e.profile_id) ?? {
        profileId: e.profile_id,
        name: e.profiles?.full_name ?? "—",
        rate: fin(e.profiles?.hourly_rate),
        baseline: Math.max(0, fin(e.profiles?.commute_baseline_miles)),
        heldEntries: [] as any[],
        settledEntries: [] as any[],
        unpaidRateMap: new Map<number, number>(),
        paidRateMap: new Map<number, number>(),
        unpaidHours: 0,
        unpaidGross: 0,
        paidHours: 0,
        paidGross: 0,
        unpaidRates: [] as RateHours[],
        paidRates: [] as RateHours[],
        heldMiles: 0,
        settledMiles: 0,
        loggedMiles: 0,
      };
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    // Gross is summed PER ENTRY at that entry's pay rate (rate_override ?? base), so a
    // mixed-rate week — a few supervisor-rate shifts among normal ones — pays correctly
    // instead of flattening everything to the profile's base rate.
    const rate = payRateForEntry(e);
    const gross = h * rate;
    if (e.paid_at) {
      rec.paidHours += h;
      rec.paidGross += gross;
      if (h > 0) rec.paidRateMap.set(rate, (rec.paidRateMap.get(rate) ?? 0) + h);
    } else {
      rec.unpaidHours += h;
      rec.unpaidGross += gross;
      if (h > 0) rec.unpaidRateMap.set(rate, (rec.unpaidRateMap.get(rate) ?? 0) + h);
    }
    // Shape just what summarizeMileage reads, coercing miles to finite (one bad row
    // must not poison the per-day mileage sum the way it can't poison gross). Miles
    // split by their OWN lock — a base payment never moves them.
    const milesEntry = { clock_in: e.clock_in, miles: fin(e.miles) };
    if (e.mileage_paid_at) rec.settledEntries.push(milesEntry);
    else rec.heldEntries.push(milesEntry);
    byProfile.set(e.profile_id, rec);
  }
  const toRates = (m: Map<number, number>): RateHours[] =>
    [...m.entries()].map(([rate, hours]) => ({ rate, hours })).sort((a, b) => a.rate - b.rate);
  return [...byProfile.values()]
    .filter((r) => r.unpaidHours > 0 || r.paidHours > 0)
    .map((r) => {
      // Net the daily commute baseline off logged miles → business miles, per group.
      // KNOWN LIMIT (deliberate, conservative): summarizeMileage subtracts the
      // baseline once per day PER GROUP, so if one day holds both settled and
      // held entries (an entry closed AFTER a settlement act), that day's baseline
      // is subtracted from BOTH groups — held business miles read LOW, never high.
      // An undercount can't overstate what's owed, so we accept it.
      const { baseline, heldEntries, settledEntries, unpaidRateMap, paidRateMap, ...row } = r;
      const held = summarizeMileage(heldEntries, baseline, tz);
      const settled = summarizeMileage(settledEntries, baseline, tz);
      row.heldMiles = held.business;
      row.settledMiles = settled.business;
      row.loggedMiles = round1(held.recorded + settled.recorded);
      row.unpaidRates = toRates(unpaidRateMap);
      row.paidRates = toRates(paidRateMap);
      return row;
    })
    .sort((a, b) => b.unpaidHours - a.unpaidHours || b.paidHours - a.paidHours);
}
