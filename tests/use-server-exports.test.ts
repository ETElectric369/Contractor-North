import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A "use server" FILE EXPORTS ONLY ASYNC FUNCTIONS (and types). Next's compiler refuses anything
 * else at BUILD time — `export const` of a limit, a label, a filter — and neither tsc nor vitest
 * says a word: the first cn-v1136 deploy (2026-10-28) died on Vercel with "Only async functions
 * are allowed to be exported in a 'use server' file" after a green suite and a clean type check.
 * The same rule as the route-file law (a route exports only handlers and segment config): a shared
 * constant lives in a plain module beside the actions. This scan is the unit suite's copy of the
 * compiler's rule, so the next one fails here, minutes before a build, not after it.
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

/** The directive must be the first statement: a leading comment is allowed, anything else is not a server file. */
const USE_SERVER = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*"use server";/;
/** What the compiler allows after `export`: an async function, or a type (erased, never a runtime export). */
const ALLOWED = /^export\s+(?:async\s+function\b|type\s|interface\s)/;

describe("a \"use server\" file exports only async functions", () => {
  const serverFiles = walk(SRC).filter((f) => USE_SERVER.test(readFileSync(f, "utf8")));

  it("scans a real number of server-action files (the floor keeps the scan honest)", () => {
    expect(serverFiles.length).toBeGreaterThanOrEqual(60);
  });

  it("no constant, class, plain function or re-export leaves a server file", () => {
    const strays: string[] = [];
    for (const f of serverFiles) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^export\s/.test(line) && !ALLOWED.test(line)) strays.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      strays,
      "These lines export something a \"use server\" file may not. Move the value to a plain module beside the actions and import it:\n" + strays.join("\n"),
    ).toEqual([]);
  });
});
