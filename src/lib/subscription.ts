import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

/** The free trial's length in days. The database default (0004: now() + 14 days) is the one that
 *  sets it; this is the one place the number is SPOKEN (the notices, the cohort door). */
export const TRIAL_DAYS = 14;

/** Days left in the free trial (0 if expired/unknown). UTC-instant math: 23 hours left reads as 1. */
export function trialDaysLeft(org: { trial_ends_at?: string | null }): number {
  return trialDaysLeftAt(org, Date.now());
}

export function trialDaysLeftAt(org: { trial_ends_at?: string | null }, nowMs: number): number {
  if (!org.trial_ends_at) return 0;
  const ms = new Date(org.trial_ends_at).getTime() - nowMs;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * THE COMPANY'S OWN CALENDAR (cn-v1137). "Ends tomorrow" and "ends today" are calendar words, so the
 * trial notices count the days between today's date and the trial's end date IN THE COMPANY'S OWN
 * ZONE — never the UTC ceiling above, which says "1 day" at 11 PM and flips at a UTC midnight nobody
 * in Truckee is awake for. 0 = ends today (or already ended); the caller asks accessState whether the
 * trial is still live.
 */
export function trialDaysLeftLocal(org: { trial_ends_at?: string | null }, tz: string, nowMs: number): number {
  if (!org.trial_ends_at) return 0;
  const end = new Date(org.trial_ends_at);
  if (isNaN(end.getTime())) return 0;
  const todayYmd = todayStrInTz(tz, new Date(nowMs));
  const endYmd = todayStrInTz(tz, end);
  const days = Math.round((tzDayStartUtc(endYmd, tz).getTime() - tzDayStartUtc(todayYmd, tz).getTime()) / 86_400_000);
  return Math.max(0, days);
}

/**
 * GRACE WINDOW after a failed payment (0.9). A contractor's card expires or his
 * business account gets closed — cards fail constantly in the trades. Without this,
 * `past_due` denied access the same instant Stripe reported it: at 6am his three
 * techs can't clock in, can't see the schedule, can't open a job. That's a work
 * stoppage caused by a billing event, and it's the single most likely cause of an
 * angry first churn. Involuntary churn is 20-40% of all churn in subscription
 * businesses and it's the cheapest kind to fix — the customer still WANTS the product.
 */
export const PAST_DUE_GRACE_DAYS = Number(process.env.PAST_DUE_GRACE_DAYS || 10);

/** Statuses where Stripe is still trying (or we're still waiting on the customer). */
const GRACE_STATUSES = new Set(["past_due", "unpaid", "incomplete"]);

/** When the grace window closes — measured from the end of the period they paid for. */
export function graceEndsAt(org: { current_period_end?: string | null }): Date | null {
  if (!org.current_period_end) return null;
  const end = new Date(org.current_period_end);
  if (isNaN(end.getTime())) return null;
  return new Date(end.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000);
}

/** Days left before a past-due org actually loses access (0 = out of grace). */
export function graceDaysLeft(org: {
  subscription_status?: string | null;
  current_period_end?: string | null;
}): number {
  return graceDaysLeftAt(org, Date.now());
}

export function graceDaysLeftAt(
  org: { subscription_status?: string | null; current_period_end?: string | null },
  nowMs: number,
): number {
  if (!GRACE_STATUSES.has(String(org.subscription_status))) return 0;
  const ends = graceEndsAt(org);
  if (!ends) return PAST_DUE_GRACE_DAYS; // no period end recorded → don't lock them out
  return Math.max(0, Math.ceil((ends.getTime() - nowMs) / 86_400_000));
}

/** The billing columns every access decision reads. One list, so a cron's select (cron-orgs
 *  withBillingColumns), the (app) layout's select, Nort's chat route's select and the server-side
 *  reader (org-access) all build their lists FROM it and cannot drift apart (projection law). */
export const BILLING_COLUMNS = ["subscription_status", "trial_ends_at", "current_period_end", "comped_until"] as const;

export type BillingOrg = {
  id?: string | null;
  subscription_status?: string | null;
  trial_ends_at?: string | null;
  current_period_end?: string | null;
  /** cn-v1137 (0400): the founding-cohort state as a column. In the future = access, no notices. */
  comped_until?: string | null;
};

/** Whether a comped_until stamp is live at `nowMs`. */
export function compedUntilLive(org: { comped_until?: string | null }, nowMs = Date.now()): boolean {
  if (!org.comped_until) return false;
  const t = new Date(org.comped_until).getTime();
  return !isNaN(t) && t > nowMs;
}

/**
 * Whether the org currently has access:
 *  - comped (the column, cn-v1137; the env list is the layout's own extra check, isCompedOrg), OR
 *  - a live Stripe subscription (active/trialing), OR
 *  - still inside the built-in free trial window, OR
 *  - past due but still inside the grace window (see above).
 */
export function hasActiveAccess(org: BillingOrg): boolean {
  return accessState(org).active;
}

export type AccessReason =
  | "comped"
  | "active"
  | "trial"
  | "grace"
  | "trial_ended"
  | "grace_spent"
  | "canceled"
  | "unknown";

export type AccessState = {
  active: boolean;
  reason: AccessReason;
  /** trial: days left (UTC ceil, or the company's calendar when `tz` is given); grace: days of grace
   *  left; comped: days until the comp ends; otherwise null. */
  daysLeft: number | null;
  compedBy: "column" | "env" | null;
};

/**
 * THE ONE ACCESS RULE (cn-v1137). Every door that decides anything about a company's standing —
 * the layout's wall, /subscribe's headline, the trial notices, the lapse refusals in Nort, voice,
 * texts and the crons, the Companies rows on Bug Watch — reads THIS and never re-derives it from the
 * columns (two-doors law). `reason` is what the words are built from; `active` is the only boolean.
 */
export function accessState(org: BillingOrg, opts: { nowMs?: number; tz?: string } = {}): AccessState {
  const nowMs = opts.nowMs ?? Date.now();
  if (compedUntilLive(org, nowMs)) {
    const days = Math.max(0, Math.ceil((new Date(org.comped_until as string).getTime() - nowMs) / 86_400_000));
    return { active: true, reason: "comped", daysLeft: days, compedBy: "column" };
  }
  if (org.id && isCompedOrg(org.id)) return { active: true, reason: "comped", daysLeft: null, compedBy: "env" };
  const status = org.subscription_status == null ? null : String(org.subscription_status);
  if (status === "active") return { active: true, reason: "active", daysLeft: null, compedBy: null };
  if (status === "trialing") {
    if (!org.trial_ends_at) return { active: true, reason: "trial", daysLeft: null, compedBy: null };
    const end = new Date(org.trial_ends_at).getTime();
    if (isNaN(end) || end > nowMs) {
      const days = opts.tz ? trialDaysLeftLocal(org, opts.tz, nowMs) : trialDaysLeftAt(org, nowMs);
      return { active: true, reason: "trial", daysLeft: days, compedBy: null };
    }
    return { active: false, reason: "trial_ended", daysLeft: 0, compedBy: null };
  }
  if (status && GRACE_STATUSES.has(status)) {
    const g = graceDaysLeftAt(org, nowMs);
    return g > 0
      ? { active: true, reason: "grace", daysLeft: g, compedBy: null }
      : { active: false, reason: "grace_spent", daysLeft: 0, compedBy: null };
  }
  if (status === null || status === "") return { active: false, reason: "unknown", daysLeft: null, compedBy: null };
  return { active: false, reason: "canceled", daysLeft: null, compedBy: null };
}

/** Orgs the paywall NEVER blocks, regardless of subscription/trial state — the
 *  operator's own "house" org(s). Set COMPED_ORG_IDS (comma-separated). This is why
 *  enabling Stripe can never again lock the owner out of their own app. Since cn-v1137 the
 *  column `comped_until` is the door (Bug Watch › Companies); the env list stays honored. */
export function isCompedOrg(orgId: string | null | undefined): boolean {
  if (!orgId) return false;
  const id = orgId.trim().toLowerCase();
  return (process.env.COMPED_ORG_IDS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(id);
}
