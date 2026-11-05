import { describe, expect, it } from "vitest";
import { DATA_TOOLS } from "@/lib/assistant-tools";
import { CALC_TOOLS } from "@/lib/electrical-calc";
import { agentWriteToolsForRole } from "@/lib/actions/agent-tools";
import { STRICT_LIMITS, strictBudgetOf, strictProblems, strictTool, strictTools, toStrictSchema } from "./strict-schema";

/**
 * EVERY TOOL THE APP DEFINES, THROUGH THE STRICT RULES, LOCALLY (cn-v1142). One tool that
 * strict mode rejects 400s the whole request it rides in, and tsc cannot see a JSON schema. So
 * the registry's generated tools (every role), the hand-written data tools and the calculators
 * each go through toStrictSchema here and must come out with no remaining problem — a failure
 * names the tool and the path, so the fix is a line to read, not a chat to bisect.
 */

const ROLES = ["owner", "admin", "office", "tech"];

type ToolLike = { name: string; input_schema?: unknown };

/**
 * THE KNOWN EXCEPTIONS: a tool whose input is an open map BY DESIGN. form.submit's `data` is
 * keyed by that form's own field labels, which no schema can name ahead of time, and strict mode
 * has no word for "any keys". Such a tool never goes strict: strictTool hands it back exactly as
 * it came, strictTools skips it by name, and the API takes it unmarked as it always has. A new
 * name here is a decision, not a fix; a name that stops failing is a pin to remove.
 */
const KNOWN_OPEN_MAPS: Record<string, string> = {
  form__submit: "input_schema.data: additionalProperties is a schema (an open map); strict cannot express it — name the keys as properties",
};
const isKnown = (failure: string) => Object.entries(KNOWN_OPEN_MAPS).some(([name, why]) => failure === `${name} — ${why}`);

function sweep(tools: ReadonlyArray<ToolLike>): string[] {
  const failures: string[] = [];
  for (const t of tools) {
    for (const p of strictProblems(toStrictSchema(t.input_schema))) failures.push(`${t.name} — ${p}`);
  }
  return failures;
}

describe("every tool the app defines survives the strict rules", () => {
  for (const role of ROLES) {
    it(`the registry's write + read tools for role=${role}`, () => {
      const { tools } = agentWriteToolsForRole(role);
      expect(tools.length).toBeGreaterThan(0);
      const failures = sweep(tools).filter((f) => !isKnown(f));
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }

  it("the known exceptions still fail, by name and by reason (remove a pin the day its schema closes)", () => {
    const failures = sweep(agentWriteToolsForRole("owner").tools);
    for (const [name, why] of Object.entries(KNOWN_OPEN_MAPS)) expect(failures).toContain(`${name} — ${why}`);
    // One problem per open map, not one per key inside it.
    expect(failures.filter((f) => f.startsWith("form__submit — "))).toHaveLength(1);
  });

  it("the hand-written data tools (a real number of them)", () => {
    expect(DATA_TOOLS.length).toBeGreaterThanOrEqual(50);
    const failures = sweep(DATA_TOOLS);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("the calculators", () => {
    const failures = sweep(CALC_TOOLS as unknown as ToolLike[]);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("strictTool marks each of them strict, with its schema closed — and hands an open-map tool back untouched", () => {
    const all = [...DATA_TOOLS, ...(CALC_TOOLS as unknown as ToolLike[]), ...ROLES.flatMap((r) => agentWriteToolsForRole(r).tools)] as Array<{ name: string; input_schema: unknown; strict?: boolean }>;
    let known = 0;
    for (const t of all) {
      const s = strictTool(t);
      if (t.name in KNOWN_OPEN_MAPS) {
        known++;
        expect("strict" in s, t.name).toBe(false);
        expect(s.input_schema, t.name).toBe(t.input_schema);
        continue;
      }
      expect(s.strict, t.name).toBe(true);
      expect((s.input_schema as { additionalProperties?: unknown }).additionalProperties, t.name).toBe(false);
    }
    expect(known).toBe(ROLES.length * Object.keys(KNOWN_OPEN_MAPS).length);
  });

  it("the calculators fit one request's strict budget (the estimator's strict set)", () => {
    const b = strictBudgetOf(CALC_TOOLS as unknown as ToolLike[]);
    expect(b.over).toEqual([]);
    expect(b.strict).toBe(4);
    expect(b.optional).toBeLessThanOrEqual(STRICT_LIMITS.optional);
  });

  it("the whole chat array does NOT fit — strict is for a chosen few per request, never the lot", () => {
    const b = strictBudgetOf([...DATA_TOOLS, ...agentWriteToolsForRole("owner").tools]);
    expect(b.over.length).toBeGreaterThan(0);
    // strictTools stops marking at the budget and says which tools it left alone.
    const { tools, skipped } = strictTools([...DATA_TOOLS, ...agentWriteToolsForRole("owner").tools]);
    const marked = tools.filter((t) => (t as { strict?: boolean }).strict === true);
    expect(marked.length).toBeLessThanOrEqual(STRICT_LIMITS.tools);
    expect(strictBudgetOf(marked).over).toEqual([]);
    expect(skipped.length).toBe(tools.length - marked.length);
    expect(skipped[0].why).toMatch(/over budget/);
  });
});

describe("toStrictSchema: the mechanical rules", () => {
  it("closes every object and keeps required to names that exist", () => {
    const s = toStrictSchema({
      type: "object",
      properties: { a: { type: "string" }, nest: { type: "object", properties: { b: { type: "number" } }, required: ["b", "gone"] } },
      required: ["a", "missing"],
    }) as Record<string, unknown>;
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["a"]);
    const nest = (s.properties as Record<string, Record<string, unknown>>).nest;
    expect(nest.additionalProperties).toBe(false);
    expect(nest.required).toEqual(["b"]);
    expect(strictProblems(s)).toEqual([]);
  });

  it("moves numeric, string and array constraints into the description, keeping the words that were there", () => {
    const s = toStrictSchema({
      type: "object",
      properties: {
        hours: { type: "number", description: "hours worked", minimum: 0, exclusiveMaximum: 24 },
        code: { type: "string", minLength: 1, maxLength: 12, pattern: "^[A-Z]+$" },
        tags: { type: "array", items: { type: "string" }, maxItems: 5, uniqueItems: true, minItems: 2 },
        pair: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["hours"],
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(s.properties.hours).toEqual({ type: "number", description: "hours worked (minimum: 0, exclusiveMaximum: 24)" });
    expect(s.properties.code.description).toBe('(minLength: 1, maxLength: 12, pattern: "^[A-Z]+$")');
    expect("pattern" in s.properties.code).toBe(false);
    expect(s.properties.tags).toEqual({ type: "array", items: { type: "string" }, description: "(maxItems: 5, uniqueItems: true, minItems: 2)" });
    // minItems 0 and 1 are the supported values and stay.
    expect(s.properties.pair.minItems).toBe(1);
    expect(strictProblems(s)).toEqual([]);
  });

  it("spells openApi3's nullable as a null union, and oneOf as anyOf", () => {
    const s = toStrictSchema({
      type: "object",
      properties: {
        due: { type: "string", nullable: true },
        pick: { oneOf: [{ type: "string" }, { type: "number" }] },
        box: { type: "object", properties: { x: { type: "string" } }, nullable: true },
      },
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(s.properties.due).toEqual({ type: ["string", "null"] });
    expect(s.properties.pick).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(s.properties.box).toEqual({ type: ["object", "null"], properties: { x: { type: "string" } }, additionalProperties: false, required: [] });
    expect(strictProblems(s)).toEqual([]);
  });

  it("keeps supported formats and moves unknown ones into the description", () => {
    const s = toStrictSchema({
      type: "object",
      properties: { when: { type: "string", format: "date" }, odd: { type: "string", format: "YYYY-MM-DD" } },
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(s.properties.when.format).toBe("date");
    expect(s.properties.odd).toEqual({ type: "string", description: "(format: YYYY-MM-DD)" });
  });

  it("inlines local $refs from definitions, $defs and components, and leaves a recursive one for the validator to name", () => {
    const s = toStrictSchema({
      type: "object",
      properties: { a: { $ref: "#/definitions/Line" }, b: { $ref: "#/$defs/Line2", description: "kept" } },
      definitions: { Line: { type: "object", properties: { qty: { type: "number" } } } },
      $defs: { Line2: { type: "string" } },
    }) as Record<string, unknown>;
    expect(s.definitions).toBeUndefined();
    expect(s.$defs).toBeUndefined();
    const p = s.properties as Record<string, Record<string, unknown>>;
    expect(p.a).toEqual({ type: "object", properties: { qty: { type: "number" } }, additionalProperties: false, required: [] });
    expect(p.b).toEqual({ type: "string", description: "kept" });
    expect(strictProblems(s)).toEqual([]);

    const recursive = toStrictSchema({
      type: "object",
      properties: { node: { $ref: "#/definitions/Node" } },
      definitions: { Node: { type: "object", properties: { child: { $ref: "#/definitions/Node" } } } },
    });
    const problems = strictProblems(recursive);
    expect(problems.some((p) => /\$ref #\/definitions\/Node left in place/.test(p))).toBe(true);
  });

  it("does not invent a schema for an open map: it stays, and the validator names it", () => {
    // The shape of the chat's fill_screen tool: `fields` is a free map of string → string.
    const fill = {
      name: "fill_screen",
      input_schema: {
        type: "object",
        properties: {
          door: { type: "string" },
          value: { type: "string" },
          fields: { type: "object", description: "its named fields", additionalProperties: { type: "string" } },
        },
        required: ["door"],
      },
    };
    const problems = strictProblems(toStrictSchema(fill.input_schema));
    expect(problems).toEqual(["input_schema.fields: additionalProperties is a schema (an open map); strict cannot express it — name the keys as properties"]);
    // strictTool leaves such a tool exactly as it came — no strict flag, no silent rewrite.
    expect(strictTool(fill)).toEqual(fill);
    expect("strict" in strictTool(fill)).toBe(false);
  });

  it("never mutates the tool it was given", () => {
    const before = { type: "object", properties: { n: { type: "number", minimum: 1 } } };
    const copy = JSON.parse(JSON.stringify(before));
    toStrictSchema(before);
    expect(before).toEqual(copy);
  });
});

describe("strictBudgetOf counts the way the limits table does", () => {
  it("optional = parameters outside required at every depth; unions = anyOf or a type array", () => {
    const tool = {
      name: "t",
      input_schema: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: ["string", "null"] },
          c: { anyOf: [{ type: "string" }, { type: "number" }] },
          d: { type: "object", properties: { e: { type: "string" }, f: { type: "string" } }, required: ["e"] },
        },
        required: ["a", "d"],
      },
    };
    expect(strictBudgetOf([tool])).toEqual({ strict: 1, optional: 3, unions: 2, over: [] });
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, input_schema: { type: "object", properties: {} } }));
    expect(strictBudgetOf(many).over).toEqual(["21 strict tools (limit 20)"]);
  });
});
