import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { orgAccess } from "@/lib/org-access";
import { callerRole, nortPausedWords } from "@/lib/lapse-words";
import type { AccessState } from "@/lib/subscription";

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
  // THE 5.5 LINE (cn-v1128, the model move): list prices as published 2026-10. Haiku 5.5's price
  // is its ≤100k-input tier (a long statement scan can pass it and is then slightly underpriced).
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50 },
  // Earlier lines stay so the ledger's older rows keep pricing as they were billed.
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
/** Unknown model → price it as the most expensive we use, so a surprise never reads as free. */
const FALLBACK: Price = { input: 10, output: 50 };

export type TokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Server tools the call ran on Anthropic's side. Web search is billed per search, on top of
   *  the tokens its results add to the input. */
  server_tool_use?: { web_search_requests?: number | null } | null;
};

/** USD per web search (Anthropic bills $10 per 1,000 searches). */
export const WEB_SEARCH_USD = 0.01;

/** Dollar cost of one call. Cache classes are priced separately — collapsing them
 *  would misstate an agentic loop's cost by an order of magnitude.
 *
 *  WEB SEARCHES COUNT (vendor import, Phase 2). Every search is $0.01 whatever the model, and
 *  this used to price tokens only: Nort chat's research (up to 6 searches a message) and the
 *  public site-chat's ballparks went onto the ledger at their token cost alone, so the $150
 *  ceiling could be walked past a cent a search. Recorded spend for orgs that use research rises
 *  from here on; that is a gap closing, not new cost. */
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
  const searches = Math.max(0, Number(u.server_tool_use?.web_search_requests ?? 0) || 0);
  const dollars =
    (input / 1e6) * p.input +
    (read / 1e6) * p.input * 0.1 +
    (write / 1e6) * p.input * 1.25 +
    (output / 1e6) * p.output +
    searches * WEB_SEARCH_USD;
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
      return envOverride || "claude-opus-5-5";
    case "routine":
      return process.env.ANTHROPIC_MODEL_ROUTINE || "claude-sonnet-5-5";
    case "classify":
      return process.env.ANTHROPIC_MODEL_CHEAP || "claude-haiku-5-5";
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

/** The ceiling's words where a door has none of its own (the estimator's, since cn-v1128). */
export const AI_CEILING_WORDS = "Your company has hit its AI ceiling for the last 30 days. Message us and we'll lift it.";

export type AiGate = { ok: true } | { ok: false; why: string; reason: "lapsed" | "ceiling" };

/**
 * MAY THIS COMPANY SPEND A CENT ON A MODEL? ONE RULE (cn-v1137, decision 3). Every AI door — the
 * estimator, Nort's chat, the paper readers, the vendor lookups, the site designer, the setup
 * interview — asks this before the model, in this order:
 *
 *   1. THE COMPANY'S STANDING (orgAccess): a plan that has ended — trial expired, grace spent,
 *      canceled — gets no AI at all. The words are refusalWords in the asker's role: the owner is
 *      told the door (Settings › Getting Paid), everyone else who holds the key. A role the caller
 *      did not pass is read here, only on this path (lapse-words callerRole).
 *   2. THE MONTHLY CEILING (aiSpendExceeded): the abuse stop, as before.
 *
 * `opts.state`: a caller that already read the company's standing (Nort's chat route reads the
 * billing columns with the org) hands it over, so the read is never made twice. `opts.lapsedWords`
 * / `opts.ceilingWords`: a door's own sentence where the generic one would mislead — the public
 * site chat speaks to a stranger, the panel reader names Add A Circuit. The answer is one shape
 * for every door: ok, or `why` in words with the reason; the door returns `why` in its own
 * envelope (an action's error field, a route's JSON, a chat turn). Fails OPEN the way both halves
 * do: a failed read never locks a contractor out mid-job.
 */
export async function aiAllowed(
  orgId: string | null | undefined,
  role?: string | null,
  opts: { ceilingWords?: string; lapsedWords?: string; state?: AccessState } = {},
): Promise<AiGate> {
  const state = opts.state ?? (await orgAccess(orgId)).state;
  if (!state.active) {
    const why = opts.lapsedWords ?? (await nortPausedWords(state, role === undefined ? await callerRole() : role, orgId));
    return { ok: false, reason: "lapsed", why };
  }
  if (await aiSpendExceeded(orgId)) return { ok: false, reason: "ceiling", why: opts.ceilingWords ?? AI_CEILING_WORDS };
  return { ok: true };
}

/**
 * THE ESTIMATE ALLOWANCE'S COUNT (cn-v1128). Full estimates run this calendar month (UTC), read from
 * the ledger as the 'estimator:run' ticks noteEstimateRun leaves — one per run of the estimator's
 * gate, never per model round (a plan take-off is up to three rounds and still one estimate).
 * Fails OPEN to 0: a metering outage must never make an estimate simpler.
 */
export async function fullEstimatesThisMonth(orgId: string | null | undefined): Promise<number> {
  if (!orgId) return 0;
  try {
    const sb = createServiceClient();
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const { data, error } = await sb
      .from("ai_usage")
      .select("calls")
      .eq("org_id", orgId)
      .eq("surface", "estimator:run")
      .gte("usage_date", monthStart);
    if (error || !data) return 0;
    return (data as { calls?: number | null }[]).reduce((n: number, r) => n + Number(r.calls ?? 0), 0);
  } catch {
    return 0;
  }
}

/** One tick on the ledger per estimator run: zero tokens, zero dollars, calls + 1. Best-effort. */
export async function noteEstimateRun(orgId: string | null | undefined): Promise<void> {
  if (!orgId) return;
  try {
    const sb = createServiceClient();
    const { error } = await sb.rpc("record_ai_usage", {
      p_org_id: orgId,
      p_model: "none",
      p_surface: "estimator:run",
      p_input: 0,
      p_cache_read: 0,
      p_cache_write: 0,
      p_output: 0,
      p_cost_usd: 0,
    });
    // NOTHING SILENT: a refused tick means the cap never bites — said in the sink, not swallowed.
    if (error) reportError("noteEstimateRun", error, { orgId });
  } catch (e) {
    reportError("noteEstimateRun", e, { orgId });
  }
}

/** The org's plan as stored (trial, handyman, crew, company); null on any failure. */
export async function orgPlanTier(orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null;
  try {
    const sb = createServiceClient();
    const { data } = await sb.from("organizations").select("plan").eq("id", orgId).maybeSingle();
    return (data as { plan?: string | null } | null)?.plan ?? null;
  } catch {
    return null;
  }
}
