import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { PLANS, planByTier, type PlanTier } from "@/lib/plans";
import { accessState, BILLING_COLUMNS, type AccessState, type BillingOrg } from "@/lib/subscription";
import { firstOfMonth, todayIn, usageWindow, type UsageWindow } from "@/lib/usage-window";

/**
 * THE ONE READ OF A COMPANY'S USAGE (cn-v1140). Every surface that shows or asks about usage — the
 * ring on the plan card, the estimator's and Nort's model pick (lib/ai-cost tierOfUsage on this
 * read), the daily notice step — comes through here and nowhere else, so the percent on the card
 * and the model a call runs on can never disagree.
 *
 * WHAT IT READS, on the service client (the ledger and the top-ups are North's tables, deny-all to
 * tenants): the company's plan and standing (unless the caller already has the row — Nort's chat
 * route reads it with the settings, one trip), the budget by the standing's reason (a trial runs on
 * Handyman's, a comped company on Company's, a plan on its own tier's; no plan and no standing →
 * Handyman's: the smallest honest meter, never none), this month's spend through ai_spend_from
 * (0401) from the 1st of the company's own month, and what was bought for the month through
 * usage_topup_total. Then lib/usage-window does the math.
 *
 * THE FEW-HOUR EDGE, said plainly: ai_usage.usage_date is the UTC date of each call (0162), and
 * the month is the company's own calendar month, so the 1st of its month is passed as a plain
 * YYYY-MM-DD and read as a UTC date. So the NEW month inherits the OLD month's last evening: a
 * call at 5 PM Pacific on Oct 31 is already Nov 1 in UTC and is summed into November, not October
 * — about 7–8 hours a month for a Pacific company (the clock's offset), the same way for any zone
 * west of UTC. The old month ends a little early and the new one starts a little full; never
 * corrected by hand, because a meter nobody has to explain is the point.
 *
 * FAILS OPEN, ALWAYS: a failed read (the company, the ledger, the top-ups) answers a "fine" window
 * at 0% with `degraded: true`, filed in the sink — never a throw, never a lock-out, never the
 * lighter model because a meter could not be read. The ring may show 0% for a minute; the company
 * never loses its full model to an outage of ours.
 */
export type UsageOrg = BillingOrg & {
  plan?: string | null;
  settings?: unknown;
};

export type UsageMeter = UsageWindow & {
  /** The plan's monthly budget, internal dollars (never shown). */
  budgetUsd: number;
  /** This month's model spend, internal dollars (never shown). */
  spentUsd: number;
  /** Extra usage bought for this month, internal dollars (never shown). */
  topupUsd: number;
  /** The tier the budget came from. */
  tier: PlanTier;
  planName: string;
  /** The company's timezone the window was dated in. */
  timezone: string;
  /** Today on the company's calendar, YYYY-MM-DD. */
  today: string;
  /** True when a read failed and this is the open answer (fine, 0%), not the meter. */
  degraded: boolean;
};

/** The columns usageFor reads when it reads the company itself. */
export const USAGE_ORG_COLUMNS = `id, plan, settings, ${BILLING_COLUMNS.join(", ")}`;

/**
 * Whose budget applies: a trial runs on Handyman's line, a comped company on Company's, a real
 * plan on its own tier's, and anything else (no plan, unknown standing) on Handyman's.
 */
export function usageTierFor(state: Pick<AccessState, "reason">, plan: string | null | undefined): PlanTier {
  if (state.reason === "trial") return "handyman";
  if (state.reason === "comped") return "company";
  return planByTier(plan)?.tier ?? "handyman";
}

type MeterClient = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

/** The open answer: fine, nothing spent, dated on the calendar given, flagged. */
function openMeter(tier: PlanTier, timezone: string, nowMs: number, trialEndsAt?: string | null): UsageMeter {
  const plan = planByTier(tier) ?? PLANS[0];
  const today = todayIn(timezone, new Date(nowMs));
  const window = usageWindow({ spentUsd: 0, budgetUsd: plan.usageUsdPerMonth, topupUsd: 0, today, timezone, trialEndsAt });
  return { ...window, budgetUsd: plan.usageUsdPerMonth, spentUsd: 0, topupUsd: 0, tier: plan.tier, planName: plan.name, timezone, today, degraded: true };
}

/**
 * The company's usage this month. `org` is the row when the caller already read it (plan, settings
 * and the billing columns); otherwise it is read here. `client` is for tests.
 */
export async function usageFor(
  orgId: string | null | undefined,
  org?: UsageOrg | null,
  opts: { nowMs?: number; client?: MeterClient } = {},
): Promise<UsageMeter> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!orgId) return openMeter("handyman", "UTC", nowMs);
  let sb: MeterClient;
  try {
    sb = opts.client ?? (createServiceClient() as unknown as MeterClient);
  } catch (e) {
    reportError("usage-meter:client", e, { orgId });
    return openMeter("handyman", "UTC", nowMs);
  }
  let row: UsageOrg | null = org ?? null;
  if (!row) {
    try {
      const { data, error } = await sb.from("organizations").select(USAGE_ORG_COLUMNS).eq("id", orgId).maybeSingle();
      if (error) throw error;
      row = (data as UsageOrg | null) ?? null;
    } catch (e) {
      reportError("usage-meter:org", e, { orgId });
      return openMeter("handyman", "UTC", nowMs);
    }
  }
  if (!row) return openMeter("handyman", "UTC", nowMs);
  const timezone = getOrgSettings(row.settings).timezone;
  const state = accessState({ ...row, id: row.id ?? orgId }, { nowMs, tz: timezone });
  const tier = usageTierFor(state, row.plan);
  const plan = planByTier(tier) ?? PLANS[0];
  const today = todayIn(timezone, new Date(nowMs));
  const monthKey = today.slice(0, 7);
  try {
    const [spend, topup] = await Promise.all([
      sb.rpc("ai_spend_from", { p_org_id: orgId, p_from: firstOfMonth(monthKey) }),
      sb.rpc("usage_topup_total", { p_org: orgId, p_month: monthKey }),
    ]);
    if (spend.error) throw spend.error;
    if (topup.error) throw topup.error;
    const spentUsd = Number(spend.data ?? 0) || 0;
    const topupUsd = Number(topup.data ?? 0) || 0;
    const window = usageWindow({ spentUsd, budgetUsd: plan.usageUsdPerMonth, topupUsd, today, timezone, trialEndsAt: state.reason === "trial" ? row.trial_ends_at : null });
    return { ...window, budgetUsd: plan.usageUsdPerMonth, spentUsd, topupUsd, tier: plan.tier, planName: plan.name, timezone, today, degraded: false };
  } catch (e) {
    reportError("usage-meter:read", e, { orgId, monthKey });
    return openMeter(tier, timezone, nowMs, state.reason === "trial" ? row.trial_ends_at : null);
  }
}

