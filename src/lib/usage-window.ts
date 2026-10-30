import { localeOf } from "@/lib/locale";

/**
 * THE USAGE WINDOW (cn-v1140) — the one meter, like the Claude usage window. Pure math, dated by
 * argument, so a test can stand on any day of any month and the ring never reads a clock of its own.
 *
 * Erik's design (2026-10-30): "stick to KISS — look at how Anthropic pulls tokens; adding estimates
 * doesn't make sense; usage is understandable to anyone." So ONE number, a percent of the month's
 * usage, with the day it resets under it, and a color that follows the warnings. Dollars never
 * reach a surface; "estimates" is never a unit. What is counted is the company's model spend this
 * calendar month (the ledger, lib/usage-meter) against the plan's monthly budget plus any extra
 * usage bought (a top-up, 0401). Past 100% nothing stops: Nort and the estimator run on the lighter
 * model until the month turns (lib/ai-cost tierOfUsage).
 *
 * THE STATES, by priority:
 *   out     pct ≥ 100 — the lighter model until the reset
 *   almost  pct ≥ 90
 *   watch   pct ≥ 80, or pct ≥ 50 with a run-out day inside the month (the pace says it will not last)
 *   fine    everything else; a month with nothing spent is fine with no forecast
 *
 * THE FORECAST: pace = spent ÷ the day of the month; the run-out day is today + ceil((cap − spent) ÷
 * pace) when that lands before the reset, else none. A company already out has no forecast — it is
 * not a forecast any more.
 *
 * DATES are the company's own: `today` is YYYY-MM-DD in its timezone (todayIn), the reset is the
 * 1st of the next month on that calendar, and a trial's end is read on the same calendar. All of it
 * through Intl, no library.
 */
export type UsageState = "fine" | "watch" | "almost" | "out";

export type UsageWindowInput = {
  /** This month's model spend, internal dollars (the ledger's unit). */
  spentUsd: number;
  /** The plan's monthly budget, internal dollars. */
  budgetUsd: number;
  /** Extra usage bought for this month, internal dollars. */
  topupUsd?: number;
  /** Today, YYYY-MM-DD, in the company's timezone. */
  today: string;
  /** The company's IANA timezone; reads the trial's end on its calendar. */
  timezone?: string;
  /** The trial's end instant (organizations.trial_ends_at), when there is one. */
  trialEndsAt?: string | null;
};

export type UsageWindow = {
  /** 0–100, the one number inside the ring. */
  pct: number;
  state: UsageState;
  /** The 1st of next month, YYYY-MM-DD: "Resets Nov 1". */
  resetOn: string;
  /** The day the month's usage runs out at this pace, YYYY-MM-DD, when it lands before the reset. */
  runOutOn: string | null;
  /** Days from today to the reset. */
  daysLeft: number;
  /** YYYY-MM, the month the spend and the top-ups are keyed on. */
  monthKey: string;
  /** The trial's last day on the company's calendar, YYYY-MM-DD, when there is a trial. */
  trialEndsOn?: string;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD as a UTC-noon Date: calendar arithmetic no zone can shift. */
const noon = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => {
  const d = noon(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return ymdOf(d);
};
const daysBetween = (fromYmd: string, toYmd: string) => Math.round((noon(toYmd).getTime() - noon(fromYmd).getTime()) / 86_400_000);

/** The 1st of the month after the one `ymd` is in (December → next January). */
export function firstOfNextMonth(ymd: string): string {
  const d = noon(ymd);
  return ymdOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 12)));
}

/** The 1st of the month `monthKey` (YYYY-MM) names, YYYY-MM-DD. */
export function firstOfMonth(monthKey: string): string {
  return `${monthKey}-01`;
}

/** "YYYY-MM-DD" for `at` (default now) in the given timezone; UTC when the zone is not one Intl knows. */
export function todayIn(timezone: string, at: Date = new Date()): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  try {
    return fmt(timezone);
  } catch {
    return fmt("UTC");
  }
}

/** "YYYY-MM" for `date` in the given timezone — the month the spend and the top-ups are keyed on. */
export function monthKeyFor(date: Date, timezone: string): string {
  return todayIn(timezone, date).slice(0, 7);
}

/** A YYYY-MM-DD as "Nov 1" (en) or "1 nov" (es): the reset day under the ring, the run-out day in a line. */
export function shortDate(ymd: string, lang: string | null | undefined): string {
  if (!YMD.test(ymd)) return ymd;
  return new Intl.DateTimeFormat(localeOf(lang), { month: "short", day: "numeric", timeZone: "UTC" }).format(noon(ymd));
}

const clean = (n: unknown) => (Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0);

export function usageWindow(input: UsageWindowInput): UsageWindow {
  // A real calendar day, round-tripped (V8 reads "2026-02-30" as March 2): anything else is today.
  const today = YMD.test(input.today) && ymdOf(noon(input.today)) === input.today ? input.today : todayIn(input.timezone || "UTC");
  const spent = clean(input.spentUsd);
  const cap = clean(input.budgetUsd) + clean(input.topupUsd);
  const monthKey = today.slice(0, 7);
  const resetOn = firstOfNextMonth(today);
  const daysLeft = daysBetween(today, resetOn);
  const dayOfMonth = Math.max(1, Number(today.slice(8, 10)) || 1);

  // The one number, FLOORED: 99.5% is not "out" (a round would say 100 and move the company to the
  // lighter model with usage still in hand). A cap of nothing (a plan with no budget) reads as
  // used up the moment a cent is spent, never as a division by zero.
  const pct = cap > 0 ? Math.min(100, Math.floor((100 * spent) / cap)) : spent > 0 ? 100 : 0;

  // The forecast: at this month's pace so far, which day does the cap run out — only when it lands
  // before the reset, and never for a company already out (that is not a forecast any more).
  let runOutOn: string | null = null;
  if (spent > 0 && spent < cap) {
    const pace = spent / dayOfMonth;
    const days = Math.ceil((cap - spent) / pace);
    const candidate = addDays(today, Math.max(0, days));
    if (candidate < resetOn) runOutOn = candidate;
  }

  const state: UsageState =
    pct >= 100 ? "out" : pct >= 90 ? "almost" : pct >= 80 || (pct >= 50 && runOutOn !== null) ? "watch" : "fine";

  const out: UsageWindow = { pct, state, resetOn, runOutOn, daysLeft, monthKey };
  if (input.trialEndsAt) {
    const end = new Date(input.trialEndsAt);
    if (!Number.isNaN(end.getTime())) out.trialEndsOn = todayIn(input.timezone || "UTC", end);
  }
  return out;
}
