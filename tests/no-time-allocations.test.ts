import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE OLD SPLIT TABLE IS GONE FROM THE APP (0288/0289, Erik 2026-09-24).
 *
 * A split shift is ordinary time entries now. 0289 converted every old time_allocations split into
 * entries, emptied the table and froze it, and 0290 drops it. PostgREST fails the WHOLE query when
 * a select embeds a table that no longer exists, so one leftover `time_allocations(...)` embed would
 * blank a page (the timecards week, a job hub, the invoice import) the day the table goes. This is
 * the gate: no app code may name it.
 *
 * The one exemption is a DB test harness (*.db-suite.ts), which has to name the table to build
 * fixtures for the conversion and to prove the freeze. It is never bundled, and phase 5 (0290)
 * deletes those cases with the table.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const EXEMPT = /\.db-suite\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !EXEMPT.test(name)) out.push(p);
  }
  return out;
}

describe("no app code reads or writes time_allocations", () => {
  it("src/ never names the table (except a DB test harness)", () => {
    const hits = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("time_allocations"))
      .map((f) => path.relative(SRC, f));
    expect(hits, `time_allocations is gone (0289): remove it from ${hits.join(", ")}`).toEqual([]);
  });
});
