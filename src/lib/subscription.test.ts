import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasActiveAccess,
  graceDaysLeft,
  PAST_DUE_GRACE_DAYS,
  TRIAL_DAYS,
  BILLING_COLUMNS,
  accessState,
  compedUntilLive,
  isCompedOrg,
  trialDaysLeftAt,
  trialDaysLeftLocal,
} from "./subscription";
import { tierForPriceId, planByTier, PLANS, INCLUDED_EVERYWHERE } from "./plans";

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

  it("the metered unit is ONE meter called usage — never tokens, credits, minutes or a count of estimates (cn-v1140)", () => {
    // Tokens, credits and minutes are OUR units; a count of estimates was a unit Erik would have
    // had to explain. Usage, as a percent of the month, is understandable to anyone.
    for (const p of PLANS) {
      expect(p.usageUsdPerMonth).toBeGreaterThan(0);
      expect(p.included.toLowerCase()).not.toMatch(/token|credit|minute/);
      expect(p.included).not.toMatch(/\d+ (full )?estimates/);
      expect(p.included).not.toMatch(/\$/); // the budget is internal; the words say a multiple
      expect(p.included.toLowerCase()).toContain("usage");
      expect(p).not.toHaveProperty("fullEstimatesPerMonth");
    }
    // The budget must actually rise with the price, or the ladder means nothing.
    const budgets = PLANS.map((p) => p.usageUsdPerMonth);
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
    expect(new Set(budgets).size).toBe(budgets.length);
  });

  it("the pricing words say the multiple of Handyman, and the multiple IS the budgets' ratio (the 3× / 8× are literals in `included`)", () => {
    const handyman = planByTier("handyman")!.usageUsdPerMonth;
    expect(planByTier("crew")!.usageUsdPerMonth / handyman).toBe(3);
    expect(planByTier("company")!.usageUsdPerMonth / handyman).toBe(8);
    expect(planByTier("crew")!.included).toMatch(/^3× the usage of Handyman/);
    expect(planByTier("company")!.included).toMatch(/^8× the usage of Handyman/);
    expect(planByTier("handyman")!.included).toBe("Plenty of usage for a few jobs a month — Nort, the estimator and plan reading included. Everything else, unlimited.");
    for (const p of PLANS) expect(p.included).toMatch(/Everything else, unlimited\.$/);
  });

  it("running out NEVER blocks — the file says so, and the budgets sit near real economics, not near segmentation", () => {
    // A billing state must never become a work stoppage; same law as the past-due grace window.
    // The rule itself lives in lib/ai-cost tierOfUsage (full | lighter, never a refusal) and is
    // pinned there; this is the ladder's own promise.
    const source = readFileSync(join(process.cwd(), "src/lib/plans.ts"), "utf8");
    expect(source).toContain("NEVER CUT OFF OPERATIONS");
    expect(source).toMatch(/drop to the lighter model and say so plainly/);
    // Every budget is a fraction of its price with a healthy margin, and the bigger plans are the
    // better deal on usage: the budget rises faster than the price.
    for (const p of PLANS) expect(p.usageUsdPerMonth).toBeLessThan(p.monthly * 0.3);
    const perDollar = PLANS.map((p) => p.usageUsdPerMonth / p.monthly);
    expect(perDollar).toEqual([...perDollar].sort((a, b) => a - b));
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

/**
 * THE ONE ACCESS RULE (cn-v1137): accessState is what every door reads — the layout's wall, the
 * trial notices, the lapse refusals, the crons' skip, the Companies rows on Bug Watch — so each
 * branch is pinned here with `nowMs` injected. A comp is a column now (0400, comped_until) and the
 * env list stays the belt; the trial's days are counted on the company's own calendar.
 */
describe("accessState: the comp column", () => {
  const NOW = Date.parse("2026-10-28T17:00:00Z");
  const at = (iso: string) => Date.parse(iso);

  it("a comped_until in the future is access, reason comped, by the column — whatever Stripe says", () => {
    const org = { subscription_status: "canceled", trial_ends_at: "2026-01-01T00:00:00Z", comped_until: "2026-12-31T00:00:00Z" };
    expect(accessState(org, { nowMs: NOW })).toEqual({ active: true, reason: "comped", daysLeft: 64, compedBy: "column" });
    expect(compedUntilLive(org, NOW)).toBe(true);
    expect(hasActiveAccess({ ...org, comped_until: new Date(Date.now() + 86_400_000).toISOString() })).toBe(true);
  });

  it("a comped_until in the past is ignored: the row falls through to its Stripe standing", () => {
    const org = { subscription_status: "canceled", comped_until: "2026-10-01T00:00:00Z" };
    expect(compedUntilLive(org, NOW)).toBe(false);
    expect(accessState(org, { nowMs: NOW })).toEqual({ active: false, reason: "canceled", daysLeft: null, compedBy: null });
    expect(accessState({ subscription_status: "active", comped_until: "2026-10-01T00:00:00Z" }, { nowMs: NOW }).reason).toBe("active");
    // Exactly now is not the future; a date nothing can parse is no comp.
    expect(compedUntilLive({ comped_until: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(compedUntilLive({ comped_until: "not a date" }, NOW)).toBe(false);
    expect(compedUntilLive({ comped_until: null }, NOW)).toBe(false);
  });

  it("the days until the comp ends are a ceiling: an hour left reads as 1, and never below 0", () => {
    expect(accessState({ comped_until: new Date(NOW + 3_600_000).toISOString() }, { nowMs: NOW }).daysLeft).toBe(1);
    expect(accessState({ comped_until: new Date(NOW + 10 * 86_400_000).toISOString() }, { nowMs: NOW }).daysLeft).toBe(10);
    expect(accessState({ comped_until: new Date(at("2026-11-02T17:00:00Z")).toISOString() }, { nowMs: NOW }).daysLeft).toBe(5);
  });

  it("the billing columns every access decision reads name the comp", () => {
    expect([...BILLING_COLUMNS]).toEqual(["subscription_status", "trial_ends_at", "current_period_end", "comped_until"]);
    expect(TRIAL_DAYS).toBe(14);
  });
});

describe("accessState: every reason, with nowMs injected", () => {
  const NOW = Date.parse("2026-10-28T17:00:00Z");
  const days = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
  const state = (org: Parameters<typeof accessState>[0]) => accessState(org, { nowMs: NOW });

  it("active: a live subscription", () => {
    expect(state({ subscription_status: "active" })).toEqual({ active: true, reason: "active", daysLeft: null, compedBy: null });
    // An expired trial date beside an active subscription is Stripe's leftover, not a lapse.
    expect(state({ subscription_status: "active", trial_ends_at: days(-30) }).reason).toBe("active");
  });

  it("trial: trialing with an end in the future carries the days left (UTC ceiling without a tz)", () => {
    expect(state({ subscription_status: "trialing", trial_ends_at: days(3) })).toEqual({ active: true, reason: "trial", daysLeft: 3, compedBy: null });
    expect(state({ subscription_status: "trialing", trial_ends_at: new Date(NOW + 3_600_000).toISOString() }).daysLeft).toBe(1);
    // No end date recorded, or one nothing can parse: still trialing, days unknown — never a lockout over a missing date.
    expect(state({ subscription_status: "trialing", trial_ends_at: null })).toEqual({ active: true, reason: "trial", daysLeft: null, compedBy: null });
    expect(state({ subscription_status: "trialing", trial_ends_at: "garbage" })).toMatchObject({ active: true, reason: "trial" });
  });

  it("trial_ended: trialing with the end behind us", () => {
    expect(state({ subscription_status: "trialing", trial_ends_at: days(-1) })).toEqual({ active: false, reason: "trial_ended", daysLeft: 0, compedBy: null });
    expect(state({ subscription_status: "trialing", trial_ends_at: new Date(NOW).toISOString() }).reason).toBe("trial_ended");
  });

  it("grace and grace_spent: past_due, unpaid and incomplete inside and past the window", () => {
    for (const status of ["past_due", "unpaid", "incomplete"]) {
      expect(state({ subscription_status: status, current_period_end: days(-2) })).toEqual({ active: true, reason: "grace", daysLeft: PAST_DUE_GRACE_DAYS - 2, compedBy: null });
      expect(state({ subscription_status: status, current_period_end: days(-(PAST_DUE_GRACE_DAYS + 1)) })).toEqual({ active: false, reason: "grace_spent", daysLeft: 0, compedBy: null });
    }
    // No period end recorded: the whole window, not a lockout.
    expect(state({ subscription_status: "past_due", current_period_end: null })).toEqual({ active: true, reason: "grace", daysLeft: PAST_DUE_GRACE_DAYS, compedBy: null });
  });

  it("canceled: a deliberate end, and any status the rule does not know", () => {
    expect(state({ subscription_status: "canceled" })).toEqual({ active: false, reason: "canceled", daysLeft: null, compedBy: null });
    expect(state({ subscription_status: "incomplete_expired" }).reason).toBe("canceled");
    expect(state({ subscription_status: "paused" }).reason).toBe("canceled");
  });

  it("unknown: no status at all", () => {
    expect(state({ subscription_status: null })).toEqual({ active: false, reason: "unknown", daysLeft: null, compedBy: null });
    expect(state({ subscription_status: "" }).reason).toBe("unknown");
    expect(state({}).reason).toBe("unknown");
  });

  it("the comp wins over every other branch, the column before the env list", () => {
    const comped = { comped_until: days(30) };
    for (const status of ["active", "trialing", "past_due", "canceled", null]) {
      expect(state({ ...comped, subscription_status: status }).reason).toBe("comped");
    }
    expect(state({ ...comped, id: "house" }).compedBy).toBe("column");
  });
});

describe("isCompedOrg: the env list (COMPED_ORG_IDS), the belt beside the column", () => {
  const before = process.env.COMPED_ORG_IDS;
  afterEach(() => {
    if (before === undefined) delete process.env.COMPED_ORG_IDS;
    else process.env.COMPED_ORG_IDS = before;
  });

  it("a listed id is comped, whatever its case or spacing; an unlisted or blank id is not", () => {
    process.env.COMPED_ORG_IDS = " 60195593-2E18-4230-BC8E-7A32D36D038D , b4854fcd-50de-46de-a0cb-dff642b4b97b ,, ";
    expect(isCompedOrg("60195593-2e18-4230-bc8e-7a32d36d038d")).toBe(true);
    expect(isCompedOrg("B4854FCD-50DE-46DE-A0CB-DFF642B4B97B")).toBe(true);
    expect(isCompedOrg("7d6da1e2-c9a0-47d8-bcc1-5b4c3e412fed")).toBe(false);
    expect(isCompedOrg("")).toBe(false);
    expect(isCompedOrg(null)).toBe(false);
    expect(isCompedOrg(undefined)).toBe(false);
  });

  it("an empty list comps nobody", () => {
    process.env.COMPED_ORG_IDS = "";
    expect(isCompedOrg("60195593-2e18-4230-bc8e-7a32d36d038d")).toBe(false);
    delete process.env.COMPED_ORG_IDS;
    expect(isCompedOrg("60195593-2e18-4230-bc8e-7a32d36d038d")).toBe(false);
  });

  it("accessState reads it when the row carries its id: active, comped, by env, no days", () => {
    process.env.COMPED_ORG_IDS = "house-org";
    const NOW = Date.parse("2026-10-28T17:00:00Z");
    expect(accessState({ id: "house-org", subscription_status: "canceled" }, { nowMs: NOW })).toEqual({ active: true, reason: "comped", daysLeft: null, compedBy: "env" });
    expect(accessState({ id: "other-org", subscription_status: "canceled" }, { nowMs: NOW }).reason).toBe("canceled");
    // The column still comes first when both hold.
    expect(accessState({ id: "house-org", comped_until: new Date(NOW + 86_400_000).toISOString() }, { nowMs: NOW }).compedBy).toBe("column");
    // A row with no id cannot be env-comped.
    expect(accessState({ subscription_status: "canceled" }, { nowMs: NOW }).reason).toBe("canceled");
  });
});

/**
 * THE COMPANY'S OWN CALENDAR. "Ends tomorrow" and "ends today" are calendar words in the company's
 * zone — never the UTC ceiling, which says "1 day" at 11 PM and flips at a UTC midnight nobody in
 * Truckee is awake for. Pinned across the fall-back weekend (2026-11-01, Pacific).
 */
describe("trialDaysLeftLocal: the company's own calendar across a DST day", () => {
  const PACIFIC = "America/Los_Angeles";
  // The trial ends Monday 2026-11-02 at 10:00 AM Pacific — standard time by then (UTC-8), so 18:00Z.
  const org = { subscription_status: "trialing", trial_ends_at: "2026-11-02T18:00:00Z" };

  it("Saturday 2026-10-31 3:00 PM PDT (22:00Z): 2 days — the calendar's answer, across the 25-hour Sunday", () => {
    const now = Date.parse("2026-10-31T22:00:00Z");
    expect(trialDaysLeftLocal(org, PACIFIC, now)).toBe(2);
    expect(accessState(org, { nowMs: now, tz: PACIFIC })).toEqual({ active: true, reason: "trial", daysLeft: 2, compedBy: null });
  });

  it("Monday 2026-11-02 8:00 AM PST (16:00Z): 0 — ends today, and the trial is still live", () => {
    const now = Date.parse("2026-11-02T16:00:00Z");
    expect(trialDaysLeftLocal(org, PACIFIC, now)).toBe(0);
    expect(accessState(org, { nowMs: now, tz: PACIFIC })).toEqual({ active: true, reason: "trial", daysLeft: 0, compedBy: null });
    // The UTC ceiling would have said 1 here (two hours left): the calendar says today.
    expect(trialDaysLeftAt(org, now)).toBe(1);
    expect(accessState(org, { nowMs: now }).daysLeft).toBe(1);
  });

  it("Tuesday 2026-11-03: 0, and accessState says trial_ended", () => {
    const now = Date.parse("2026-11-03T17:00:00Z"); // 9:00 AM PST
    expect(trialDaysLeftLocal(org, PACIFIC, now)).toBe(0);
    expect(accessState(org, { nowMs: now, tz: PACIFIC })).toEqual({ active: false, reason: "trial_ended", daysLeft: 0, compedBy: null });
  });

  it("Sunday 2026-11-01 (the fall-back day itself), any hour: 1 — ends tomorrow", () => {
    for (const utc of ["2026-11-01T08:00:00Z", "2026-11-01T09:30:00Z", "2026-11-01T20:00:00Z", "2026-11-02T07:59:00Z"]) {
      expect(trialDaysLeftLocal(org, PACIFIC, Date.parse(utc)), utc).toBe(1);
    }
    // Monday 12:30 AM PST (08:30Z): the UTC ceiling says 1 (9½ hours left); the calendar says today.
    expect(trialDaysLeftLocal(org, PACIFIC, Date.parse("2026-11-02T08:30:00Z"))).toBe(0);
    expect(trialDaysLeftAt(org, Date.parse("2026-11-02T08:30:00Z"))).toBe(1);
  });

  it("another company in another zone counts its own calendar", () => {
    // 2026-11-02 18:00Z is 1:00 PM in New York; Saturday 10-31 at 11:30 PM Eastern (11-01 03:30Z) is 2 days off.
    expect(trialDaysLeftLocal(org, "America/New_York", Date.parse("2026-11-01T03:30:00Z"))).toBe(2);
    // The same instant is Saturday 8:30 PM Pacific: also 2 days.
    expect(trialDaysLeftLocal(org, PACIFIC, Date.parse("2026-11-01T03:30:00Z"))).toBe(2);
  });

  it("no end date, or one nothing can parse: 0", () => {
    expect(trialDaysLeftLocal({ trial_ends_at: null }, PACIFIC, Date.now())).toBe(0);
    expect(trialDaysLeftLocal({ trial_ends_at: "garbage" }, PACIFIC, Date.now())).toBe(0);
  });
});
