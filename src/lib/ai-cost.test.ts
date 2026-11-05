import { describe, expect, it } from "vitest";
import { costOf, FALLBACK_BETA, fallbacksFor, modelFor, MONTHLY_AI_CEILING_USD, WEB_SEARCH_USD } from "./ai-cost";

/**
 * These guard the number the whole pricing model rests on. If costOf() is wrong, the
 * ledger is wrong, and "is this customer profitable?" gets a confident wrong answer.
 */
describe("costOf — the four token classes are priced differently", () => {
  it("prices a plain Opus call at list", () => {
    // 1M input @ $5 + 1M output @ $25
    expect(costOf("claude-opus-4-8", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(30, 4);
  });

  it("charges cache READS at 10% of input — the whole reason caching pays", () => {
    expect(costOf("claude-opus-4-8", { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.5, 4);
  });

  it("charges cache WRITES at 125% of input", () => {
    expect(costOf("claude-opus-4-8", { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(6.25, 4);
  });

  it("collapsing cache into plain input would misstate an agentic loop by ~10x", () => {
    // The realistic shape: a big cached prompt read many times.
    const cached = costOf("claude-opus-4-8", { cache_read_input_tokens: 2_000_000 });
    const ifTreatedAsInput = costOf("claude-opus-4-8", { input_tokens: 2_000_000 });
    expect(ifTreatedAsInput / cached).toBeCloseTo(10, 1);
  });

  it("a cheap model really is ~5x cheaper — the routing thesis", () => {
    const u = { input_tokens: 500_000, output_tokens: 100_000 };
    expect(costOf("claude-opus-4-8", u) / costOf("claude-haiku-4-5", u)).toBeCloseTo(5, 1);
  });

  it("an UNKNOWN model is priced as the most expensive, never as free", () => {
    // A surprise model must not silently read as $0 in the ledger.
    const unknown = costOf("some-future-model", { input_tokens: 1_000_000 });
    expect(unknown).toBeGreaterThanOrEqual(costOf("claude-opus-4-8", { input_tokens: 1_000_000 }));
  });

  it("treats missing/null usage as zero rather than NaN", () => {
    expect(costOf("claude-opus-4-8", {})).toBe(0);
    expect(costOf("claude-opus-4-8", { input_tokens: null, output_tokens: undefined })).toBe(0);
  });
});

describe("costOf — the ledger prices what it pays (G3, cn-v1142)", () => {
  const M = 1_000_000;

  it("a 1-hour cache write costs more than a 5-minute one for the same tokens (2x vs 1.25x input)", () => {
    const fiveMin = costOf("claude-opus-5-5", { cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 } });
    const oneHour = costOf("claude-opus-5-5", { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M } });
    expect(fiveMin).toBeCloseTo(5, 6);
    expect(oneHour).toBeCloseTo(8, 6);
    expect(oneHour).toBeGreaterThan(fiveMin);
  });

  it("the breakdown wins over the flat total when both are present", () => {
    const u = { cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 } };
    // 0.4M x $5 + 0.6M x $8 on Opus 5.5
    expect(costOf("claude-opus-5-5", u)).toBeCloseTo(2 + 4.8, 6);
  });

  it("without the breakdown, every write is priced at the 5-minute rate", () => {
    expect(costOf("claude-opus-5-5", { cache_creation_input_tokens: M })).toBeCloseTo(5, 6);
    expect(costOf("claude-opus-5-5", { cache_creation_input_tokens: M, cache_creation: null })).toBeCloseTo(5, 6);
    expect(costOf("claude-sonnet-5-5", { cache_creation_input_tokens: M })).toBeCloseTo(2.5, 6);
  });

  it("cache reads are the row's own price, not a flat 10%", () => {
    expect(costOf("claude-opus-5-5", { cache_read_input_tokens: M })).toBeCloseTo(0.2, 6); // 0.05x
    expect(costOf("claude-sonnet-5-5", { cache_read_input_tokens: M })).toBeCloseTo(0.2, 6); // 0.1x
    expect(costOf("claude-fable-5-1", { cache_read_input_tokens: M })).toBeCloseTo(0.25, 6); // 0.025x
    expect(costOf("claude-fable-5", { cache_read_input_tokens: M })).toBeCloseTo(1, 6);
  });

  it("Haiku 5.5 steps up past a 100K-token prompt, counting cached tokens in the prompt", () => {
    const under = { input_tokens: 100_000, output_tokens: 10_000 };
    expect(costOf("claude-haiku-5-5", under)).toBeCloseTo(0.1 * 0.1 + 0.01 * 0.5, 6);
    const over = { input_tokens: 100_001, output_tokens: 10_000 };
    expect(costOf("claude-haiku-5-5", over)).toBeCloseTo(0.100001 * 0.5 + 0.01 * 2.5, 5);
    // 50K fresh + 60K read = a 110K prompt: the whole call is on the long-context card.
    const mixed = { input_tokens: 50_000, cache_read_input_tokens: 60_000 };
    expect(costOf("claude-haiku-5-5", mixed)).toBeCloseTo(0.05 * 0.5 + 0.06 * 0.05, 6);
    // A dated id strips to the same row.
    expect(costOf("claude-haiku-5-5-20261001", over)).toBeCloseTo(costOf("claude-haiku-5-5", over), 6);
  });

  it("an unknown model keeps today's price: $10 input, reads $1, 5-minute writes $12.50", () => {
    expect(costOf("some-future-model", { input_tokens: M, output_tokens: M })).toBeCloseTo(60, 6);
    expect(costOf("some-future-model", { cache_read_input_tokens: M })).toBeCloseTo(1, 6);
    expect(costOf("some-future-model", { cache_creation_input_tokens: M })).toBeCloseTo(12.5, 6);
  });

  it("web searches stay a cent each on any model", () => {
    expect(costOf("claude-haiku-5-5", { server_tool_use: { web_search_requests: 3 } })).toBeCloseTo(3 * WEB_SEARCH_USD, 6);
  });
});

describe("modelFor — reasoning keeps the good model, everything else gets routed", () => {
  it("estimating and takeoff stay on the frontier model", () => {
    // Downgrading this is a false economy: a wrong estimate costs a contractor far
    // more than the tokens saved.
    expect(modelFor("reasoning")).toMatch(/opus|fable/);
  });

  it("routine lookups and classification do NOT use the expensive model", () => {
    expect(modelFor("routine")).not.toBe(modelFor("reasoning"));
    expect(modelFor("classify")).not.toBe(modelFor("reasoning"));
  });

  it("classification is the cheapest tier", () => {
    const u = { input_tokens: 100_000, output_tokens: 10_000 };
    expect(costOf(modelFor("classify"), u)).toBeLessThan(costOf(modelFor("routine"), u));
  });

  it("ROUTINE is genuinely cheaper than reasoning, not merely different", () => {
    // The chat route now hands a FIELD TECH the routine model (11 tools, ~7k preamble, lookups
    // and punches — no estimating). "not equal" was the only guard, and two differently-named
    // models at the same price would have made that routing free of any benefit while looking
    // like it worked.
    const u = { input_tokens: 100_000, output_tokens: 10_000 };
    expect(costOf(modelFor("routine"), u)).toBeLessThan(costOf(modelFor("reasoning"), u));
  });
});

describe("fallbacksFor — the big and the middle model ask for a server-side stand-in; the small one never", () => {
  const asked = { betas: [FALLBACK_BETA], fallbacks: "default" };

  it("the reasoning and routine models carry the beta header + fallbacks: default", () => {
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
    expect(fallbacksFor("claude-opus-5-5")).toEqual(asked);
    expect(fallbacksFor("claude-sonnet-5-5")).toEqual(asked);
    expect(fallbacksFor(modelFor("reasoning"))).toEqual(asked);
    expect(fallbacksFor(modelFor("routine"))).toEqual(asked);
  });

  it("the small model carries NOTHING — no fallbacks field and no beta header", () => {
    expect(fallbacksFor("claude-haiku-5-5")).toEqual({});
    expect(fallbacksFor(modelFor("classify"))).toEqual({});
    expect("betas" in fallbacksFor(modelFor("classify"))).toBe(false);
    expect("fallbacks" in fallbacksFor(modelFor("classify"))).toBe(false);
  });

  it("a dated snapshot is its model; an unknown or empty name carries nothing", () => {
    expect(fallbacksFor("claude-sonnet-5-5-20261001")).toEqual(asked);
    expect(fallbacksFor("claude-haiku-5-5-20261001")).toEqual({});
    expect(fallbacksFor("")).toEqual({});
    expect(fallbacksFor("some-other-vendor-model")).toEqual({});
  });
});

describe("the ceiling is an abuse stop, not a usage tier", () => {
  it("sits well above what a heavy legitimate user costs", () => {
    // A heavy user measured at ~$22-67/mo depending on routing. The ceiling must not
    // catch them — it exists for runaway loops and abuse.
    expect(MONTHLY_AI_CEILING_USD).toBeGreaterThan(100);
  });
});

describe("costOf — web searches are billed per search (vendor import, Phase 2)", () => {
  it("adds $0.01 per search on top of the tokens", () => {
    expect(WEB_SEARCH_USD).toBe(0.01);
    const tokens = costOf("claude-sonnet-5", { input_tokens: 20_000, output_tokens: 1_000 });
    const withSearches = costOf("claude-sonnet-5", { input_tokens: 20_000, output_tokens: 1_000, server_tool_use: { web_search_requests: 3 } });
    expect(withSearches - tokens).toBeCloseTo(0.03, 6);
  });

  it("a search costs the same on any model, and a call that only searched is not free", () => {
    expect(costOf("claude-haiku-4-5", { server_tool_use: { web_search_requests: 6 } })).toBeCloseTo(0.06, 6);
    expect(costOf("claude-opus-4-8", { server_tool_use: { web_search_requests: 1 } })).toBeCloseTo(0.01, 6);
  });

  it("the chat route's usage object, passed straight through, now counts its searches", () => {
    // Nort chat and site-chat hand recordAiUsage the SDK's own usage object; it carries
    // server_tool_use whenever web_search ran. Before this fix those searches cost $0 here.
    const sdkUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 6 } };
    expect(costOf("claude-opus-4-8", sdkUsage)).toBeCloseTo(0.06, 6);
  });

  it("missing, null or nonsense search counts are zero, never NaN or a refund", () => {
    expect(costOf("claude-sonnet-5", { server_tool_use: null })).toBe(0);
    expect(costOf("claude-sonnet-5", { server_tool_use: { web_search_requests: null } })).toBe(0);
    expect(costOf("claude-sonnet-5", { server_tool_use: { web_search_requests: -4 } })).toBe(0);
    expect(costOf("claude-sonnet-5", { server_tool_use: { web_search_requests: Number.NaN } })).toBe(0);
  });
});

/**
 * THE ONE AI GATE (cn-v1137, decision 3): aiAllowed asks the company's standing first (orgAccess),
 * then the ceiling, and answers `why` in words — the owner is told the door, everyone else who
 * holds the key. Both halves fail OPEN. Pinned against a routed fake of the two clients: the
 * standing read, the ceiling RPC, the caller's role and the owner's name are the only reads.
 */
const gateDb = vi.hoisted(() => ({
  org: null as Record<string, unknown> | null,
  orgFails: false,
  spend: 0,
  role: "office",
  owner: "Larkspur Owner",
  reads: [] as string[],
  rpcArgs: null as Record<string, unknown> | null,
}));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), billingEnabled: true }));
vi.mock("@/lib/observe", async (orig) => ({ ...(await orig<typeof import("@/lib/observe")>()), reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string, byId: boolean) => {
    const q: any = {};
    for (const m of ["select", "order", "limit", "in", "is", "gte", "lte"]) q[m] = () => q;
    q.eq = (col: string) => (col === "id" ? chain(table, true) : q);
    q.maybeSingle = async () => {
      gateDb.reads.push(table);
      if (table === "organizations") {
        if (gateDb.orgFails) throw new Error("connection reset");
        return { data: gateDb.org, error: null };
      }
      if (table === "profiles") return { data: byId ? { role: gateDb.role } : { full_name: gateDb.owner }, error: null };
      return { data: null, error: null };
    };
    return q;
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => chain(table, false),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      gateDb.reads.push(`rpc:${fn}`);
      if (fn === "record_ai_usage") gateDb.rpcArgs = args ?? null;
      return fn === "ai_spend_since" ? { data: gateDb.spend, error: null } : { data: null, error: null };
    },
  };
  return { createClient: async () => client, createServiceClient: () => client };
});

import { vi, beforeEach } from "vitest";
import { AI_CEILING_WORDS, aiAllowed } from "./ai-cost";
import { reportError } from "@/lib/observe";

const CANCELED = { id: "org-1", subscription_status: "canceled", trial_ends_at: null, current_period_end: null, comped_until: null };
const LIVE = { ...CANCELED, subscription_status: "active" };

beforeEach(() => {
  gateDb.org = LIVE;
  gateDb.orgFails = false;
  gateDb.spend = 0;
  gateDb.role = "office";
  gateDb.owner = "Larkspur Owner";
  gateDb.reads = [];
  vi.mocked(reportError).mockClear();
});

describe("aiAllowed — the plan that has ended comes before the ceiling, in the asker's words", () => {
  it("a standing company under the ceiling is allowed", async () => {
    expect(await aiAllowed("org-1", "owner")).toEqual({ ok: true });
    expect(gateDb.reads).toEqual(["organizations", "rpc:ai_spend_since"]);
  });

  it("a canceled plan is refused BEFORE the ceiling is even asked, and the owner is told the door", async () => {
    gateDb.org = CANCELED;
    gateDb.spend = 10_000;
    expect(await aiAllowed("org-1", "owner")).toEqual({
      ok: false,
      reason: "lapsed",
      why: "This company's plan has ended, so Nort is paused. Pick a plan in Settings › Getting Paid.",
    });
    expect(gateDb.reads).not.toContain("rpc:ai_spend_since");
  });

  it("an admin is told the door too; everyone else is told who holds the key, by first name", async () => {
    gateDb.org = CANCELED;
    expect((await aiAllowed("org-1", "admin")) as { why: string }).toMatchObject({ why: expect.stringContaining("Pick a plan in Settings › Getting Paid.") });
    expect((await aiAllowed("org-1", "tech")) as { why: string }).toMatchObject({ why: "This company's plan has ended, so Nort is paused. Ask Larkspur to pick a plan." });
    gateDb.owner = "";
    expect((await aiAllowed("org-1", "office")) as { why: string }).toMatchObject({ why: expect.stringContaining("Ask the owner to pick a plan.") });
  });

  it("a role the caller did not pass is read from the signed-in profile, on the refusal path only", async () => {
    gateDb.role = "owner";
    expect(await aiAllowed("org-1")).toEqual({ ok: true });
    expect(gateDb.reads).not.toContain("profiles");
    gateDb.org = CANCELED;
    gateDb.reads = [];
    expect((await aiAllowed("org-1")) as { why: string }).toMatchObject({ why: expect.stringContaining("Pick a plan in Settings › Getting Paid.") });
    expect(gateDb.reads).toEqual(["organizations", "profiles"]);
  });

  it("the words follow the reason: an expired trial, a grace window spent", async () => {
    gateDb.org = { ...CANCELED, subscription_status: "trialing", trial_ends_at: "2020-01-01T00:00:00Z" };
    expect((await aiAllowed("org-1", "owner")) as { why: string }).toMatchObject({ why: expect.stringMatching(/^This company's free trial has ended, so Nort is paused\./) });
    gateDb.org = { ...CANCELED, subscription_status: "past_due", current_period_end: "2020-01-01T00:00:00Z" };
    expect((await aiAllowed("org-1", "owner")) as { why: string }).toMatchObject({ why: expect.stringMatching(/^This company's card was not updated in time, so Nort is paused\./) });
  });

  it("over the ceiling, a standing company is refused with the ceiling's words — the door's own when it has them", async () => {
    gateDb.spend = MONTHLY_AI_CEILING_USD;
    expect(await aiAllowed("org-1", "owner")).toEqual({ ok: false, reason: "ceiling", why: AI_CEILING_WORDS });
    expect(await aiAllowed("org-1", "owner", { ceilingWords: "Add the circuits by hand." })).toEqual({ ok: false, reason: "ceiling", why: "Add the circuits by hand." });
  });

  it("a door speaking to a stranger passes its own lapse line, and no profile is read for it", async () => {
    gateDb.org = CANCELED;
    expect(await aiAllowed("org-1", null, { lapsedWords: "This company's assistant is paused." })).toEqual({ ok: false, reason: "lapsed", why: "This company's assistant is paused." });
    expect(gateDb.reads).toEqual(["organizations"]);
  });

  it("a standing the caller already read is taken as given: no second trip to the company row", async () => {
    gateDb.org = CANCELED; // would refuse if read
    expect(await aiAllowed("org-1", "owner", { state: { active: true, reason: "active", daysLeft: null, compedBy: null } })).toEqual({ ok: true });
    expect(gateDb.reads).toEqual(["rpc:ai_spend_since"]);
  });

  it("FAILS OPEN: a company read that fails is filed and allowed; no company id is allowed", async () => {
    gateDb.orgFails = true;
    expect(await aiAllowed("org-1", "owner")).toEqual({ ok: true });
    expect(reportError).toHaveBeenCalledWith("org-access:read", expect.any(Error), { orgId: "org-1" });
    expect(await aiAllowed(null)).toEqual({ ok: true });
  });
});

/**
 * THE MODEL TIER FOR THE MONTH (cn-v1140): tierOfUsage is the rule itself on a meter the caller
 * already read (lib/usage-meter usageFor) — "lighter" only past 100%, never a refusal; the meter's
 * open answer for a failed read is "fine", so it is "full". The estimator's gate and Nort's route
 * read once and decide the same way.
 */
import { tierOfUsage } from "./ai-cost";

describe("tierOfUsage — full until the month's usage is used up, lighter past it, never a refusal", () => {
  it("the rule on a meter already read: out is lighter, everything else is full", () => {
    expect(tierOfUsage({ state: "out" })).toBe("lighter");
    expect(tierOfUsage({ state: "almost" })).toBe("full");
    expect(tierOfUsage({ state: "watch" })).toBe("full");
    expect(tierOfUsage({ state: "fine" })).toBe("full");
  });
});

/**
 * A FALLBACK'S USAGE IS METERED AS BILLED (cn-v1142 skeptic, finding 11). Top-level usage covers only
 * the attempt that produced the message; usage.iterations is the per-attempt truth, each attempt at
 * its own model's rate (shared/model-migration.md:1429). A decline before any output is billed only
 * in the bio / frontier_llm / reasoning_extraction categories; a mid-stream decline always is.
 */
import { billedTokens, costOf as costOfIt, declineCategories, recordAiUsage } from "./ai-cost";

describe("costOf — a server-side fallback meters every billed attempt at its own model's rate", () => {
  const M = 1_000_000;
  it("claude-opus-5 has its own row ($5 / $25 per MTok), not the unknown-model row", () => {
    expect(costOfIt("claude-opus-5", { input_tokens: M, output_tokens: M })).toBe(30);
    expect(costOfIt("claude-opus-5", { input_tokens: M })).not.toBe(costOfIt("claude-not-a-model", { input_tokens: M }));
  });

  it("a mid-stream decline is billed at the declined model's rate, the rescue at the fallback's", () => {
    const usage = {
      input_tokens: M, // top-level: the serving attempt only
      output_tokens: M,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: M, output_tokens: M / 2 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: M, output_tokens: M },
      ],
    };
    // opus-5-5: 4 + 10 = 14; opus-4-8: 5 + 25 = 30
    expect(costOfIt("claude-opus-4-8", usage)).toBe(44);
    expect(billedTokens("claude-opus-4-8", usage)).toEqual({ input: 2 * M, cacheRead: 0, cacheWrite: 0, output: 1.5 * M });
  });

  it("a decline before any output is not billed in an unbilled category, and is in a billed one", () => {
    const usage = {
      input_tokens: M,
      output_tokens: M,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: M, output_tokens: 0 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: M, output_tokens: M },
      ],
    };
    expect(costOfIt("claude-opus-4-8", usage)).toBe(30);
    expect(costOfIt("claude-opus-4-8", usage, ["cyber"])).toBe(30);
    expect(costOfIt("claude-opus-4-8", usage, [null])).toBe(30);
    expect(costOfIt("claude-opus-4-8", usage, ["bio"])).toBe(34);
  });

  it("no iterations: the top-level usage, as before; web searches count once", () => {
    expect(costOfIt("claude-opus-5-5", { input_tokens: M, output_tokens: M })).toBe(24);
    const withSearch = {
      input_tokens: M,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 2 },
      iterations: [{ type: "message", model: "claude-opus-5-5", input_tokens: M, output_tokens: 0 }],
    };
    expect(costOfIt("claude-opus-5-5", withSearch)).toBe(4.02);
  });

  it("declineCategories reads the fallback blocks' trigger categories", () => {
    expect(
      declineCategories([
        { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal", category: "bio" } },
        { type: "text", text: "hi" },
        { type: "fallback", trigger: { type: "refusal", category: null } },
      ]),
    ).toEqual(["bio", null]);
    expect(declineCategories(undefined)).toEqual([]);
  });

  it("recordAiUsage writes the billed totals and cost to the ledger", async () => {
    gateDb.rpcArgs = null;
    await recordAiUsage({
      orgId: "org-1",
      model: "claude-opus-4-8",
      surface: "test",
      usage: {
        input_tokens: M,
        output_tokens: M,
        iterations: [
          { type: "message", model: "claude-opus-5-5", input_tokens: M, output_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: M, output_tokens: M },
        ],
      },
      content: [{ type: "fallback", trigger: { type: "refusal", category: "reasoning_extraction" } }, { type: "text", text: "ok" }],
    });
    expect(gateDb.rpcArgs).toMatchObject({ p_input: 2 * M, p_output: M, p_cost_usd: 34 });
  });
});
