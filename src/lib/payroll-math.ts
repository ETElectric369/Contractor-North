import { hoursBetween } from "@/lib/utils";
import { summarizeMileage } from "@/lib/mileage-math";
import { todayStrInTz } from "@/lib/tz";

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
  fallbackRate?: number,
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
    // instead of flattening everything to the profile's base rate. fallbackRate is used
    // only when a row carries no joined profile (the mark-paid snapshot passes the base
    // rate explicitly) — the display path joins profiles, so it stays undefined there.
    const rate = payRateForEntry(e, fallbackRate);
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

// ─────────────────────────────────────────────────────────────────────────────
// OWED = EARNED − PAID  (migration 0264, "a payment is an amount, not a checkbox")
//
// Erik, 2026-09-17: "i need an easy way to be able to see how much i owe each employee and be able
// to enter an amount i paid them instead of just a checkbox for each pay period", and the reason:
// "i have paid brian a large chunk of that and thats why im having trouble becuase theres been no
// way for me to record it properly… sometimes i need to throw his a few hundred or an off ammount."
//
// Everything below is PURE. The Pay page and the server actions both read their figures from
// balanceForPerson() and nothing else, so the number on screen and the number a payment is measured
// against cannot disagree — the two-renderers class of bug this codebase keeps paying for.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(fin(n) * 100) / 100;

export type PayMethod = "cash" | "check" | "transfer" | "other";

/** The four the DB check constraint allows (0264). One list, so no surface invents a fifth. */
export const PAY_METHODS: PayMethod[] = ["cash", "check", "transfer", "other"];

export function isPayMethod(v: unknown): v is PayMethod {
  return typeof v === "string" && (PAY_METHODS as string[]).includes(v);
}

/** One recorded payment, camel-cased for the app. `voided` is a FACT derived from voided_at:
 *  a voided row still exists and still shows (void, never delete — the undo-trail law), it just
 *  stops counting. */
export type PayPaymentRow = {
  id: string;
  profileId: string;
  amount: number;
  paidOn: string; // YYYY-MM-DD, the ORG's day
  method: PayMethod;
  reference: string | null;
  note: string | null;
  needsCheck: boolean;
  voided: boolean;
};

/** THE one mapper from a pay_payments row to the app's shape. Both the page and the actions use
 *  it, so `voided` can never be read as `voided_at` truthiness on one surface and something else
 *  on the other. */
export function toPayPaymentRow(row: any): PayPaymentRow {
  const method = isPayMethod(row?.method) ? row.method : "other";
  return {
    id: String(row?.id ?? ""),
    profileId: String(row?.profile_id ?? ""),
    amount: r2(row?.amount),
    paidOn: String(row?.paid_on ?? ""),
    method,
    reference: row?.reference ?? null,
    note: row?.note ?? null,
    needsCheck: !!row?.needs_check,
    voided: !!row?.voided_at,
  };
}

export type PersonBalance = {
  profileId: string;
  name: string;
  earned: number; // frozen gross for locked periods + live gross for unlocked closed entries
  paid: number; // sum of non-voided payments, all time
  owed: number; // earned - paid; NEGATIVE means the person is ahead
  unpaidHours: number; // hours on closed, not-yet-locked entries
  oldestUnpaid: string | null; // YYYY-MM-DD org-local, or null
  lastPayment: { amount: number; paidOn: string; method: PayMethod } | null;
  hasOpenShift: boolean; // a shift still running: its hours are NOT in earned, and the page says so
  needsCheckCount: number; // imported payments not yet confirmed
  heldMiles: number;
  loggedMiles: number; // business / logged miles not yet settled
};

/** Money actually handed over: non-voided rows only, all time. A voided row is still on the
 *  screen and contributes nothing — that is the whole point of voiding instead of deleting. */
export function sumPayments(payments: PayPaymentRow[] | null | undefined): number {
  let cents = 0;
  for (const p of payments ?? []) if (p && !p.voided) cents += Math.round(fin(p.amount) * 100);
  return cents / 100;
}

/** The FROZEN side of earned: what payroll_runs said each locked period came to at the moment it
 *  locked. MILEAGE RUNS ARE NOT WAGES (0095's two-lock rule): a kind='mileage' row carries gross 0
 *  by constraint, but the guard is written out anyway so nobody can hand this reimbursement
 *  dollars and have them quietly land in a wages balance. */
export function sumLockedGross(
  runs: { period_start: string; period_end: string; gross: number; kind?: string }[] | null | undefined,
): number {
  let cents = 0;
  for (const r of runs ?? []) {
    if (r?.kind && r.kind !== "base") continue;
    cents += Math.round(fin(r?.gross) * 100);
  }
  return cents / 100;
}

/** What is left over after every payment has been applied to every period already locked.
 *  POSITIVE = money that has not bought a lock yet (it is what the lock rule spends, oldest
 *  period first); NEGATIVE = locked periods the payments don't cover, which is what voidPayment
 *  has to unwind. */
export function runningCredit(
  payments: PayPaymentRow[] | null | undefined,
  lockedRuns: { period_start: string; period_end: string; gross: number; kind?: string }[] | null | undefined,
): number {
  return r2(sumPayments(payments) - sumLockedGross(lockedRuns));
}

/**
 * ONE person's money picture, from rows already fetched. PURE — no I/O — so the page, the actions
 * and any future surface compute it the same way and a test can pin it.
 *
 * EARNED is the subtle half, and it fixes a live bug. payRateForEntry falls back to the profile's
 * CURRENT hourly_rate, an undated editable field, so a raise silently restated what last month
 * paid. Erik's decision, asked and answered 2026-09-17: a raise applies FORWARD ONLY. So:
 *   · a LOCKED pay period reads the FROZEN payroll_runs.gross written when it locked, and
 *   · everything not yet locked is aggregated LIVE at today's rates (per-entry rate_override
 *     honored, lunch deducted by the lunch rule).
 * NEVER BOTH: an entry with paid_at set belongs to the frozen half, and aggregatePayrollEntries
 * files it in the PAID bucket, which this function ignores. That is the no-double-count seam.
 *
 * OPEN SHIFTS pay nothing. A running shift has no clock_out, so its hours are unknowable until it
 * closes; it is left out of earned entirely and flagged in hasOpenShift so the page can say out
 * loud that a number is still moving, instead of quietly under-counting a whole day (the 48.50
 * lesson from /payroll).
 *
 * `entries` must carry clock_in, clock_out, lunch_minutes, rate_override, miles, paid_at,
 * mileage_paid_at — the projection law: a missing field here is a missing select, and it reads as
 * zero hours or a phantom open shift. `lockedRuns` is this person's kind='base' runs, all time.
 * `fallbackRate` is the profile's hourly rate for rows fetched without a joined profile.
 */
export function balanceForPerson(input: {
  profileId: string;
  name: string;
  entries: any[];
  lockedRuns: { period_start: string; period_end: string; gross: number }[];
  payments: PayPaymentRow[];
  tz: string;
  fallbackRate?: number;
}): PersonBalance {
  const profileId = String(input.profileId);
  // Take only this person's rows, and stamp the id on rows that came from a per-person query with
  // no profile_id selected, so the aggregator groups them into exactly one row.
  const mine = (input.entries ?? [])
    .filter((e) => e && (e.profile_id == null || String(e.profile_id) === profileId))
    .map((e) => ({ ...e, profile_id: profileId }));

  const hasOpenShift = mine.some((e) => !e.clock_out);
  const closed = mine.filter((e) => !!e.clock_out);

  const [agg] = aggregatePayrollEntries(closed, input.tz, input.fallbackRate);
  const frozen = sumLockedGross(input.lockedRuns);
  const live = agg?.unpaidGross ?? 0; // the PAID bucket is deliberately dropped: it is the frozen half
  const earned = r2(frozen + live);
  const paid = sumPayments(input.payments);

  // The oldest day that still owes money. Zero-hour rows are skipped: a 0193 auto-closed ghost
  // (clock_out = clock_in) would otherwise date the debt to a day that owes nothing, and "going
  // back to" is the sentence Erik reads to decide who to pay first.
  let oldestUnpaid: string | null = null;
  let unsettledLogged = 0;
  for (const e of closed) {
    const t = Date.parse(e.clock_in);
    if (!e.mileage_paid_at) unsettledLogged += fin(e.miles);
    if (e.paid_at || !Number.isFinite(t)) continue;
    if (hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) <= 0) continue;
    const day = todayStrInTz(input.tz, new Date(t));
    if (!oldestUnpaid || day < oldestUnpaid) oldestUnpaid = day;
  }

  // Latest payment by the day Erik says he paid it. A same-day tie falls to whichever row the
  // caller listed last — both are true, and the amount is what he is checking anyway.
  let lastPayment: PersonBalance["lastPayment"] = null;
  for (const p of input.payments ?? []) {
    if (!p || p.voided) continue;
    if (!lastPayment || p.paidOn >= lastPayment.paidOn) {
      lastPayment = { amount: r2(p.amount), paidOn: p.paidOn, method: p.method };
    }
  }

  return {
    profileId,
    name: input.name,
    earned,
    paid,
    owed: r2(earned - paid),
    unpaidHours: agg?.unpaidHours ?? 0,
    oldestUnpaid,
    lastPayment,
    hasOpenShift,
    // A voided import has nothing left to confirm.
    needsCheckCount: (input.payments ?? []).filter((p) => p && p.needsCheck && !p.voided).length,
    heldMiles: agg?.heldMiles ?? 0,
    loggedMiles: round1(unsettledLogged),
  };
}

// ── THE SENTENCES ────────────────────────────────────────────────────────────
// These come back from the actions and get read on screen, so they are built here where a test
// can hold them to being true. Plain words, no jargon, and no em-dashes.

/** How a person is spoken to on this page: "Brian", not "Brian Taylor" and never "the employee". */
export function firstName(full: string | null | undefined): string {
  const first = String(full ?? "").trim().split(/\s+/)[0];
  return first || "this person";
}

/** Money as a person says it out loud: "$400", "$1,012.50". Deliberately not formatCurrency —
 *  a column of figures keeps its cents lined up, a sentence does not say "and zero cents". */
export function sayMoney(n: number): string {
  const v = Math.abs(r2(n));
  const cents = Math.round(v * 100) % 100;
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: cents === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

const shortDay = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A pay period the way it is spoken: "Aug 16 to Aug 31". `end` is EXCLUSIVE everywhere in this
 *  app (the next period's first day), so the label names the last day actually inside it. */
export function periodLabel(start: string, endExclusive: string): string {
  const last = new Date(new Date(`${endExclusive}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  return `${shortDay(start)} to ${shortDay(last)}`;
}

/** "today" / "yesterday" / "on Aug 14", relative to the ORG's day. */
export function dayPhrase(ymd: string, today: string): string {
  if (ymd === today) return "today";
  const y = new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  if (ymd === y) return "yesterday";
  return `on ${shortDay(ymd)}`;
}

const joinLabels = (periods: { start: string; end: string }[]): string => {
  const labels = periods.map((p) => periodLabel(p.start, p.end));
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
};

/** Where a balance leaves a person, in his own words. */
function balancePhrase(name: string, owed: number): string {
  const v = r2(owed);
  if (v > 0) return `${sayMoney(v)} left.`;
  if (v < 0) return `${firstName(name)} is ${sayMoney(-v)} ahead now.`;
  return "Nothing left owing.";
}

/** What recordPayment says back. Every clause is a fact the caller just wrote or read:
 *  what moved, what locked as a result, what could not lock and why, and what is left.
 *
 *  `owed` IS NULLABLE ON PURPOSE. The balance is only spoken when it was actually read back. If the
 *  reads that price the pay periods did not come back whole, the money is still recorded (its own
 *  row, its own row check) but every figure downstream of those reads is a guess, and a guessed
 *  figure read aloud as "what you still owe" is the one thing this page must never do. `unchecked`
 *  says so out loud and sends him to a reload, instead of the screen going quiet.
 *
 *  `inactive` states a fact rather than blocking on it: settling up with someone who has left is
 *  the most ordinary version of Erik's complaint, and it has to be writable. */
export function paymentSentence(input: {
  name: string;
  amount: number;
  method: PayMethod;
  paidOn: string;
  today: string;
  locked: { start: string; end: string }[];
  blocked?: { start: string; end: string; reason: string } | null;
  owed: number | null;
  unchecked?: boolean;
  inactive?: boolean;
}): string {
  const who = firstName(input.name);
  // "other" is not a word anyone says about money leaving their hand, so it is simply left out.
  const method = input.method === "other" ? "" : `, ${input.method}`;
  const parts = [`Recorded ${sayMoney(input.amount)} to ${who}${method}, ${dayPhrase(input.paidOn, input.today)}.`];
  if (input.locked.length) {
    parts.push(`That covers ${joinLabels(input.locked)} in full, so those hours are locked now.`);
  }
  if (input.blocked) {
    parts.push(
      `${periodLabel(input.blocked.start, input.blocked.end)} could not be locked yet. ${input.blocked.reason} The money is recorded either way, and it will lock on the next payment once that is fixed.`,
    );
  }
  if (input.inactive) {
    parts.push(`${who} is switched off in People, so this is on the books but he will not see it in the app.`);
  }
  if (input.unchecked) {
    parts.push(
      `The pay periods could not be checked just now, so nothing else was locked. The payment is saved. Reload the page to see where it leaves things.`,
    );
  }
  if (input.owed != null && Number.isFinite(input.owed)) parts.push(balancePhrase(input.name, input.owed));
  return parts.join(" ");
}

/** What voidPayment says back. A void is an undo, so it says what it took back AND what that
 *  re-opened, because hours quietly staying locked behind a cancelled payment is exactly the kind
 *  of silence this page exists to end. */
export function voidSentence(input: {
  name: string;
  amount: number;
  paidOn: string;
  today: string;
  unlocked: { start: string; end: string }[];
  blocked?: { start: string; end: string; reason: string } | null;
  /** Null when the reads that price the periods did not come back whole: see paymentSentence. The
   *  void itself is already written and row-checked, so it is stated as fact either way. */
  owed: number | null;
  unchecked?: boolean;
}): string {
  const parts = [
    `Voided the ${sayMoney(input.amount)} payment to ${firstName(input.name)} from ${dayPhrase(input.paidOn, input.today)}.`,
  ];
  if (input.unlocked.length) {
    parts.push(`${joinLabels(input.unlocked)} is unlocked again, so those hours are back on the open list.`);
  }
  if (input.blocked) {
    parts.push(
      `${periodLabel(input.blocked.start, input.blocked.end)} could not be unlocked. ${input.blocked.reason} The payment is voided either way, but those hours are still marked paid, so undo that period on Payroll once that is sorted.`,
    );
  }
  if (input.unchecked) {
    parts.push(
      `The pay periods could not be checked just now, so any hours this payment had locked are still locked. The void is saved. Reload the page and check that person's periods.`,
    );
  }
  if (input.owed != null && Number.isFinite(input.owed)) parts.push(balancePhrase(input.name, input.owed));
  return parts.join(" ");
}

/** WHY A PERIOD WOULD NOT LOCK, said the way Erik talks.
 *
 *  markPeriodPaid / unmarkPeriodPaid are the race-safe lockers and they refuse for good reasons,
 *  but their sentences were written for the Payroll approval screen ("close it on Timecards
 *  first"). This turns the two refusals a payment can actually run into on this page into plain
 *  words that fit inside a payment's own sentence. ANYTHING ELSE IS FORWARDED VERBATIM: an
 *  unrecognized refusal is still the truest thing we know, and swallowing it would be the silence
 *  this page exists to end. */
export function lockRefusalReason(raw: string | null | undefined): string {
  const r = String(raw ?? "").trim();
  if (/open entry/i.test(r)) return "A shift in it is still on the clock. Close it on Timecards.";
  if (/auto-closed/i.test(r))
    return "It holds a shift the app closed by itself, so nobody has checked those hours. Fix it on Timecards.";
  if (/filed under the pay period|pay schedule changed/i.test(r))
    return "Those hours are filed under a different pay period because the pay schedule changed. Put the old schedule back in Settings, undo there, then change it again.";
  if (/just marked paid by someone else|just settled by someone else/i.test(r))
    return "Someone else locked it a moment ago. Reload the page.";
  return r || "Something stopped it.";
}
