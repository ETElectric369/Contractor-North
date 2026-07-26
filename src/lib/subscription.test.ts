import { describe, expect, it } from "vitest";
import { hasActiveAccess, graceDaysLeft, PAST_DUE_GRACE_DAYS } from "./subscription";
import { tierForPriceId, planByTier, PLANS } from "./plans";

const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/**
 * THE HARM these guard: a contractor's card fails and at 6am his three techs can't
 * clock in, can't see the schedule, can't open a job. That's a work stoppage caused
 * by a billing event — the most likely cause of an angry first churn, and the
 * cheapest churn to prevent because the customer still wants the product.
 */
describe("past-due grace window", () => {
  it("a declined card does NOT lock the crew out the same morning", () => {
    const org = { subscription_status: "past_due", trial_ends_at: null, current_period_end: daysFromNow(-1) };
    expect(hasActiveAccess(org as never)).toBe(true);
  });

  it("access ends once the grace window is genuinely spent", () => {
    const org = {
      subscription_status: "past_due",
      trial_ends_at: null,
      current_period_end: daysFromNow(-(PAST_DUE_GRACE_DAYS + 1)),
    };
    expect(hasActiveAccess(org as never)).toBe(false);
  });

  it("counts down the days so the banner can escalate", () => {
    const org = { subscription_status: "past_due", current_period_end: daysFromNow(-2) };
    expect(graceDaysLeft(org as never)).toBe(PAST_DUE_GRACE_DAYS - 2);
  });

  it("a missing period end does not lock anyone out", () => {
    // We'd rather carry an unpaid org for a while than bar a paying contractor
    // from his own schedule because a webhook never wrote a date.
    const org = { subscription_status: "past_due", current_period_end: null };
    expect(hasActiveAccess(org as never)).toBe(true);
  });

  it("grace covers unpaid and incomplete too — all 'Stripe is still trying' states", () => {
    for (const status of ["unpaid", "incomplete"]) {
      expect(hasActiveAccess({ subscription_status: status, current_period_end: daysFromNow(-1) } as never)).toBe(true);
    }
  });

  it("a deliberate cancellation gets NO grace", () => {
    // Grace is for a payment that failed, not for someone who chose to leave.
    expect(hasActiveAccess({ subscription_status: "canceled", current_period_end: daysFromNow(-1) } as never)).toBe(false);
  });

  it("still honours active and an unexpired trial", () => {
    expect(hasActiveAccess({ subscription_status: "active" } as never)).toBe(true);
    expect(hasActiveAccess({ subscription_status: "trialing", trial_ends_at: daysFromNow(3) } as never)).toBe(true);
    expect(hasActiveAccess({ subscription_status: "trialing", trial_ends_at: daysFromNow(-3) } as never)).toBe(false);
  });
});

describe("the plan ladder", () => {
  it("prices rise across the three tiers", () => {
    const monthly = PLANS.map((p) => p.monthly);
    expect(monthly).toEqual([...monthly].sort((a, b) => a - b));
    expect(new Set(monthly).size).toBe(PLANS.length);
  });

  it("annual is a real discount at every tier", () => {
    for (const p of PLANS) expect(p.annual).toBeLessThan(p.monthly);
  });

  it("every tier differs by AUTONOMY, never by withheld features", () => {
    // The commitment is "every tier ships the whole product." If a tier ever starts
    // describing itself by what it lacks, that promise has quietly broken.
    for (const p of PLANS) {
      expect(p.autonomy.length).toBeGreaterThan(0);
      expect(p.autonomy.toLowerCase()).not.toMatch(/\bnot included\b|\bexcept\b|\bupgrade to\b/);
    }
  });

  it("an unknown price id resolves to no tier rather than guessing", () => {
    expect(tierForPriceId("price_never_seen")).toBeNull();
    expect(tierForPriceId(null)).toBeNull();
  });

  it("planByTier rejects junk", () => {
    expect(planByTier("enterprise")).toBeNull();
    expect(planByTier(undefined)).toBeNull();
  });
});
