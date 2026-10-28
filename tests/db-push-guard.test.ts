import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * db:push RUNS ONLY AGAINST THE TEST DATABASE (cn-v1134). scripts/run-migrations.mjs applies every
 * file in supabase/migrations to whatever SUPABASE_DB_URL in .env.local names; pointed at production
 * it would re-run them all there. It now shares rebuild.cjs's marker guard (scripts/test-db/guard.cjs)
 * and refuses, in words, before it runs anything when the marker is absent. The decision is a pure
 * function over the marker read, proven here without a database; the two scripts are read to prove
 * they both go through it.
 */
const root = path.resolve(__dirname, "..");
const req = createRequire(import.meta.url);
const guard = req("../scripts/test-db/guard.cjs") as {
  MARKER_VALUE: string;
  DB_PUSH_REFUSAL: string;
  markerDecision: (rows: unknown) => { ok: boolean; why: string | null };
  readMarkerRows: (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>;
  checkMarker: (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<{ ok: boolean; why: string | null }>;
};

describe("the marker decision is pure", () => {
  it("passes exactly one 'contractor-north-test' row", () => {
    expect(guard.MARKER_VALUE).toBe("contractor-north-test");
    expect(guard.markerDecision([{ value: "contractor-north-test" }])).toEqual({ ok: true, why: null });
  });

  it("refuses a missing table, no rows, two rows, or another value", () => {
    expect(guard.markerDecision(null)).toEqual({ ok: false, why: "no cn_test_database_marker table" });
    expect(guard.markerDecision(undefined).ok).toBe(false);
    expect(guard.markerDecision([])).toEqual({ ok: false, why: "cn_test_database_marker holds 0 row(s), not one" });
    expect(guard.markerDecision([{ value: "contractor-north-test" }, { value: "contractor-north-test" }]).ok).toBe(false);
    expect(guard.markerDecision([{ value: "production" }])).toEqual({ ok: false, why: "cn_test_database_marker does not hold 'contractor-north-test'" });
    expect(guard.markerDecision([{}]).ok).toBe(false);
    expect(guard.markerDecision("contractor-north-test" as unknown).ok).toBe(false);
  });

  it("the read answers null for a missing table and the rows otherwise, and checkMarker decides on it", async () => {
    const client = (present: boolean, rows: unknown[]) => ({
      query: async (sql: string) => (/to_regclass/.test(sql) ? { rows: [{ present }] } : { rows }),
    });
    expect(await guard.readMarkerRows(client(false, []))).toBeNull();
    expect(await guard.readMarkerRows(client(true, [{ value: "contractor-north-test" }]))).toEqual([{ value: "contractor-north-test" }]);
    expect(await guard.checkMarker(client(true, [{ value: "contractor-north-test" }]))).toEqual({ ok: true, why: null });
    expect((await guard.checkMarker(client(false, []))).ok).toBe(false);
    expect((await guard.checkMarker(client(true, [{ value: "something-else" }]))).ok).toBe(false);
  });
});

describe("db:push refuses in words before it runs anything", () => {
  const script = readFileSync(path.join(root, "scripts/run-migrations.mjs"), "utf8");

  it("says the one way out", () => {
    expect(guard.DB_PUSH_REFUSAL).toBe("db:push runs only against the test database; production migrations go through ~/Developer/db/apply-migration.cjs");
    expect(script).toContain("DB_PUSH_REFUSAL");
    expect(script).toContain('require("./test-db/guard.cjs")');
    expect(script).toContain("createRequire(import.meta.url)");
  });

  it("checks the marker after it connects and before the first migration runs", () => {
    const check = script.indexOf("checkMarker(client)");
    const loop = script.indexOf("for (const f of files)");
    const connect = script.indexOf("await client.connect()");
    expect(connect).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(connect);
    expect(check).toBeLessThan(loop);
    // The refusal exits the process; nothing after it runs.
    const refusal = script.slice(check, loop);
    expect(refusal).toMatch(/process\.exit\(1\)/);
    expect(refusal).toContain("DB_PUSH_REFUSAL");
  });

  it("package.json's db:push is this script", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:push"]).toContain("scripts/run-migrations.mjs");
  });
});

describe("run-one-migration.mjs takes the same guard (cn-v1134 fixer)", () => {
  const script = readFileSync(path.join(root, "scripts/run-one-migration.mjs"), "utf8");

  it("goes through guard.cjs with the same refusal words", () => {
    expect(script).toContain('require("./test-db/guard.cjs")');
    expect(script).toContain("createRequire(import.meta.url)");
    expect(script).toContain("DB_PUSH_REFUSAL");
  });

  it("checks the marker after it connects and before the file runs, and the refusal exits", () => {
    const connect = script.indexOf("await client.connect()");
    const check = script.indexOf("checkMarker(client)");
    const begin = script.indexOf('await client.query("begin")');
    expect(connect).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(connect);
    expect(check).toBeLessThan(begin);
    const refusal = script.slice(check, begin);
    expect(refusal).toMatch(/process\.exit\(1\)/);
    expect(refusal).toContain("DB_PUSH_REFUSAL");
  });
});

describe("rebuild.cjs shares the guard and still says Guard passed", () => {
  const rebuild = readFileSync(path.join(root, "scripts/test-db/rebuild.cjs"), "utf8");

  it("decides with the shared function and prints the same line", () => {
    expect(rebuild).toContain('require("./guard.cjs")');
    expect(rebuild).toContain("markerDecision(");
    expect(rebuild).toMatch(/Guard passed: \$\{TEST_USER\} @ \$\{TEST_HOST\}, marker '\$\{MARKER_VALUE\}'\./);
    // The marker value is the shared one, not a second spelling.
    expect(rebuild).not.toMatch(/const MARKER_VALUE = "/);
  });

  it("check-test-db.cjs still hashes migration files, never scripts (steps.cjs is untouched)", () => {
    const check = readFileSync(path.join(root, "scripts/test-db/check-test-db.cjs"), "utf8");
    expect(check).toContain('require("./steps.cjs")');
    expect(check).not.toContain("guard.cjs");
    const steps = readFileSync(path.join(root, "scripts/test-db/steps.cjs"), "utf8");
    expect(steps).toContain('path.join(root, "supabase", "migrations")');
    expect(steps).not.toMatch(/["']scripts["']|guard\.cjs|run-migrations/);
  });
});
