import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { orgAccess } from "@/lib/org-access";
import { callerRole, nortPausedWords } from "@/lib/lapse-words";
import type { UsageMeter } from "@/lib/usage-meter";
import type { AccessState } from "@/lib/subscription";

/**
 * THE AI COST LAYER — what a call costs, which model to use, and whether this org
 * has spent too much (0162).
 *
 * The pricing promise is "AI included, never cut off." The owner sees ONE meter — the Usage
 * ring in Settings › Getting Paid (cn-v1140, lib/usage-meter: a percent and a reset day, never
 * a dollar) — and past 100% nothing stops: the month runs lighter. Two jobs live here:
 *
 *   1. RECORD what every Anthropic call cost, per org, so "is this customer
 *      profitable?" has an answer before we ever charge anyone.
 *   2. ROUTE cheap work to a cheap model. Measured against the real configuration,
 *      a moderate user on an Opus-class model leaves ~6% margin on a $59 plan and a
 *      heavy one is a straight loss; the same user on routed models is ~81%. Routing
 *      is not an optimization here, it is what makes an affordable tier honest.
 */

/** USD per MILLION tokens, one rate per token class (G3, cn-v1142). The ledger prices what it
 *  pays: a cache read and a cache write are NOT flat multiples of input on every model — Opus 5.5
 *  reads at 0.05x and Fable 5.1 at 0.025x — and a 1-hour write costs 2x input where a 5-minute one
 *  costs 1.25x. Every rate below is the published one; where the docs publish only the general
 *  multiplier (reads ~0.1x, writes 1.25x / 2x) the row applies it. */
type Rates = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
/** A model whose price steps up past a prompt size: above `overPromptTokens` (input + cache read +
 *  cache write) the whole call is priced at `rates`. */
type Price = Rates & { longContext?: { overPromptTokens: number; rates: Rates } };
/** The general cache multipliers, for a row whose docs publish no model-specific rate. */
const READ_X = 0.1;
const WRITE_5M_X = 1.25;
const WRITE_1H_X = 2;
function rates(input: number, output: number, cacheRead: number = input * READ_X): Rates {
  return { input, output, cacheRead, cacheWrite5m: input * WRITE_5M_X, cacheWrite1h: input * WRITE_1H_X };
}
const PRICES: Record<string, Price> = {
  // THE 5.5 LINE (cn-v1128, the model move): list prices as published 2026-10.
  "claude-opus-5-5": rates(4, 20, 0.2),
  "claude-sonnet-5-5": rates(2, 10, 0.2),
  // Haiku 5.5's list price steps up past a 100K-token prompt; a long statement scan is priced there.
  "claude-haiku-5-5": { ...rates(0.1, 0.5), longContext: { overPromptTokens: 100_000, rates: rates(0.5, 2.5) } },
  "claude-fable-5-1": rates(10, 50, 0.25),
  // Earlier lines stay so the ledger's older rows keep pricing as they were billed.
  "claude-opus-4-8": rates(5, 25),
  // A documented server-side fallback target (shared/model-migration.md:1398, "the supported fallback
  // targets are claude-opus-4-8 and claude-opus-5"): $5 / $25 per MTok, "a drop-in upgrade at Opus
  // 4.8's pricing" (shared/models.md:80; no model-specific cache rate published, so the general one).
  "claude-opus-5": rates(5, 25),
  "claude-fable-5": rates(10, 50, 1),
  "claude-sonnet-5": rates(2, 10),
  "claude-haiku-4-5": rates(1, 5),
};
/** Unknown model → price it as the most expensive we use, so a surprise never reads as free. */
const FALLBACK: Price = rates(10, 50);

export type TokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** The write split by TTL (the SDK's Usage.cache_creation). When present it is the truth; when
   *  absent every write is priced at the 5-minute rate. */
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  /** Server tools the call ran on Anthropic's side. Web search is billed per search, on top of
   *  the tokens its results add to the input. */
  server_tool_use?: { web_search_requests?: number | null } | null;
  /** Per-attempt usage (beta Usage.iterations: message / fallback_message / compaction / advisor
   *  entries, each naming its model). Present, it is the billing truth: see billedParts. */
  iterations?: readonly IterationUsage[] | null;
};

export type IterationUsage = {
  type?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: TokenUsage["cache_creation"];
};

/** The refusal categories billed when the decline came BEFORE any output (refusals-and-fallback,
 *  "How refusals are billed": bio, frontier_llm, reasoning_extraction; any other or null is not). */
const BILLED_PRE_OUTPUT = new Set(["bio", "frontier_llm", "reasoning_extraction"]);

/** The categories a response's `fallback` blocks record (trigger.category), in order: what each
 *  declined hop was declined for. Anything that is not a fallback block is skipped. */
export function declineCategories(content: unknown): (string | null)[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "fallback")
    .map((b) => {
      const c = (b as { trigger?: { category?: unknown } | null }).trigger?.category;
      return typeof c === "string" ? c : null;
    });
}

/**
 * WHAT ONE CALL WAS BILLED FOR, attempt by attempt (cn-v1142 skeptic, finding 11). Top-level usage
 * "covers only the attempt that produced the returned message"; "usage.iterations is the per-attempt
 * source of truth" (shared/model-migration.md:1429). So when iterations are present each entry is
 * its own part at its OWN model's rate ("fallback attempts bill at the fallback model's rates",
 * ibid.), compaction entries included (they are not in the top-level fields, messages.d.ts
 * BetaIterationsUsage; "sum the iterations", shared/cost-optimization.md:67). A declined attempt that
 * produced output (mid-stream) "bills at normal rates" (model-migration.md:1429); one declined BEFORE
 * any output (a zero-output `message` entry in a fallback-served turn) is billed only when its
 * category is bio, frontier_llm or reasoning_extraction ("How refusals are billed"), so it counts
 * only when a caller passes the response's fallback categories and one of them is billed. No
 * iterations: the top-level usage is the one part, as before.
 */
export function billedParts(model: string, u: TokenUsage, categories: readonly (string | null)[] = []): { model: string; usage: TokenUsage }[] {
  const its = Array.isArray(u.iterations) ? u.iterations : [];
  if (!its.length) return [{ model, usage: u }];
  const fellBack = its.some((e) => e?.type === "fallback_message");
  const preOutputBilled = categories.some((c) => c != null && BILLED_PRE_OUTPUT.has(c));
  return its
    .filter((e) => {
      if (!e) return false;
      const declinedBeforeOutput = fellBack && e.type === "message" && !(Number(e.output_tokens ?? 0) > 0);
      return !declinedBeforeOutput || preOutputBilled;
    })
    .map((e) => ({ model: e.model || model, usage: e as TokenUsage }));
}

/** The token totals of what was billed (the ledger's four columns), summed over billedParts. */
export function billedTokens(model: string, u: TokenUsage, categories: readonly (string | null)[] = []) {
  const n = (v: number | null | undefined) => Math.max(0, Number(v ?? 0) || 0);
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const { usage } of billedParts(model, u, categories)) {
    t.input += n(usage.input_tokens);
    t.cacheRead += n(usage.cache_read_input_tokens);
    t.cacheWrite += n(usage.cache_creation_input_tokens);
    t.output += n(usage.output_tokens);
  }
  return t;
}

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
export function costOf(model: string, u: TokenUsage, categories: readonly (string | null)[] = []): number {
  const parts = billedParts(model, u, categories);
  // One part (no iterations): the call itself. Several: each attempt at its own model's rate, and the
  // call's web searches once (they ride the top-level server_tool_use, never an iteration).
  if (parts.length === 1 && parts[0].usage === u) return costOfOne(model, u);
  const searches = Math.max(0, Number(u.server_tool_use?.web_search_requests ?? 0) || 0);
  const dollars = parts.reduce((sum, p) => sum + costOfOne(p.model, { ...p.usage, server_tool_use: null }), 0) + searches * WEB_SEARCH_USD;
  return Math.round(dollars * 1e6) / 1e6;
}

function costOfOne(model: string, u: TokenUsage): number {
  // Strip a trailing date snapshot before the lookup (audit 8): "claude-haiku-4-5-20251001" is
  // the same model as "claude-haiku-4-5", but the exact-key miss fell through to FALLBACK and
  // metered the public site-chat at ~10x — the org's AI ceiling tripped at a tenth of real
  // spend and the lead-capture assistant went dark.
  const row = PRICES[model.replace(/-\d{8}$/, "")] ?? FALLBACK;
  const n = (v: number | null | undefined) => Math.max(0, Number(v ?? 0) || 0);
  const input = n(u.input_tokens);
  const read = n(u.cache_read_input_tokens);
  const output = n(u.output_tokens);
  // The TTL breakdown first; without it the flat total is all 5-minute writes (the cheaper TTL,
  // and the only one this app asks for unless a call says ttl: "1h").
  const split = u.cache_creation;
  const has = split != null && (split.ephemeral_5m_input_tokens != null || split.ephemeral_1h_input_tokens != null);
  const write5m = has ? n(split!.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens);
  const write1h = has ? n(split!.ephemeral_1h_input_tokens) : 0;
  const searches = n(u.server_tool_use?.web_search_requests);
  const lc = row.longContext;
  const p: Rates = lc && input + read + write5m + write1h > lc.overPromptTokens ? lc.rates : row;
  const dollars =
    (input / 1e6) * p.input +
    (read / 1e6) * p.cacheRead +
    (write5m / 1e6) * p.cacheWrite5m +
    (write1h / 1e6) * p.cacheWrite1h +
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
 * SERVER-SIDE FALLBACKS (cn-v1142, the SDK half). The 5.5 line runs safety classifiers that can
 * DECLINE a request (an HTTP 200 with stop_reason "refusal" — benign trade work trips them now
 * and then). With one beta header plus `fallbacks: "default"` on the request, the API re-runs a
 * declined request on the model Anthropic recommends for that category, in the same round trip,
 * instead of handing the refusal back. The answer then says which model ran (`response.model`)
 * and carries a `fallback` block at the point it switched; the ledger already meters by the
 * model the response reports, so a stood-in call bills as the model that ran. A refusal that
 * comes back anyway means the whole chain declined: ai-refusal's `refused` is still the check.
 *
 * The BIG and the MIDDLE model carry it. The SMALL model carries NOTHING — not the header either:
 * the docs say there is no server-side fallback for Haiku 5.5 and a fallbacks parameter on its
 * requests is at best ignored, at worst a 400. An unknown name carries nothing for the same
 * reason (the usage tier may hand a call any of the three).
 *
 * Usage: `client.beta.messages.stream({ model, ...fallbacksFor(model), ... })` — the beta
 * namespace is where the SDK types `betas` and `fallbacks`; the stable `client.messages` does
 * not. A replayed assistant turn must keep its `fallback` block in place and leave out the
 * thinking and tool_use blocks that came before it (lib/nort/replay replayContent does).
 */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01" as const;
export type FallbackFields = { betas: [typeof FALLBACK_BETA]; fallbacks: "default" } | { betas?: undefined; fallbacks?: undefined };

export function fallbacksFor(model: string): FallbackFields {
  const base = String(model ?? "").replace(/-\d{8}$/, "");
  if (/^claude-(opus|sonnet|fable)-/.test(base)) return { betas: [FALLBACK_BETA], fallbacks: "default" };
  return {};
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
  /** The response's content, when the caller has it: its `fallback` blocks say why each hop was
   *  declined, which decides whether a decline before any output was billed (billedParts). */
  content?: unknown;
}): Promise<void> {
  const { orgId, model, surface, usage } = args;
  if (!orgId || !usage) return;
  try {
    const categories = declineCategories(args.content);
    const t = billedTokens(model, usage, categories);
    const sb = createServiceClient();
    await sb.rpc("record_ai_usage", {
      p_org_id: orgId,
      p_model: model,
      p_surface: surface,
      p_input: t.input,
      p_cache_read: t.cacheRead,
      p_cache_write: t.cacheWrite,
      p_output: t.output,
      p_cost_usd: costOf(model, usage, categories),
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
 * WHICH MODEL TIER A COMPANY RUNS ON THIS MONTH (cn-v1140): "full" until the month's usage is used
 * up, "lighter" past 100% — the routine model, until the month turns or usage is added. ONE RULE
 * on the one meter (lib/usage-meter usageFor, read once by the caller): the estimator's gate and
 * Nort's chat route both ask it on the meter they already hold, so the ring on the plan card and
 * the model a call runs on can never disagree. NOTHING STOPS: a
 * lighter tier is a model pick, never a refusal (aiAllowed above is the only door that refuses, and
 * only for a plan that has ended or the abuse ceiling). Fails OPEN the way the meter does: a read
 * that failed is "full" — a company never loses its model to an outage of ours.
 *
 * The estimate allowance this replaces (cn-v1128: fullEstimatesThisMonth, noteEstimateRun and the
 * 'estimator:run' ticks; plans.ts fullEstimatesPerMonth) is gone — Erik, 2026-10-30: "adding
 * estimates doesn't make sense; usage is understandable to anyone."
 */
export type AiTier = "full" | "lighter";

/** The rule itself, on a meter already read: out = lighter. */
export function tierOfUsage(meter: Pick<UsageMeter, "state">): AiTier {
  return meter.state === "out" ? "lighter" : "full";
}

