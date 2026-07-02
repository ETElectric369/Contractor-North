import { describe, expect, it } from "vitest";
import { DATA_TOOLS } from "@/lib/assistant-tools";
import { CALC_TOOLS } from "@/lib/electrical-calc";
import { agentWriteToolsForRole } from "@/lib/actions/agent-tools";

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
