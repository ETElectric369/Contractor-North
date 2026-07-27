import { describe, expect, it } from "vitest";
import { hasActiveAccess, graceDaysLeft, PAST_DUE_GRACE_DAYS } from "./subscription";
import { tierForPriceId, planByTier, PLANS, INCLUDED_EVERYWHERE, overFullEstimateAllowance } from "./plans";

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

  /**
   * GATE ON COST, NEVER ON LEVERAGE. These pin the promise itself, because pricing copy is
   * exactly the kind of thing that drifts one word at a time until it means the opposite.
   */
  it("no tier describes itself by what it withholds", () => {
    for (const p of PLANS) {
      expect(p.included.length).toBeGreaterThan(0);
      expect(p.included.toLowerCase()).not.toMatch(/\bnot included\b|\bexcept\b|\bupgrade to\b|\blocked\b/);
    }
  });

  it("tiers are never banded by HEADCOUNT — that's a seat tax in a different hat", () => {
    // An earlier version read "Solo or just you and a helper" / "2–10 people" / "a real company
    // with an office", three lines above a promise never to charge per seat.
    const headcount = /\bsolo\b|\bhelper\b|\d+\s*[-–]\s*\d+\s*(people|users|seats)|\bper (seat|user|person)\b|\bcrew of\b/i;
    for (const p of PLANS) {
      expect(p.blurb).not.toMatch(headcount);
      expect(p.included).not.toMatch(headcount);
      // The support line is the tier axis MOST tempted to say "for teams of 5+".
      expect(p.support).not.toMatch(headcount);
    }
  });

  it("no tier sells a wage metaphor it can't honour", () => {
    // "Nort works mornings" / "Nort full-time" prices a unit nobody can check.
    const wage = /\bpart-time\b|\bfull-time\b|\bworks mornings\b|\bhours? a day\b/i;
    for (const p of PLANS) {
      expect(p.included).not.toMatch(wage);
      expect(p.support).not.toMatch(wage);
    }
  });

  it("the metered unit is something a contractor already counts", () => {
    // Tokens, credits and minutes are OUR units. Estimates are his.
    for (const p of PLANS) {
      if (p.fullEstimatesPerMonth !== null) expect(p.fullEstimatesPerMonth).toBeGreaterThan(0);
      expect(p.included.toLowerCase()).not.toMatch(/token|credit|minute/);
    }
    // The allowance must actually rise with the price, or the ladder means nothing.
    const caps = PLANS.map((p) => p.fullEstimatesPerMonth ?? Infinity);
    expect(caps).toEqual([...caps].sort((a, b) => a - b));
  });

  it("running out NEVER blocks — the allowance only routes to a cheaper model", () => {
    // A billing state must never become a work stoppage; same law as the past-due grace window.
    // Derived from the plan, not hardcoded — the cap moved from 20 to 40 and a literal here went
    // stale silently, which is the same class of bug as pricing copy drifting.
    const cap = PLANS[0].fullEstimatesPerMonth!;
    expect(overFullEstimateAllowance("handyman", cap - 1)).toBe(false);
    expect(overFullEstimateAllowance("handyman", cap)).toBe(true); // "degrade now", not "refuse"
    expect(overFullEstimateAllowance("company", 100_000)).toBe(false); // no cap to exceed
    expect(overFullEstimateAllowance(null, 999)).toBe(false); // unknown plan never gets throttled
  });

  it("the caps sit near real economics, not near segmentation", () => {
    // A full estimate costs ~$0.55; a $59 plan has ~$55 of room, so break-even is ~89. A cap far
    // below that is segmentation wearing a cost costume — the exact thing the file forbids.
    const entry = PLANS[0];
    expect(entry.fullEstimatesPerMonth).not.toBeNull();
    expect(entry.fullEstimatesPerMonth!).toBeGreaterThanOrEqual(35);
  });

  it("every tier states what OUR time buys, the one honest size-linked cost", () => {
    for (const p of PLANS) expect(p.support.length).toBeGreaterThan(10);
    // And it must actually differ, or it isn't an axis.
    expect(new Set(PLANS.map((p) => p.support)).size).toBe(PLANS.length);
  });

  it("everything that costs us nothing per use is listed as included everywhere", () => {
    expect(INCLUDED_EVERYWHERE.length).toBeGreaterThan(3);
    expect(INCLUDED_EVERYWHERE.join(" ").toLowerCase()).toMatch(/never charge per person/);
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
