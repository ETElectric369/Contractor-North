import type Anthropic from "@anthropic-ai/sdk";

/**
 * STRICT TOOLS, PROVEN BEFORE THEY LEAVE (cn-v1142, the SDK half).
 *
 * `strict: true` on a tool makes the API guarantee that `tool_use.input` validates against the
 * tool's schema — the argument-validity guarantee that forced tool use gave and the 5.5 line
 * took away. The price is a stricter schema language, and ONE tool that breaks it 400s the
 * WHOLE request (it happened once already with a draft-4 boolean, tests/agent-tool-schemas): so
 * nothing here is wired at a call site until a test has run every tool the app defines through
 * the same rules locally.
 *
 * THE RULES (platform.claude.com/docs/en/build-with-claude/structured-outputs, read 2026-11-04,
 * and the skill's shared/tool-use-concepts.md § JSON Schema Limitations):
 *   supported   object, array, string, integer, number, boolean, null; enum (primitives only);
 *               const; anyOf, allOf (allOf with $ref is not); local $ref / $defs / definitions;
 *               default; required; additionalProperties: false (REQUIRED on every object);
 *               string formats date-time, time, date, duration, email, hostname, uri, ipv4,
 *               ipv6, uuid; minItems 0 or 1; simple regex patterns (complex ones 400).
 *   unsupported recursive schemas; minimum/maximum/multipleOf; minLength/maxLength; array
 *               constraints beyond minItems 0/1; additionalProperties as anything but false.
 *   optional    a property left out of `required` is ALLOWED (it counts against the budget below).
 *   the budget  PER REQUEST, across every strict schema in it: at most 20 strict tools, 24
 *               optional parameters in total, 16 parameters with union types (anyOf or a type
 *               array such as ["string", "null"]). Past any of these the API answers 400
 *               "Schema is too complex for compilation". Nort's chat offers ~100 tools with
 *               hundreds of optional parameters, so strict is for a chosen FEW per request
 *               (the calculators, a draft tool), never the whole array.
 *
 * What the sanitiser does, mechanically and safely: adds additionalProperties: false to every
 * object; keeps `required` to names that exist; moves every unsupported constraint INTO the
 * property's description so the model still reads it; turns openApi3's `nullable: true` (what
 * zod-to-json-schema emits for the registry) into a null union; turns oneOf into anyOf; strips
 * unknown string formats into the description; inlines local $refs. What it does NOT do: invent
 * a schema for an open map (`additionalProperties: { type: "string" }`) — that cannot be strict
 * without changing what the tool accepts, so it stays as it is and strictProblems names it.
 *
 * USAGE (one line, at a call site, for a chosen few):
 *   tools: strictTools([...calcTools, QUOTE_DRAFT_TOOL]).tools
 * or per tool: strictTool(tool). A tool that cannot be made strict is returned UNCHANGED (no
 * `strict`), never thrown on — one bad tool must never 400 the chat in production; the test is
 * where it fails, by name.
 */

type Json = Record<string, unknown>;

/** The per-request budget the API enforces on strict schemas (docs § Schema complexity limits). */
export const STRICT_LIMITS = { tools: 20, optional: 24, unions: 16 } as const;

/** The string formats strict mode accepts; any other `format` is moved into the description. */
export const STRICT_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Keywords strict mode rejects: each is removed and written into the description instead. */
const CONSTRAINT_KEYS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "not",
] as const;

const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A node describes an object when it says so, or when it carries properties. */
const describesObject = (n: Json): boolean => n.type === "object" || (Array.isArray(n.type) && n.type.includes("object")) || isObj(n.properties);

/** Where a local $ref points: "#/definitions/x", "#/$defs/x", "#/components/schemas/x". */
function resolveRef(root: Json, ref: string): Json | null {
  if (!ref.startsWith("#/")) return null;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isObj(node)) return null;
    node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isObj(node) ? node : null;
}

/** Append "(k: v, k: v)" to a description, keeping the words that were there. */
function noteInDescription(node: Json, notes: string[]): void {
  if (!notes.length) return;
  const had = typeof node.description === "string" && node.description.trim() ? node.description.trim() : "";
  node.description = `${had}${had ? " " : ""}(${notes.join(", ")})`;
}

/**
 * The sanitised schema: every object closed, every unsupported keyword moved into words, every
 * local $ref inlined, nullable spelled as a union. Pure: the input is never mutated.
 */
export function toStrictSchema(schema: unknown): Anthropic.Tool.InputSchema {
  const root = isObj(schema) ? clone(schema) : { type: "object", properties: {} };
  const walk = (node: unknown, stack: string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, stack));
    if (!isObj(node)) return node;
    let n: Json = { ...node };

    // Local references: inline the definition, unless following it would recurse (unsupported —
    // left as a $ref for strictProblems to name).
    if (typeof n.$ref === "string") {
      const target = resolveRef(root, n.$ref);
      if (target && !stack.includes(n.$ref)) {
        const { $ref, ...rest } = n;
        n = { ...clone(target), ...rest };
        return walk(n, [...stack, $ref as string]);
      }
      return n;
    }

    // openApi3's nullable → a null union the API understands.
    if (n.nullable === true) {
      delete n.nullable;
      if (typeof n.type === "string") n.type = [n.type, "null"];
      else if (Array.isArray(n.type)) {
        if (!n.type.includes("null")) n.type = [...n.type, "null"];
      } else if (Array.isArray(n.anyOf)) n.anyOf = [...n.anyOf, { type: "null" }];
      else {
        const { description, ...inner } = n;
        n = { ...(description !== undefined ? { description } : {}), anyOf: [inner, { type: "null" }] };
      }
    } else if (n.nullable === false) delete n.nullable;

    // oneOf is not in the supported list; anyOf is and reads the same to the model.
    if (Array.isArray(n.oneOf) && !Array.isArray(n.anyOf)) {
      n.anyOf = n.oneOf;
      delete n.oneOf;
    }

    // Unsupported constraints become words the model still reads.
    const notes: string[] = [];
    for (const k of CONSTRAINT_KEYS) {
      if (k in n) {
        notes.push(`${k}: ${JSON.stringify(n[k])}`);
        delete n[k];
      }
    }
    if (typeof n.minItems === "number" && n.minItems !== 0 && n.minItems !== 1) {
      notes.push(`minItems: ${n.minItems}`);
      delete n.minItems;
    }
    if (typeof n.format === "string" && !STRICT_FORMATS.has(n.format)) {
      notes.push(`format: ${n.format}`);
      delete n.format;
    }
    noteInDescription(n, notes);

    // Every object is closed, and `required` names only what exists.
    if (describesObject(n)) {
      if (!isObj(n.properties)) n.properties = {};
      if (n.additionalProperties === undefined || n.additionalProperties === true) n.additionalProperties = false;
      const names = Object.keys(n.properties as Json);
      const req = Array.isArray(n.required) ? (n.required as unknown[]).filter((r): r is string => typeof r === "string" && names.includes(r)) : [];
      n.required = req;
    }

    // Recurse into every schema-bearing slot.
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (key === "properties" && isObj(v)) {
        const props: Json = {};
        for (const [pk, pv] of Object.entries(v)) props[pk] = walk(pv, stack);
        n.properties = props;
      } else if (key === "items" || key === "additionalProperties" || key === "contains") {
        if (isObj(v)) n[key] = walk(v, stack);
      } else if ((key === "anyOf" || key === "allOf" || key === "prefixItems") && Array.isArray(v)) {
        n[key] = v.map((x) => walk(x, stack));
      }
    }
    return n;
  };

  const out = walk(root, []) as Json;
  // The definitions were inlined; leaving them is harmless but noisy.
  delete out.definitions;
  delete out.$defs;
  delete out.components;
  if (out.type !== "object" && !Array.isArray(out.type)) out.type = "object";
  return out as unknown as Anthropic.Tool.InputSchema;
}

/**
 * What would still 400 under strict: every finding names its path, so a failing tool is a line
 * to read, not a request to bisect. Empty = strict-safe.
 */
export function strictProblems(schema: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`));
      return;
    }
    if (!isObj(node) || seen.has(node)) return;
    seen.add(node);
    const n = node;
    if (typeof n.$ref === "string") out.push(`${path}: $ref ${n.$ref} left in place (recursive or external — strict mode rejects both)`);
    if ("nullable" in n) out.push(`${path}: nullable is an openApi3 word; strict needs a null union`);
    if ("oneOf" in n) out.push(`${path}: oneOf is not supported; use anyOf`);
    for (const k of CONSTRAINT_KEYS) if (k in n) out.push(`${path}: ${k} is not supported in strict mode`);
    if (typeof n.minItems === "number" && n.minItems !== 0 && n.minItems !== 1) out.push(`${path}: minItems ${n.minItems} (only 0 and 1 are supported)`);
    if (typeof n.format === "string" && !STRICT_FORMATS.has(n.format)) out.push(`${path}: format ${n.format} is not supported`);
    if (Array.isArray(n.enum) && n.enum.some((v) => v !== null && typeof v === "object")) out.push(`${path}: enum holds a complex value (primitives only)`);
    if (describesObject(n)) {
      if (n.additionalProperties !== false) {
        out.push(
          isObj(n.additionalProperties)
            ? `${path}: additionalProperties is a schema (an open map); strict cannot express it — name the keys as properties`
            : `${path}: additionalProperties must be false`,
        );
      }
      const names = isObj(n.properties) ? Object.keys(n.properties) : [];
      if (!Array.isArray(n.required)) out.push(`${path}: required is missing`);
      else for (const r of n.required as unknown[]) if (!names.includes(String(r))) out.push(`${path}: required names ${String(r)}, which is not a property`);
    } else if (n.type === undefined && !("enum" in n) && !("const" in n) && !Array.isArray(n.anyOf) && !Array.isArray(n.allOf)) {
      out.push(`${path}: no type (and no enum, const, anyOf or allOf)`);
    }
    if (isObj(n.properties)) for (const [k, v] of Object.entries(n.properties)) walk(v, `${path}.${k}`);
    if (isObj(n.items)) walk(n.items, `${path}[]`);
    // An open map's value schema is not walked: the map itself is the one problem to name.
    for (const key of ["anyOf", "allOf", "prefixItems"] as const) if (Array.isArray(n[key])) (n[key] as unknown[]).forEach((x, i) => walk(x, `${path}.${key}[${i}]`));
  };
  walk(schema, "input_schema");
  return out;
}

export type StrictBudget = {
  /** Tools marked strict. */
  strict: number;
  /** Parameters (at every depth) not named in their object's `required`. */
  optional: number;
  /** Parameters with anyOf or a type array. */
  unions: number;
  /** Which limits the set exceeds, in words; empty = within budget. */
  over: string[];
};

/** Count one schema's optional and union parameters the way the limits table counts them. */
function countSchema(schema: unknown): { optional: number; unions: number } {
  let optional = 0;
  let unions = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isObj(node)) return;
    if (isObj(node.properties)) {
      const req = Array.isArray(node.required) ? (node.required as unknown[]).map(String) : [];
      for (const [k, v] of Object.entries(node.properties)) {
        if (!req.includes(k)) optional++;
        if (isObj(v) && (Array.isArray(v.anyOf) || Array.isArray(v.type))) unions++;
        walk(v);
      }
    }
    if (isObj(node.items)) walk(node.items);
    for (const key of ["anyOf", "allOf", "prefixItems"] as const) if (Array.isArray(node[key])) walk(node[key]);
  };
  walk(schema);
  return { optional, unions };
}

/** The budget a set of tools would spend if every one of them were strict. */
export function strictBudgetOf(tools: ReadonlyArray<{ name: string; input_schema?: unknown }>): StrictBudget {
  let optional = 0;
  let unions = 0;
  for (const t of tools) {
    const c = countSchema(t.input_schema);
    optional += c.optional;
    unions += c.unions;
  }
  const over: string[] = [];
  if (tools.length > STRICT_LIMITS.tools) over.push(`${tools.length} strict tools (limit ${STRICT_LIMITS.tools})`);
  if (optional > STRICT_LIMITS.optional) over.push(`${optional} optional parameters (limit ${STRICT_LIMITS.optional})`);
  if (unions > STRICT_LIMITS.unions) over.push(`${unions} union-typed parameters (limit ${STRICT_LIMITS.unions})`);
  return { strict: tools.length, optional, unions, over };
}

type ToolLike = { name: string; input_schema: unknown; strict?: boolean };

/**
 * The tool with `strict: true` and its sanitised schema — or the tool exactly as it came when
 * the sanitised schema still has a problem (an open map, a recursive $ref). Never throws.
 */
export function strictTool<T extends ToolLike>(tool: T): T {
  const schema = toStrictSchema(tool.input_schema);
  if (strictProblems(schema).length) return tool;
  return { ...tool, input_schema: schema, strict: true };
}

/**
 * A request's strict set: tools marked strict in order while the per-request budget holds, the
 * rest left as they are, and `skipped` saying which and why. Put the tools whose arguments
 * matter most first.
 */
export function strictTools<T extends ToolLike>(tools: ReadonlyArray<T>): { tools: T[]; skipped: Array<{ name: string; why: string }> } {
  const out: T[] = [];
  const skipped: Array<{ name: string; why: string }> = [];
  const chosen: T[] = [];
  for (const t of tools) {
    const schema = toStrictSchema(t.input_schema);
    const problems = strictProblems(schema);
    if (problems.length) {
      skipped.push({ name: t.name, why: problems[0] });
      out.push(t);
      continue;
    }
    const candidate = { ...t, input_schema: schema, strict: true };
    const budget = strictBudgetOf([...chosen, candidate]);
    if (budget.over.length) {
      skipped.push({ name: t.name, why: `over budget: ${budget.over.join("; ")}` });
      out.push(t);
      continue;
    }
    chosen.push(candidate);
    out.push(candidate);
  }
  return { tools: out, skipped };
}
