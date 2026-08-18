import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";

/**
 * THE AI COST LAYER — what a call costs, which model to use, and whether this org
 * has spent too much (0162).
 *
 * The pricing promise is "AI included, never metered." The customer never sees a
 * meter; we absolutely need one. Two jobs live here:
 *
 *   1. RECORD what every Anthropic call cost, per org, so "is this customer
 *      profitable?" has an answer before we ever charge anyone.
 *   2. ROUTE cheap work to a cheap model. Measured against the real configuration,
 *      a moderate user on an Opus-class model leaves ~6% margin on a $59 plan and a
 *      heavy one is a straight loss; the same user on routed models is ~81%. Routing
 *      is not an optimization here, it is what makes an affordable tier honest.
 */

/** USD per MILLION tokens. Cache reads are ~10% of input; cache writes ~125%. */
type Price = { input: number; output: number };
const PRICES: Record<string, Price> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
/** Unknown model → price it as the most expensive we use, so a surprise never reads as free. */
const FALLBACK: Price = { input: 10, output: 50 };

export type TokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** Dollar cost of one call. Cache classes are priced separately — collapsing them
 *  would misstate an agentic loop's cost by an order of magnitude. */
export function costOf(model: string, u: TokenUsage): number {
  // Strip a trailing date snapshot before the lookup (audit 8): "claude-haiku-4-5-20251001" is
  // the same model as "claude-haiku-4-5", but the exact-key miss fell through to FALLBACK and
  // metered the public site-chat at ~10x — the org's AI ceiling tripped at a tenth of real
  // spend and the lead-capture assistant went dark.
  const p = PRICES[model.replace(/-\d{8}$/, "")] ?? FALLBACK;
  const input = Number(u.input_tokens ?? 0);
  const read = Number(u.cache_read_input_tokens ?? 0);
  const write = Number(u.cache_creation_input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  const dollars =
    (input / 1e6) * p.input +
    (read / 1e6) * p.input * 0.1 +
    (write / 1e6) * p.input * 1.25 +
    (output / 1e6) * p.output;
  return Math.round(dollars * 1e6) / 1e6;
}

/**
 * WHICH MODEL for a piece of work.
 *
 * "reasoning" is the product's actual magic — estimating, material takeoff, reading a
 * receipt — and downgrading it would be a false economy: a wrong estimate costs a
 * contractor far more than the tokens saved. Everything else (looking up a schedule,
 * classifying an intent, summarizing a tool result) does not need a frontier model.
 */
export type WorkKind = "reasoning" | "routine" | "classify";

export function modelFor(kind: WorkKind): string {
  const envOverride = process.env.ANTHROPIC_MODEL;
  switch (kind) {
    case "reasoning":
      // Honor the existing override so a deploy can pin the flagship model.
      return envOverride || "claude-opus-4-8";
    case "routine":
      return process.env.ANTHROPIC_MODEL_ROUTINE || "claude-sonnet-5";
    case "classify":
      return process.env.ANTHROPIC_MODEL_CHEAP || "claude-haiku-4-5";
  }
}

/**
 * Record one call against an org's ledger. Best-effort and never throws: a metering
 * failure must not break a contractor's estimate. Missing org → skipped rather than
 * recorded against nobody.
 */
export async function recordAiUsage(args: {
  orgId: string | null | undefined;
  model: string;
  surface: string;
  usage: TokenUsage | null | undefined;
}): Promise<void> {
  const { orgId, model, surface, usage } = args;
  if (!orgId || !usage) return;
  try {
    const sb = createServiceClient();
    await sb.rpc("record_ai_usage", {
      p_org_id: orgId,
      p_model: model,
      p_surface: surface,
      p_input: Math.max(0, Number(usage.input_tokens ?? 0)),
      p_cache_read: Math.max(0, Number(usage.cache_read_input_tokens ?? 0)),
      p_cache_write: Math.max(0, Number(usage.cache_creation_input_tokens ?? 0)),
      p_output: Math.max(0, Number(usage.output_tokens ?? 0)),
      p_cost_usd: costOf(model, usage),
    });
  } catch (e) {
    reportError("recordAiUsage", e, { orgId, model, surface });
  }
}

/** The caller's org id, for metering a call from a server action that doesn't already
 *  have one to hand. Returns null rather than throwing — an unattributable call should
 *  go unrecorded, never break the feature it was measuring. */
export async function currentOrgId(): Promise<string | null> {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
    return (data as { org_id?: string } | null)?.org_id ?? null;
  } catch {
    return null;
  }
}

/** Monthly ceiling per org, in dollars. Generous by design — this is an abuse stop,
 *  not a usage tier. A normal heavy user should never come near it. */
export const MONTHLY_AI_CEILING_USD = Number(process.env.AI_MONTHLY_CEILING_USD || 150);

/**
 * Has this org blown through the ceiling? Fails OPEN on any error: a metering outage
 * must never lock a contractor out of their own assistant mid-job. The ceiling exists
 * to stop runaway abuse, and abuse is visible in the ledger afterwards either way.
 */
export async function aiSpendExceeded(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  try {
    const sb = createServiceClient();
    const { data, error } = await sb.rpc("ai_spend_since", { p_org_id: orgId, p_days: 30 });
    if (error) return false;
    return Number(data ?? 0) >= MONTHLY_AI_CEILING_USD;
  } catch {
    return false;
  }
}
