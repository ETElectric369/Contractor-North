import type { Organization } from "./types";

/** Days left in the free trial (0 if expired/unknown). */
export function trialDaysLeft(org: Pick<Organization, "trial_ends_at">): number {
  if (!org.trial_ends_at) return 0;
  const ms = new Date(org.trial_ends_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
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
export function graceEndsAt(
  org: Pick<Organization, "current_period_end">,
): Date | null {
  if (!org.current_period_end) return null;
  const end = new Date(org.current_period_end);
  if (isNaN(end.getTime())) return null;
  return new Date(end.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000);
}

/** Days left before a past-due org actually loses access (0 = out of grace). */
export function graceDaysLeft(
  org: Pick<Organization, "subscription_status" | "current_period_end">,
): number {
  if (!GRACE_STATUSES.has(String(org.subscription_status))) return 0;
  const ends = graceEndsAt(org);
  if (!ends) return PAST_DUE_GRACE_DAYS; // no period end recorded → don't lock them out
  return Math.max(0, Math.ceil((ends.getTime() - Date.now()) / 86_400_000));
}

/**
 * Whether the org currently has access:
 *  - a live Stripe subscription (active/trialing), OR
 *  - still inside the built-in free trial window, OR
 *  - past due but still inside the grace window (see above).
 */
export function hasActiveAccess(
  org: Pick<Organization, "subscription_status" | "trial_ends_at" | "current_period_end">,
): boolean {
  if (org.subscription_status === "active") return true;
  if (org.subscription_status === "trialing") {
    return !org.trial_ends_at || new Date(org.trial_ends_at) > new Date();
  }
  if (GRACE_STATUSES.has(String(org.subscription_status))) {
    return graceDaysLeft(org) > 0;
  }
  return false;
}

/** Orgs the paywall NEVER blocks, regardless of subscription/trial state — the
 *  operator's own "house" org(s). Set COMPED_ORG_IDS (comma-separated). This is why
 *  enabling Stripe can never again lock the owner out of their own app. */
export function isCompedOrg(orgId: string | null | undefined): boolean {
  if (!orgId) return false;
  const id = orgId.trim().toLowerCase();
  return (process.env.COMPED_ORG_IDS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(id);
}
