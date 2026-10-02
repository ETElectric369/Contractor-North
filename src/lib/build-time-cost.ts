import { hoursBetween } from "@/lib/utils";
import { payRateForEntry } from "@/lib/payroll-math";
import { isPaidByDraw } from "@/lib/profile-columns";

/**
 * BUILD TIME IS A DIRECT COST, WHOEVER WORKED IT (Erik, 2026-10-01).
 *
 * His words: "build time, including my build time is considered COGS, so it would be considered a
 * direct cost and should be counted that way". That is the whole of this file: an hour spent
 * building a job costs the business something, and the business is not more profitable because the
 * person who worked the hour happens to own it.
 *
 * WHAT CAME BEFORE, AND WHY IT WAS HALF RIGHT. Migration 0286 made the owner's hours cost $0. It
 * was written for a real defect: Erik's COST rate (profiles.hourly_rate, 125) was also his BILL
 * rate (125), so every hour he worked netted exactly $0, and because he works about 80% of all job
 * labour, all-time job profit read −$1,085 when the business had cleared +$35,847. But the defect
 * was never "his time is a cost" — it was that his cost equalled his price. Zeroing the cost
 * overshot the other way: it INFLATED every job's profit and the company's Gross Profit by all of
 * his labour. The right answer is a real cost rate, separate from the bill rate, with the margin
 * being the difference between them.
 *
 * COSTING IS NOT PAYING. A sole proprietor is not an employee of his own sole proprietorship: no
 * W-2, no withholding, no pay period, no "owed" balance. So payroll keeps refusing him exactly as
 * it does today (payroll-math.ts's ownerWagesRefusal, and 0286's three triggers), and
 * payRateForEntry — the PAYROLL answer, "what does this hour PAY the person" — still returns 0 for
 * him. This file answers a different question: "what did this hour COST the business". Two
 * questions, two functions, and the second one is here, once.
 *
 * ── WHY THE RULE LIVES HERE AND NOT AT THE DOOR THE RATES COME THROUGH ────────────────────────────
 *
 * 0286 put its rule in SQL, at profile_pay, "the ONE door every reader already reads rates through",
 * and then wrote it a second time in TypeScript at every money path (payRateForEntry, laborCostForJob,
 * crewPayByMonth). Two copies meant the SQL could not be undone on its own: a real figure in
 * profile_pay.hourly_rate would be swallowed by the app's own short-circuits and nothing would move.
 * It also cannot go back into hourly_rate at all — profile_pay reads an owner's bill rate as
 * coalesce(bill_rate, hourly_rate), so a cost rate stored there becomes his BILL rate the moment his
 * bill rate is blank, which is the original bug restored, on a customer's invoice.
 *
 * So: a column of its own (profiles.cost_rate, migration 0373), and ONE expression over it, here.
 * Every reader that turns hours into cost calls `buildTimeRate` or `tallyBuildTime` and decides
 * nothing for itself. A tripwire (build-time-is-a-cost.test.ts) fails if a reader writes the
 * predicate again.
 *
 * ── THE RATE NOBODY HAS SAID YET ──────────────────────────────────────────────────────────────────
 *
 * Erik has not given his cost rate, and it is NOT his $125 bill rate. profiles.cost_rate is
 * therefore nullable with no default and no backfill: null means "nobody has said", which is the one
 * state that is true today. An hour with no rate behind it is NOT costed at $0 silently — it comes
 * back in `uncostedHours`, every surface that would have used it says so in words, and the Team page
 * is where the rate gets typed. A figure built on a guess is worse than a figure that asks a
 * question.
 *
 * Pure: no I/O, no React.
 */

/** What one hour of build time costs the business, and where that figure came from. */
export type BuildTimeRate = {
  /** Dollars an hour. Null when nobody has said yet: an hour at null is counted, never costed. */
  rate: number | null;
  /** True when this shift is an owner's. His build time is COGS at his cost rate, never a wage. */
  owner: boolean;
  /**
   *   shift_rate  this shift carried its own pay rate (a supervisor rate for the day)
   *   pay_rate    what the business pays this person an hour
   *   cost_rate   the owner's own cost rate, the figure he set for his build time
   *   unset       nobody has said what this hour costs
   */
  from: "shift_rate" | "pay_rate" | "cost_rate" | "unset";
};

/** The rate facts a shift can carry, however its reader got them onto the row. */
type RateRow = {
  cost_rate?: unknown;
  hourly_rate?: unknown;
  paid_by_draw?: unknown;
};

type EntryLike = {
  rate_override?: unknown;
  paid_by_draw?: unknown;
  cost_rate?: unknown;
  profiles?: RateRow | null;
};

const num = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Is this shift an owner's? One expression, so no reader decides it for itself. */
export function isOwnerShift(e: EntryLike | null | undefined): boolean {
  return isPaidByDraw(e?.profiles) || e?.paid_by_draw === true;
}

/**
 * THE ONE RULE: what this shift's hours cost the business, an hour.
 *
 * An owner's hours cost his COST rate (profiles.cost_rate, read through profile_pay), and nothing
 * else — never his bill rate, never the pay column 0286 reads as 0 for him, never a rate_override
 * (the database refuses one on his shift, and an override is a wage by another name). Everyone
 * else's hours cost what payroll pays them, which is already one expression: payRateForEntry.
 *
 * `fallbacks` is for a reader whose rows carry no joined profile (a frozen snapshot, a single-person
 * read): the same shape payRateForEntry's fallbackRate has, plus the owner's half.
 */
export function buildTimeRate(
  e: EntryLike | null | undefined,
  fallbacks: { payRate?: number | null; costRate?: number | null } = {},
): BuildTimeRate {
  if (isOwnerShift(e)) {
    const rate = num(e?.profiles?.cost_rate ?? e?.cost_rate) ?? num(fallbacks.costRate);
    return { rate, owner: true, from: rate == null ? "unset" : "cost_rate" };
  }
  const override = num(e?.rate_override);
  const rate = num(payRateForEntry(e, Number(fallbacks.payRate ?? 0) || 0));
  return { rate, owner: false, from: rate == null ? "unset" : override != null ? "shift_rate" : "pay_rate" };
}

/** One tally of build time: the hours, what they cost, and the hours nobody has priced yet. */
export type BuildTimeTally = {
  /** Every closed hour counted, costed or not. */
  hours: number;
  /** What those hours cost, in dollars: crew and owner together. This is the COGS figure. */
  cost: number;
  /** The owner's share of `hours` — his build time, said as hours wherever a screen says whose. */
  ownerHours: number;
  /** The owner's share of `cost`: his build time in dollars. $0 until he sets his cost rate. */
  ownerCost: number;
  /** CREW hours with no pay rate set (audit v994 MR3): reported, never swallowed. */
  unratedHours: number;
  /** OWNER hours with no cost rate set: reported the same way, and `cost` is short by them. */
  uncostedOwnerHours: number;
  /** The owners whose hours are in here, for the sentence that names them. */
  owners: { id: string; name: string | null }[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Add up build time over a set of closed shifts, at the one rule's rates.
 *
 * `jobId` narrows to one job's shifts (the job hub and /analytics both hand this whole lists).
 * Everything else about a shift — a split is ordinary entries (0288), a job-less piece carrying a
 * time code belongs to no job — is unchanged.
 */
export function tallyBuildTime(
  entries: readonly any[] | null | undefined,
  opts: { jobId?: string; payRate?: number | null; costRate?: number | null } = {},
): BuildTimeTally {
  let hours = 0;
  let cost = 0;
  let ownerHours = 0;
  let ownerCost = 0;
  let unratedHours = 0;
  let uncostedOwnerHours = 0;
  const owners = new Map<string, { id: string; name: string | null }>();
  for (const e of entries ?? []) {
    if (opts.jobId !== undefined && e?.job_id !== opts.jobId) continue;
    if (e?.status !== "closed" || !e.clock_out) continue;
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    const r = buildTimeRate(e, { payRate: opts.payRate, costRate: opts.costRate });
    hours += h;
    const money = r.rate == null ? 0 : h * r.rate;
    cost += money;
    if (r.owner) {
      ownerHours += h;
      ownerCost += money;
      if (r.rate == null) uncostedOwnerHours += h;
      if (e.profile_id) {
        const id = String(e.profile_id);
        if (!owners.has(id)) owners.set(id, { id, name: e?.profiles?.full_name ?? null });
      }
    } else if (r.rate == null) {
      unratedHours += h;
    }
  }
  return {
    hours: round2(hours),
    cost: round2(cost),
    ownerHours: round2(ownerHours),
    ownerCost: round2(ownerCost),
    unratedHours: round2(unratedHours),
    uncostedOwnerHours: round2(uncostedOwnerHours),
    owners: [...owners.values()],
  };
}

/**
 * WHAT A SCREEN SAYS WHEN AN OWNER'S BUILD TIME IS NOT COSTED YET (nothing silent).
 *
 * One sentence, in the register of whoever is reading ("your build time" / "Erik's build time"), and
 * it names the door: the Team page, where the cost rate is typed. Every surface that would have used
 * the rate says this instead of printing a figure built on a guess — the Net Profit card, the job's
 * Costs tab, the accountant's Summary, Nort.
 */
export const BUILD_TIME_RATE_DOOR = "Set a cost rate on the Team page";

/**
 * THE OWNER'S BUILD TIME, IN ONE SENTENCE, FOR EVERY PROSE READER (0373).
 *
 * Twelve hand-written sentences across the app and Nort's tool descriptions used to assert "the owner's
 * hours are never a cost" as a FACT. Half of that is still true and half of it is now false, and the
 * dangerous ones were the six in tool descriptions, which a model reads as ground truth and repeats to
 * Erik. So the distinction is written ONCE, here, and every one of them says it by reference:
 *
 *   never a WAGE and never a DEDUCTION on the profit and loss   (so his Schedule C figure is safe,
 *                                                                which is what 0286 was protecting)
 *   AND charged to the JOB he worked, at a cost rate            (so the job's margin is honest)
 *
 * A reader that only knows the first half calls an owner-worked job more profitable than it is. A reader
 * that only knows the second half understates his net profit and gets his tax return wrong.
 */
export const BUILD_TIME_IS_A_COST_NOT_A_WAGE =
  // NO DOLLAR FIGURE IN THIS SENTENCE, not even a zero: nort-examples.test.ts bans a dollar amount in a
  // tool description, because a model repeats one as though the app had said it.
  "THE OWNER'S OWN BUILD TIME: his hours ON A JOB are a direct cost of that job, at a cost rate he sets (never his bill rate), so they ARE in that job's cost and in Cost of Goods Sold (COGS). They are never a wage - he is paid by owner's draw and is not on payroll - and the company's profit and loss books the same amount straight back on a contra line, so Net Profit is unchanged and his own labour is never deducted. His OFFICE hours are Overhead and are on no job. If no cost rate is set, uncosted_owner_hours is above zero: his build time is counted and NOT costed, so say that and say the jobs he worked read high, rather than quoting a cost for it.";

export function buildTimeNotCostedSentence(hours: number, who: "you" | string): string {
  const h = Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0$/, "");
  const noun = hours === 1 ? "hour" : "hours";
  const whose = who === "you" ? "your" : `${who}'s`;
  return `${h} ${noun} of ${whose} build time are not costed yet: no cost rate is set, so they count as hours and add nothing to Cost of Goods Sold (COGS). ${BUILD_TIME_RATE_DOOR}.`;
}
