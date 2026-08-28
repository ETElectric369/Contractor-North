/**
 * WHERE ONE PAY PERIOD ENDS AND THE NEXT BEGINS.
 *
 * Erik: "continuous scroll which should also be on timecards with pay period break lines."
 *
 * Timecards paged one week at a time, so the pay period — the thing payroll is actually cut on —
 * was invisible unless you happened to be looking at the week that started one. A biweekly period
 * is two weeks; you saw one of them and had to remember which half you were on. The heavy column
 * divider marking a period start helped, but only if it fell inside the seven days on screen.
 *
 * Scrolling fixes the paging. This fixes the harder half: when the weeks run past you without a
 * break, they all look alike. A LINE across the stack, naming the period and its hours, turns a
 * scroll into a document with chapters — and the chapter is the unit he gets paid on.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────────────
 *
 * A break is drawn ABOVE a week when a pay period STARTS inside that week. Not "when the week
 * starts a period" — a semimonthly period begins on the 16th, which lands mid-week, and drawing
 * the break at the following Monday would put the line in the wrong place by up to six days on
 * exactly the schedules where the boundary is least obvious.
 */

import { payPeriodBounds } from "@/lib/tz";
import { spanLabel } from "./span-label";

export type PaySchedule = "weekly" | "biweekly" | "semimonthly" | "monthly";

export type PeriodMark = {
  /** First day of the pay period, "YYYY-MM-DD". */
  start: string;
  /** The day AFTER the period's last (payPeriodBounds is half-open). */
  end: string;
  /** True when the period's first day is not the week's first day — the line sits mid-week. */
  midWeek: boolean;
};

/**
 * The pay period that OPENS inside these seven days, if any.
 *
 * Returns null for a week wholly inside one period, which is the common case for biweekly and
 * exactly why the line is worth drawing when it does appear.
 */
export function periodOpeningIn(
  weekDays: string[],
  schedule: PaySchedule,
  anchorYmd: string,
): PeriodMark | null {
  for (const day of weekDays) {
    const p = payPeriodBounds(schedule, anchorYmd, day);
    if (p.start === day) return { start: p.start, end: p.end, midWeek: day !== weekDays[0] };
  }
  return null;
}

/** Parse "YYYY-MM-DD" as a LOCAL date. Never `new Date(ymd)` — that is UTC midnight, and reads as
 *  the previous day west of Greenwich. */
function localDay(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * The period as a person says it — inclusive of its last day.
 *
 * payPeriodBounds is half-open (`end` is the next period's first day), so printing `end` verbatim
 * would name a period that runs a day into the next one. Payroll disputes are made of exactly that.
 */
export function periodLabel(mark: { start: string; end: string }): string {
  const a = localDay(mark.start);
  const z = localDay(mark.end);
  if (!a || !z) return `${mark.start} – ${mark.end}`;
  z.setDate(z.getDate() - 1); // half-open → the last day actually worked
  return spanLabel(a, z, { month: "short" });
}

/** Hours inside a half-open period, from entries already reduced to a day + hours pair. */
export function hoursInPeriod(
  entries: { dayStr: string; hours: number }[],
  mark: { start: string; end: string },
): number {
  let total = 0;
  for (const e of entries) {
    if (e.dayStr >= mark.start && e.dayStr < mark.end) total += Number(e.hours) || 0;
  }
  return Math.round(total * 100) / 100;
}
