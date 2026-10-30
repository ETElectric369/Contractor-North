/**
 * THE PLAN LADDER — one place that knows what tiers exist, what they cost, and WHY they differ.
 *
 * ── THE PRINCIPLE ────────────────────────────────────────────────────────────────────────────
 *
 *   GATE ON COST, NEVER ON LEVERAGE.
 *
 * Two kinds of thing can sit behind a higher price, and only one of them is honest.
 *
 *   - Things that cost us NOTHING per use — another person on the crew, more jobs, more invoices,
 *     more customers, storage, any feature at all. Charging for these is pure leverage: the price
 *     goes up because you're locked in, not because serving you got more expensive. That is the
 *     extraction pattern this product exists as an alternative to, and it is the single
 *     most-documented churn driver in the category. So: **included at every tier, permanently.**
 *   - Things that cost REAL money every time they run — a model call: Nort's answer, a researched
 *     estimate, a plan read, a receipt read. Those have a per-use bill attached, and pretending
 *     otherwise means either eating a loss on heavy users or quietly rationing them. **This is
 *     what the tiers meter, and we say so — as ONE meter called Usage.**
 *
 * The test suite enforces the first half: no tier may describe itself by what it withholds.
 *
 * ── ONE METER, LIKE THE CLAUDE USAGE WINDOW (cn-v1140) ──────────────────────────────────────
 *
 * Erik, 2026-10-30: "stick to KISS — look at how Anthropic pulls tokens; adding estimates doesn't
 * make sense; usage is understandable to anyone; I don't want to have to explain all that to
 * people." So the tiers no longer count estimates (cn-v1128's 40 / 120 / unlimited went with this
 * wave). What a tier includes is a monthly USAGE BUDGET — internal dollars of model spend, the
 * ledger's own unit (ai_usage.cost_usd), which the ring shows as a PERCENT and never as a figure —
 * and the pricing words say it as a multiple: Handyman is the unit, Crew 3×, Company 8×. A trial
 * runs on Handyman's budget, a comped company on Company's (lib/usage-meter). Extra usage can be
 * bought for the month (0401 usage_topups) and raises the cap.
 *
 * ── TWO THINGS THIS DELIBERATELY DOES NOT DO ────────────────────────────────────────────────
 *
 * 1. NO HEADCOUNT BANDING. An earlier version of this file described the tiers as "Solo or just
 *    you and a helper" / "2–10 people" / "a real company with an office" — three lines above a
 *    promise never to charge per seat. That is a seat tax wearing a different hat: it tells a
 *    four-person crew they're on the wrong plan for a reason that costs us nothing. Tiers are
 *    described by WORKLOAD — how much heavy lifting you do — which is the thing that actually
 *    drives our cost.
 *
 * 2. NO WAGE METAPHOR. It also said "Nort part-time" / "Nort works mornings" / "Nort full-time".
 *    That sells a unit we cannot honour: nobody can check whether an assistant "worked a morning",
 *    and the moment a customer tries, the claim falls apart. The unit here is one everyone already
 *    understands from every other subscription: a usage meter with a percent in it.
 *
 * ── NEVER CUT OFF OPERATIONS ────────────────────────────────────────────────────────────────
 *
 * Running out of usage does NOT lock the app, stop the crew, or disable a feature. Nort and the
 * estimator drop to the lighter model and say so plainly, until the month turns or usage is
 * added. It gets simpler; it never disappears. Same shape as the past-due grace window in
 * subscription.ts — a billing state must never become a work stoppage.
 *
 * ── THE PRICE ID IS AUTHORITATIVE, NOT THE NICKNAME ─────────────────────────────────────────
 *
 * The webhook used to read `price.nickname`, which is free text an operator can edit in the Stripe
 * dashboard — rename it and every org's plan silently changes. Price ids are immutable, so a plan
 * is resolved by id and stored by id. That also gives grandfathering for free: repricing means
 * creating a NEW price, and existing orgs keep the id they signed up on until they're explicitly
 * moved.
 */

export type PlanTier = "handyman" | "crew" | "company";

export type PlanDef = {
  tier: PlanTier;
  name: string;
  /** Dollars per month (annual shown as its monthly equivalent). */
  monthly: number;
  annual: number;
  /** Who this fits, described by WORKLOAD — never by headcount. */
  blurb: string;
  /**
   * AXIS 1 — USAGE. The month's model-spend budget in internal dollars (the ledger's unit,
   * ai_usage.cost_usd). NEVER shown to a customer as a figure: the ring shows the percent of it
   * used, the pricing words say the multiple of Handyman's (the `included` line). Set near the real
   * economics: a $59 plan has room for about $10 of model spend and a healthy margin; the budgets
   * rise faster than the prices so the bigger plans are the better deal on usage.
   */
  usageUsdPerMonth: number;
  /**
   * AXIS 2 — OUR TIME. Support and setup are real cost that scales with a customer's size and has
   * NOTHING to do with leverage: a twenty-person company genuinely needs more of us than a solo
   * operator does. This is the honest reason a bigger business pays more, in a way that charging
   * for their fourth employee never is.
   */
  support: string;
  /** How the usage reads on the pricing page: a plain line, never a number with a unit to explain. */
  included: string;
};

export const PLANS: PlanDef[] = [
  {
    tier: "handyman",
    name: "Handyman",
    monthly: 59,
    annual: 47,
    blurb: "You quote a few jobs a month and want the paperwork to stop eating your evenings.",
    usageUsdPerMonth: 10,
    included: "Plenty of usage for a few jobs a month — Nort, the estimator and plan reading included. Everything else, unlimited.",
    support: "Help by email, and the app set up to run itself.",
  },
  {
    tier: "crew",
    name: "Crew",
    monthly: 129,
    annual: 103,
    blurb: "You're quoting constantly and the office work has turned into a second job.",
    usageUsdPerMonth: 30,
    included: "3× the usage of Handyman, so bidding is a daily habit rather than a budget. Everything else, unlimited.",
    support: "We set it up with you — your price book imported, your inspection sheet written — and answer the same day.",
  },
  {
    tier: "company",
    name: "Company",
    monthly: 299,
    annual: 239,
    blurb: "Estimating and paperwork are somebody's whole job — or should be.",
    usageUsdPerMonth: 80,
    included: "8× the usage of Handyman. Everything else, unlimited.",
    support: "Someone who knows your business: templates built for your trade, and a review of the numbers every quarter.",
  },
];

/**
 * WHAT EVERY TIER SHIPS, at every price, forever. Kept as data rather than prose so the pricing
 * page and the tests read the same list — and so adding a feature here is the default, while
 * moving one into a tier would be a visible, deliberate edit.
 */
export const INCLUDED_EVERYWHERE: readonly string[] = [
  "Your whole crew — we never charge per person",
  "Every job, customer, quote, invoice and photo",
  "The assistant, all day, for the everyday work",
  "Your public website and lead capture",
  "Taking card payments from your customers",
  "Time tracking, scheduling and payroll export",
];

export function planByTier(tier: string | null | undefined): PlanDef | null {
  return PLANS.find((p) => p.tier === tier) ?? null;
}

/**
 * The Stripe price id for a tier + cadence, from env. Kept OUT of the code so test and live prices
 * differ without a deploy, and so repricing is a config change.
 *   STRIPE_PRICE_HANDYMAN_MONTHLY / _ANNUAL, STRIPE_PRICE_CREW_…, STRIPE_PRICE_COMPANY_…
 */
export function priceIdFor(tier: PlanTier, cadence: "monthly" | "annual"): string | null {
  const key = `STRIPE_PRICE_${tier.toUpperCase()}_${cadence.toUpperCase()}`;
  return process.env[key] || null;
}

/** Reverse lookup: which tier does this Stripe price id belong to? Used by the webhook so a plan
 *  is derived from an immutable id rather than an editable nickname. */
export function tierForPriceId(priceId: string | null | undefined): PlanTier | null {
  if (!priceId) return null;
  for (const p of PLANS) {
    for (const cadence of ["monthly", "annual"] as const) {
      if (priceIdFor(p.tier, cadence) === priceId) return p.tier;
    }
  }
  return null;
}

/** True once at least one tier is configured — otherwise the picker has nothing to show. */
export function plansConfigured(): boolean {
  return PLANS.some((p) => priceIdFor(p.tier, "monthly") || priceIdFor(p.tier, "annual"));
}
