import type { Organization } from "./types";

/** Days left in the free trial (0 if expired/unknown). */
export function trialDaysLeft(org: Pick<Organization, "trial_ends_at">): number {
  if (!org.trial_ends_at) return 0;
  const ms = new Date(org.trial_ends_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * Whether the org currently has access:
 *  - a live Stripe subscription (active/trialing), OR
 *  - still inside the built-in free trial window.
 */
export function hasActiveAccess(
  org: Pick<Organization, "subscription_status" | "trial_ends_at">,
): boolean {
  if (org.subscription_status === "active") return true;
  if (org.subscription_status === "trialing") {
    return !org.trial_ends_at || new Date(org.trial_ends_at) > new Date();
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
