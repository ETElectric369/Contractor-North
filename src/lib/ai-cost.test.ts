import { describe, expect, it } from "vitest";
import { costOf, modelFor, MONTHLY_AI_CEILING_USD } from "./ai-cost";

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
