import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE OLD SPLIT TABLE IS GONE FROM THE APP (0288/0289, Erik 2026-09-24).
 *
 * A split shift is ordinary time entries now. 0289 converted every old time_allocations split into
 * entries, emptied the table and froze it, and 0290 dropped it. PostgREST fails the WHOLE query when
 * a select embeds a table that no longer exists, so one leftover `time_allocations(...)` embed would
 * blank a page (the timecards week, a job hub, the invoice import) the day the table goes. This is
 * the gate: no app code may name it.
 *
 * There is no exemption any more. The DB test harness (*.db-suite.ts) named the table while it
 * built fixtures for the conversion and proved the freeze; 0290 dropped the table and those cases
 * went with it, so a test file naming it now would be testing something that cannot exist.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("no app code reads or writes time_allocations", () => {
  it("src/ never names the table, tests included", () => {
    const hits = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("time_allocations"))
      .map((f) => path.relative(SRC, f));
    expect(hits, `time_allocations is gone (0290): remove it from ${hits.join(", ")}`).toEqual([]);
  });
});
