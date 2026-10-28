import { describe, expect, it } from "vitest";
import { costOf, modelFor, MONTHLY_AI_CEILING_USD, WEB_SEARCH_USD } from "./ai-cost";

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
    rpc: async (fn: string) => {
      gateDb.reads.push(`rpc:${fn}`);
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
