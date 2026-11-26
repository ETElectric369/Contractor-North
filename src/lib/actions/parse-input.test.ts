import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REGISTRY } from "./registry";
import { toolJsonSchema } from "./agent-tools";
import { missingFieldPaths, parseActionInput } from "./parse-input";

// cn-v1196: zod 4 no longer words an absent field "Required", so without the one parse in
// parse-input.ts the assistant would lose "still need the hours". This pins, for EVERY registry
// action, that the missing list for an empty fragment (and, where an action takes a list of
// objects, for a list with an empty element) is the list zod 3 gave. The expectation is computed
// from the schema's own required keys, not from the parse under test; it was checked once
// against zod 3.25.76 itself, run over the same registry (116 cases, 0 differences).

type Js = { required?: string[]; properties?: Record<string, { items?: { properties?: unknown; required?: string[] } }> };

/** What zod 3 named as missing, from the schema's own required keys. */
function expectedMissing(js: Js, input: Record<string, unknown[] | undefined>): string[] {
  const out = (js.required ?? []).filter((k) => !(k in input));
  for (const [k, list] of Object.entries(input)) {
    for (const [i, el] of (list ?? []).entries()) {
      for (const r of js.properties?.[k]?.items?.required ?? []) if (!(r in (el as object))) out.push(`${k}.${i}.${r}`);
    }
  }
  return out;
}

/** The one action whose empty fragment is answered by its own superRefine, not by its keys:
 *  time.addEntry takes EITHER clock_in + clock_out OR work_date + hours, so neither is a required
 *  key, and its refine names the first shape's two halves "Required" (as zod 3 gave). */
const REFINED: Record<string, string[]> = { "time.addEntry": ["clock_in", "clock_out"] };

function missingFor(name: string, input: unknown): string[] {
  const r = parseActionInput(REGISTRY[name].input, input);
  return r.success ? [] : missingFieldPaths(r.error);
}

describe("an absent field is still named, for every registry action", () => {
  const names = Object.keys(REGISTRY).sort();

  it("the registry is all here", () => {
    expect(names.length).toBeGreaterThan(100);
  });

  it("an empty fragment names exactly the action's required fields, in order", () => {
    const wrong: string[] = [];
    let named = 0;
    for (const name of names) {
      const want = REFINED[name] ?? expectedMissing(toolJsonSchema(REGISTRY[name].input) as Js, {});
      const got = missingFor(name, {});
      if (got.length) named++;
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${name}: got [${got}], zod 3 gave [${want}]`);
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
    expect(named).toBeGreaterThanOrEqual(100); // 100 of 106 actions take a required field (cn-v1196)
  });

  it("a list of objects with an empty element names each nested field by its path", () => {
    const wrong: string[] = [];
    let cases = 0;
    for (const name of names) {
      const js = toolJsonSchema(REGISTRY[name].input) as Js;
      for (const [k, p] of Object.entries(js.properties ?? {})) {
        if (!p.items?.properties) continue;
        for (const input of [{ [k]: [{}] }, { [k]: [{}, { probe: 1 }] }]) {
          cases++;
          const want = expectedMissing(js, input);
          const got = missingFor(name, input);
          if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${name} ${JSON.stringify(input)}: got [${got}], zod 3 gave [${want}]`);
        }
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
    expect(cases).toBeGreaterThanOrEqual(10);
  });

  it("a missing enum is named (zod 4 calls it invalid_value, zod 3 called it missing)", () => {
    expect(missingFor("quote.setType", {})).toEqual(["id", "doc_type"]);
    expect(missingFor("appointment.setOutcome", {})).toEqual(["id", "outcome"]);
  });

  it("an id with its own words is still named missing when absent, and keeps its words when malformed", () => {
    expect(missingFor("memory.forget", {})).toEqual(["id"]);
    const bad = parseActionInput(REGISTRY["memory.forget"].input, { id: "not-an-id" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(missingFieldPaths(bad.error)).toEqual([]);
      expect(bad.error.issues[0]?.message).toBe("Which fact? Use memory.list to get its id.");
    }
  });

  it("only ABSENT reads Required: a wrong value, a missing literal and a missing union keep zod's own words", () => {
    const s = z.object({ a: z.string(), b: z.literal(1), c: z.union([z.string(), z.number()]), d: z.enum(["x"]) });
    const r = parseActionInput(s, { a: 3 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const by = Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
      expect(by.a).toBe("Invalid input: expected string, received number");
      expect(by.b).not.toBe("Required");
      expect(by.c).not.toBe("Required");
      expect(by.d).toBe("Required");
      expect(missingFieldPaths(r.error)).toEqual(["d"]);
    }
  });
});

// cn-v1196: zod 4's .uuid() enforces the RFC version and variant; zod 3's did not. Every id in
// the source is z.guid() now, which accepts exactly what zod 3 accepted: any 8-4-4-4-12 hex shape.
describe("ids are accepted exactly as before", () => {
  const ANY_SHAPE = "00000000-0000-0000-0000-000000000001";
  const ok = (name: string, input: unknown) => parseActionInput(REGISTRY[name].input, input).success;

  it("each kind of id site takes any 8-4-4-4-12 shape and refuses a non-id", () => {
    // a plain id, an id with its own words, and a nullable optional id
    expect(ok("time.splitEntry", { entry_id: ANY_SHAPE, at: "2026-11-20T15:00", job_code: "Shop" })).toBe(true);
    expect(ok("time.splitEntry", { entry_id: "J-901", at: "2026-11-20T15:00", job_code: "Shop" })).toBe(false);
    expect(ok("memory.forget", { id: ANY_SHAPE })).toBe(true);
    expect(ok("memory.forget", { id: "Larkspur" })).toBe(false);
    expect(ok("time.fixEntry", { entry_id: ANY_SHAPE, job_id: ANY_SHAPE, lunch_minutes: 30 })).toBe(true);
    expect(ok("time.fixEntry", { entry_id: ANY_SHAPE, job_id: null, lunch_minutes: 30 })).toBe(true);
    expect(ok("time.fixEntry", { entry_id: ANY_SHAPE, job_id: "J-902", lunch_minutes: 30 })).toBe(false);
  });

  it("no .uuid() is left in the app's source", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|db-suite|integration\.test|prod-replay\.test)\.tsx?$/.test(e.name)) {
          fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/\.uuid\(/.test(line)) hits.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
