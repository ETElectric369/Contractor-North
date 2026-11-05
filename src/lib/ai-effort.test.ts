import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AI_SURFACES, EFFORT_TABLE, aiRequestFor, effortFor, type Effort, type Surface, type Thinking } from "./ai-effort";

/**
 * THE EFFORT TABLE, PINNED: every ledger surface in the code has a row; the rows say what the
 * SDK-half brief decided; the floors that rose are the floors; and the request fragment is the
 * docs' exact shape, so a site that spreads it sends what the API expects and nothing else.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every surface name the code meters under: the literal after `surface:` on a line (both arms of
 *  a ternary), plus the `X_SURFACE = "..."` constants a site passes by name. */
function surfacesInCode(): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of walk(SRC)) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/\bsurface:\s/.test(line) && !/_SURFACE\s*=\s*"/.test(line)) return;
      for (const m of line.matchAll(/"([a-z][a-z0-9:-]*)"/g)) {
        if (!found.has(m[1])) found.set(m[1], `${relative(ROOT, f)}:${i + 1}`);
      }
    });
  }
  return found;
}

describe("every surface the code meters under has a row", () => {
  const inCode = surfacesInCode();

  it("the scan sees a real number of surfaces (the floor keeps it honest)", () => {
    expect(inCode.size).toBeGreaterThanOrEqual(20);
    expect(inCode.has("chat")).toBe(true);
    expect(inCode.has("chat:field")).toBe(true);
    expect(inCode.has("vendor-lookup")).toBe(true);
  });

  it("no surface in the code is missing from the table", () => {
    const missing = [...inCode.entries()].filter(([s]) => !(s in EFFORT_TABLE)).map(([s, where]) => `${s} (${where})`);
    expect(missing, "Add a row to EFFORT_TABLE for:\n" + missing.join("\n")).toEqual([]);
  });

  it("every row is well-formed: a known thinking word, a known effort, an integer floor of at least 1024", () => {
    const efforts: Effort[] = ["low", "medium", "high", "max"];
    const thinkings: Thinking[] = ["adaptive", "off"];
    for (const s of AI_SURFACES) {
      const r = effortFor(s);
      expect(efforts, s).toContain(r.effort);
      expect(thinkings, s).toContain(r.thinking);
      expect(Number.isInteger(r.maxTokens), s).toBe(true);
      expect(r.maxTokens, s).toBeGreaterThanOrEqual(1024);
    }
  });
});

describe("the rows say what was decided", () => {
  const expected: Record<Surface, Effort> = {
    "chat": "medium",
    "chat:field": "low",
    "estimator": "high",
    "estimator:tasks": "medium",
    "estimator:supplier-quote": "medium",
    "panel-plans": "high",
    "panel-photo": "medium",
    "circuit-schedule": "medium",
    "nort:review": "medium",
    "plan-brief": "medium",
    "site-designer": "medium",
    "playbook:hear": "medium",
    "setup:talk": "medium",
    "setup:draft": "medium",
    "setup:converse": "low",
    "compliance": "low",
    "vendor-lookup": "low",
    "vendor-list-read": "low",
    "organize": "medium",
    "organize:triage": "low",
    "materials": "medium",
    "statement-scan": "medium",
    "statement-scan-kind": "low",
    "json-repair": "low",
    "resource-from-link": "low",
    "site-chat": "low",
  };

  it("effort per surface", () => {
    for (const s of Object.keys(expected) as Surface[]) expect(effortFor(s).effort, s).toBe(expected[s]);
    // The table and the expectation list the same surfaces: a new row needs a decision here too.
    expect(Object.keys(expected).sort()).toEqual([...AI_SURFACES].sort());
  });

  it("only the small model's mechanics run without a thinking field", () => {
    const off = AI_SURFACES.filter((s) => effortFor(s).thinking === "off").sort();
    expect(off).toEqual(["json-repair", "resource-from-link", "statement-scan-kind"]);
  });

  it("the floors that rose are the floors", () => {
    expect(effortFor("chat").maxTokens).toBe(6000);
    expect(effortFor("chat:field").maxTokens).toBe(6000);
    expect(effortFor("nort:review").maxTokens).toBe(3000);
    expect(effortFor("organize:triage").maxTokens).toBe(1500);
    expect(effortFor("estimator").maxTokens).toBe(16000);
    expect(effortFor("panel-plans").maxTokens).toBe(10000);
    expect(effortFor("panel-photo").maxTokens).toBe(5000);
    expect(effortFor("circuit-schedule").maxTokens).toBe(5000);
    expect(effortFor("plan-brief").maxTokens).toBe(6000);
    expect(effortFor("playbook:hear").maxTokens).toBe(3000);
    expect(effortFor("setup:draft").maxTokens).toBe(6000);
    expect(effortFor("compliance").maxTokens).toBe(2000);
    expect(effortFor("organize").maxTokens).toBe(6000);
    expect(effortFor("materials").maxTokens).toBe(4000);
  });

  it("the rest keep today's cap", () => {
    expect(effortFor("site-designer").maxTokens).toBe(12288);
    expect(effortFor("statement-scan").maxTokens).toBe(16000);
    expect(effortFor("statement-scan-kind").maxTokens).toBe(1500);
    expect(effortFor("vendor-list-read").maxTokens).toBe(8000);
    expect(effortFor("vendor-lookup").maxTokens).toBe(2000);
    expect(effortFor("site-chat").maxTokens).toBe(1500);
    expect(effortFor("resource-from-link").maxTokens).toBe(1500);
    expect(effortFor("json-repair").maxTokens).toBe(4096);
    expect(effortFor("estimator:tasks").maxTokens).toBe(8192);
    expect(effortFor("estimator:supplier-quote").maxTokens).toBe(8192);
  });
});

describe("aiRequestFor: the docs' exact request shape", () => {
  it("adaptive rows carry thinking + output_config.effort + max_tokens, and nothing else", () => {
    expect(aiRequestFor("chat")).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "medium" }, max_tokens: 6000 });
    expect(aiRequestFor("estimator")).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "high" }, max_tokens: 16000 });
    expect(Object.keys(aiRequestFor("chat")).sort()).toEqual(["max_tokens", "output_config", "thinking"]);
  });

  it("off rows send no thinking field at all (never `disabled`, which the 5.5 line rejects)", () => {
    const f = aiRequestFor("json-repair");
    expect("thinking" in f).toBe(false);
    expect(f).toEqual({ output_config: { effort: "low" }, max_tokens: 4096 });
  });

  it("maxTokens is a floor: a site can raise it, never lower it", () => {
    expect(aiRequestFor("json-repair", { maxTokens: 12000 }).max_tokens).toBe(12000);
    expect(aiRequestFor("json-repair", { maxTokens: 10 }).max_tokens).toBe(4096);
    expect(aiRequestFor("chat", { maxTokens: NaN }).max_tokens).toBe(6000);
  });

  it("spreads into the SDK's create params as typed (a compile-time pin)", () => {
    const params: Anthropic.MessageCreateParams = {
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "hi" }],
      ...aiRequestFor("chat"),
    };
    expect(params.max_tokens).toBe(6000);
    expect(params.output_config?.effort).toBe("medium");
    expect(params.thinking?.type).toBe("adaptive");
  });
});
