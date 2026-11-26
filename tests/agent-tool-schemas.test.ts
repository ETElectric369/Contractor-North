import { describe, expect, it } from "vitest";
import { DATA_TOOLS, STAFF_ONLY_DATA_TOOLS } from "@/lib/assistant-tools";
import { CALC_TOOLS } from "@/lib/electrical-calc";
import { z } from "zod";
import { agentWriteToolsForRole } from "@/lib/actions/agent-tools";
import { REGISTRY } from "@/lib/actions/registry";

/**
 * The chat route sends EVERY tool schema to Anthropic, which validates them against
 * JSON Schema draft 2020-12 — one invalid keyword in one tool 400s the whole request
 * and takes Nort down for everyone (it happened: time.addEntry's z.number().positive()
 * serialized as the draft-4 boolean exclusiveMinimum → "tools.84.custom.input_schema:
 * JSON schema is invalid"). tsc and the registry tests can't catch serialization
 * problems, so this locks the invariant at the exact seam: the generated schemas.
 */

// The draft-4-isms Anthropic rejects. `nullable` (openApi3) is an unknown keyword and
// unknown keywords are legal 2020-12 annotations — allowed.
function findViolations(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => findViolations(n, `${path}[${i}]`, out));
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (typeof o.exclusiveMinimum === "boolean") out.push(`${path}.exclusiveMinimum is a boolean (draft-4) — must be a number in 2020-12`);
  if (typeof o.exclusiveMaximum === "boolean") out.push(`${path}.exclusiveMaximum is a boolean (draft-4) — must be a number in 2020-12`);
  if (typeof o.id === "string" && path.endsWith("schema")) out.push(`${path}.id — 2020-12 uses $id`);
  for (const [k, v] of Object.entries(o)) findViolations(v, `${path}.${k}`, out);
}

const ROLES = ["owner", "admin", "office", "tech"];

describe("agent tool schemas are valid draft 2020-12", () => {
  for (const role of ROLES) {
    it(`write tools for role=${role}`, () => {
      const { tools } = agentWriteToolsForRole(role);
      const violations: string[] = [];
      for (const t of tools) findViolations(t.input_schema, t.name, violations);
      expect(violations, violations.join("\n")).toEqual([]);
    });
  }

  it("data + calc tool schemas", () => {
    const violations: string[] = [];
    for (const t of [...DATA_TOOLS, ...CALC_TOOLS] as { name: string; input_schema?: unknown }[]) {
      findViolations(t.input_schema ?? {}, t.name, violations);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("tool names satisfy the API's name rule", () => {
    const { tools } = agentWriteToolsForRole("owner");
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("the shelf's tools reach the crew (Shop Stock, Phase 3)", () => {
  it("a tech is offered stock.take and list_shelf; list_shelf is not an office-only read", () => {
    expect(agentWriteToolsForRole("tech").tools.map((t) => t.name)).toContain("stock__take");
    expect(DATA_TOOLS.map((t) => t.name)).toContain("list_shelf");
    expect(STAFF_ONLY_DATA_TOOLS.has("list_shelf")).toBe(false);
  });
});

// cn-v1196: the helper that built these schemas (zod-to-json-schema) returned `{}` for every
// zod 4 schema without a word, and every test above still passed on it — an empty schema has
// no violations. So the model would have been offered every tool with no fields at all. This
// pins the one thing an empty or thinner schema cannot fake: each tool's properties are
// exactly its action's zod input keys, for every role.
describe("every assistant tool shows the model every field of its action", () => {
  for (const role of ROLES) {
    it(`role=${role}: input_schema.properties has exactly the action's zod input keys`, () => {
      const { tools, resolve } = agentWriteToolsForRole(role);
      expect(tools.length).toBeGreaterThan(0);
      const wrong: string[] = [];
      for (const t of tools) {
        const action = resolve(t.name);
        const input = action ? REGISTRY[action]?.input : undefined;
        if (!(input instanceof z.ZodObject)) {
          wrong.push(`${t.name}: its action's input is not a zod object`);
          continue;
        }
        const want = Object.keys(input.shape).sort();
        const got = Object.keys((t.input_schema.properties ?? {}) as Record<string, unknown>).sort();
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${t.name}: has [${got.join(", ")}], its action takes [${want.join(", ")}]`);
      }
      expect(wrong, wrong.join("\n")).toEqual([]);
    });
  }
});

// cn-v1196: zod 4's generator writes three things the old schemas never said; toolJsonSchema
// puts each back, so the model is told what it was told before (the before/after comparison of
// every tool of every role differs only in key order). Each is pinned over every tool here.
describe("the tools say what they said on zod 3", () => {
  function sweep(node: unknown, path: string, out: string[]): void {
    if (Array.isArray(node)) return node.forEach((n, i) => sweep(n, `${path}[${i}]`, out));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    // A zod object (it has properties); a record is an open map on purpose and has none.
    const isZodObject = !!o.properties && typeof o.properties === "object" && !Array.isArray(o.properties);
    if (isZodObject && path.includes(".properties.") && o.additionalProperties !== false) out.push(`${path}: a nested object is not closed`);
    if (o.format === "uuid" && "pattern" in o) out.push(`${path}: an id carries a pattern beside format uuid`);
    if (o.maximum === Number.MAX_SAFE_INTEGER || o.minimum === -Number.MAX_SAFE_INTEGER) out.push(`${path}: an integer carries the safe-integer bound`);
    for (const [k, v] of Object.entries(o)) sweep(v, `${path}.${k}`, out);
  }
  for (const role of ROLES) {
    it(`role=${role}: nested objects closed, ids without a pattern, no safe-integer bounds`, () => {
      const out: string[] = [];
      for (const t of agentWriteToolsForRole(role).tools) sweep(t.input_schema, t.name, out);
      expect(out, out.join("\n")).toEqual([]);
    });
  }
  it("the sweep has something to look at: a nested object, an id and an integer are offered", () => {
    const s = JSON.stringify(agentWriteToolsForRole("owner").tools);
    expect(s).toContain('"format":"uuid"');
    expect(s).toContain('"type":"integer"');
    expect(s).toMatch(/"items":\{"type":"object"/);
  });
});
