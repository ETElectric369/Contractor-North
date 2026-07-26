/**
 * THE PLAN LADDER (0.8) — one place that knows what tiers exist and what they cost.
 *
 * Two rules learned from the competitive research, both encoded here rather than in
 * a comment somewhere:
 *
 *  1. EVERY TIER SHIPS THE WHOLE PRODUCT. The tiers differ by how much AUTONOMOUS
 *     work Nort does in the background — never by withholding features, and never by
 *     charging per person. Add your whole crew; one price. Feature-gating and seat
 *     taxes are the two most-documented churn drivers in this category.
 *
 *  2. THE PRICE ID IS AUTHORITATIVE, NOT THE NICKNAME. The webhook used to read
 *     `price.nickname`, which is a free-text field an operator can edit in the Stripe
 *     dashboard — rename it and every org's plan silently changes. Price ids are
 *     immutable, so a plan is resolved by id and stored by id. That also gives
 *     grandfathering for free: repricing means creating a NEW price, and existing
 *     orgs keep the id they signed up on until they're explicitly moved.
 */

export type PlanTier = "handyman" | "crew" | "company";

export type PlanDef = {
  tier: PlanTier;
  name: string;
  /** Dollars per month (annual shown as its monthly equivalent). */
  monthly: number;
  annual: number;
  blurb: string;
  /** What Nort does unprompted at this tier — the ONLY axis that changes. */
  autonomy: string;
};

export const PLANS: PlanDef[] = [
  {
    tier: "handyman",
    name: "Handyman",
    monthly: 59,
    annual: 47,
    blurb: "Solo or just you and a helper.",
    autonomy: "Nort part-time — ask him anything, and he keeps the books tidy in the background.",
  },
  {
    tier: "crew",
    name: "Crew",
    monthly: 129,
    annual: 103,
    blurb: "A working crew, 2–10 people.",
    autonomy: "Nort works mornings — chases overdue invoices, files receipts, writes your site content.",
  },
  {
    tier: "company",
    name: "Company",
    monthly: 299,
    annual: 239,
    blurb: "A real company with an office.",
    autonomy: "Nort full-time — an office manager for $299, not $3,500.",
  },
];

export function planByTier(tier: string | null | undefined): PlanDef | null {
  return PLANS.find((p) => p.tier === tier) ?? null;
}

/**
 * The Stripe price id for a tier + cadence, from env. Kept OUT of the code so test
 * and live prices differ without a deploy, and so repricing is a config change.
 *   STRIPE_PRICE_HANDYMAN_MONTHLY / _ANNUAL, STRIPE_PRICE_CREW_…, STRIPE_PRICE_COMPANY_…
 */
export function priceIdFor(tier: PlanTier, cadence: "monthly" | "annual"): string | null {
  const key = `STRIPE_PRICE_${tier.toUpperCase()}_${cadence.toUpperCase()}`;
  return process.env[key] || null;
}

/** Reverse lookup: which tier does this Stripe price id belong to? Used by the webhook
 *  so a plan is derived from an immutable id rather than an editable nickname. */
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
