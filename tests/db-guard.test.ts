import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { assertTestDatabase, notOnThisDatabase, TEST_DB_MARKER, TEST_DB_USER_NAME } from "@/lib/db-guard";

/**
 * Every database suite calls THE ONE DB GUARD (src/lib/db-guard.ts) right after it connects.
 *
 * The suites write inside rolled-back transactions. For months TEST_DB_* pointed at production, so
 * they wrote there. The guard refuses anything but the test database (its user and its marker row).
 * This proves, by reading the files, that no suite can reach a database without it:
 *   - a file that imports "pg" in src/ or tests/ is a DB suite or a production replay, nothing else;
 *   - a DB suite: every `await X.connect();` is followed, on the next line, by
 *     `await assertTestDatabase(X);`;
 *   - a *.db-suite.ts never connects itself: its caller (a guarded *.integration.test.ts) does;
 *   - a production replay (*.prod-replay.test.ts) never reads TEST_DB_*, is skipped in CI, calls
 *     assertReadOnlyReplay right after every connect, and opens every transaction READ ONLY.
 */
const root = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [...walk(path.join(root, "src")), ...walk(path.join(root, "tests"))].map((f) => ({
  rel: path.relative(root, f),
  text: fs.readFileSync(f, "utf8"),
}));
const importsPg = (t: string) => /from\s+["']pg["']|require\(\s*["']pg["']\s*\)/.test(t);
const isReplay = (rel: string) => rel.endsWith(".prod-replay.test.ts");
const connects = (t: string) => [...t.matchAll(/^(\s*)await (\w+)\.connect\(\);\n(.*)$/gm)];

describe("THE ONE DB GUARD: every DB suite calls it right after it connects", () => {
  const suites = files.filter((f) => importsPg(f.text) && !isReplay(f.rel));
  const replays = files.filter((f) => isReplay(f.rel));

  it("finds the suites (so an empty glob can never pass)", () => {
    expect(suites.length).toBeGreaterThan(20);
    expect(suites.every((f) => f.rel.endsWith(".integration.test.ts"))).toBe(true);
  });

  it("every connect in a DB suite is followed by assertTestDatabase on the same client", () => {
    const bad: string[] = [];
    for (const f of suites) {
      const found = connects(f.text);
      if (!found.length) bad.push(`${f.rel}: imports pg but has no \`await X.connect();\` this test can see`);
      if ((f.text.match(/\.connect\(/g) ?? []).length !== found.length) bad.push(`${f.rel}: a connect() this test cannot check`);
      for (const m of found) {
        if (m[3].trim() !== `await assertTestDatabase(${m[2]});`) bad.push(`${f.rel}: ${m[2]}.connect() is followed by "${m[3].trim()}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("anything that reads TEST_DB_* is a guarded suite (or this harness)", () => {
    const harness = new Set(["tests/ci-guard.test.ts", "tests/db-guard.test.ts", "src/lib/db-guard.ts"]);
    const readers = files.filter((f) => /TEST_DB_HOST|TEST_DB_USER|TEST_DBPW/.test(f.text) && !harness.has(f.rel));
    const unguarded = readers.filter((f) => !suites.includes(f)).map((f) => f.rel);
    expect(unguarded).toEqual([]);
  });

  it("a *.db-suite.ts never connects on its own", () => {
    const own = files.filter((f) => f.rel.endsWith(".db-suite.ts") && (importsPg(f.text) || /\.connect\(/.test(f.text))).map((f) => f.rel);
    expect(own).toEqual([]);
  });

  it("a production replay is read-only, opt-in, never in CI, and never on TEST_DB_*", () => {
    const bad: string[] = [];
    for (const f of replays) {
      if (/TEST_DB_HOST|TEST_DB_USER|TEST_DBPW/.test(f.text)) bad.push(`${f.rel}: reads TEST_DB_*`);
      if (!/!process\.env\.CI \? describe : describe\.skip/.test(f.text)) bad.push(`${f.rel}: not skipped in CI`);
      const found = connects(f.text);
      if (!found.length) bad.push(`${f.rel}: no connect this test can see`);
      for (const m of found) if (m[3].trim() !== `await assertReadOnlyReplay(${m[2]});`) bad.push(`${f.rel}: ${m[2]}.connect() is not followed by assertReadOnlyReplay`);
      for (const b of f.text.matchAll(/query\(\s*["'`]\s*(begin|start transaction)[^"'`]*["'`]/gi)) {
        if (!/read only/i.test(b[0])) bad.push(`${f.rel}: ${b[0]} is not READ ONLY`);
      }
    }
    expect(replays.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

describe("assertTestDatabase throws, never skips", () => {
  const fake = (user: string | undefined, marker: string[] | null) => ({
    user,
    query: async (sql: string) =>
      /to_regclass/.test(sql) ? { rows: [{ ok: marker !== null }] } : { rows: (marker ?? []).map((value) => ({ value })) },
  });
  it("refuses another project's user (production's included) before it asks the database anything", async () => {
    await expect(assertTestDatabase(fake("postgres.rbpokaozcxqownollqlx", ["contractor-north-test"]))).rejects.toThrow(/not the test database's user/);
    await expect(assertTestDatabase(fake(undefined, ["contractor-north-test"]))).rejects.toThrow(/not the test database's user/);
  });
  it("refuses a database without exactly one contractor-north-test marker row", async () => {
    await expect(assertTestDatabase(fake(TEST_DB_USER_NAME, null))).rejects.toThrow(/no marker table/);
    await expect(assertTestDatabase(fake(TEST_DB_USER_NAME, []))).rejects.toThrow(/0 row/);
    await expect(assertTestDatabase(fake(TEST_DB_USER_NAME, ["contractor-north-test", "contractor-north-test"]))).rejects.toThrow(/2 row/);
    await expect(assertTestDatabase(fake(TEST_DB_USER_NAME, ["something-else"]))).rejects.toThrow(/not the test database/);
  });
  it("passes the test database", async () => {
    await expect(assertTestDatabase(fake(TEST_DB_USER_NAME, ["contractor-north-test"]))).resolves.toBeUndefined();
  });
});

describe("CI runs the same check before npm test", () => {
  it("scripts/test-db/check-test-db.cjs carries the guard's user and marker, and ci.yml runs it before the Test step", () => {
    const script = fs.readFileSync(path.join(root, "scripts/test-db/check-test-db.cjs"), "utf8");
    expect(script).toContain(`const TEST_DB_USER_NAME = "${TEST_DB_USER_NAME}";`);
    expect(script).toContain(`const TEST_DB_MARKER = "${TEST_DB_MARKER}";`);
    expect(script).toContain("TEST_DB_* point at a database without the contractor-north-test marker - repoint the GitHub secrets at the test project");
    const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const check = ci.indexOf("run: node scripts/test-db/check-test-db.cjs");
    const test = ci.indexOf("run: npm test");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(test);
  });
});

/**
 * NO DB SUITE GOES GREEN WITHOUT RUNNING (audit v1018, class 10). Three stock suites needed an extra
 * STOCK_*_DB=1 flag nothing in CI set, so 10 cases were describe.skip on every push; and a case whose
 * migration was missing returned early, counted as passed, and only warned.
 */
describe("every DB suite runs in CI", () => {
  const suites = files.filter((f) => f.rel.endsWith(".integration.test.ts"));
  const dbFiles = files.filter((f) => f.rel.endsWith(".integration.test.ts") || f.rel.endsWith(".db-suite.ts"));
  const GATE = "const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;";

  it("each suite's one gate is the TEST_DB_* creds and nothing else (no extra opt-in flag)", () => {
    const bad: string[] = [];
    for (const f of suites) {
      const skips = f.text.match(/describe\.skip/g) ?? [];
      if (!f.text.includes(GATE)) bad.push(`${f.rel}: its gate is not "${GATE}"`);
      if (skips.length !== 1) bad.push(`${f.rel}: ${skips.length} describe.skip (only the one gate may skip)`);
      if (/\b(it|test|describe)\.(skipIf|runIf)\(/.test(f.text)) bad.push(`${f.rel}: a skipIf/runIf gate`);
    }
    expect(suites.length).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });

  it("a case whose migration is missing goes through notOnThisDatabase, never a bare warning", () => {
    const bad: string[] = [];
    for (const f of dbFiles) {
      for (const m of f.text.matchAll(/console\.warn\(([^\n]*)/g)) {
        if (/applied inside/.test(m[1])) continue; // the migration was applied in the test's transaction: the case runs
        if (/not on this database|are not here|nothing to (test|check|exercise)|nothing was exercised/.test(m[1])) bad.push(`${f.rel}: ${m[0].slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("notOnThisDatabase warns on the Mac and throws in CI", () => {
    const was = process.env.CI;
    try {
      delete process.env.CI;
      const warn = console.warn;
      const said: unknown[] = [];
      console.warn = (m: unknown) => void said.push(m);
      try {
        expect(notOnThisDatabase("[x] 0999 is not on this database yet.")).toBe(false);
      } finally {
        console.warn = warn;
      }
      expect(said).toEqual(["[x] 0999 is not on this database yet."]);
      process.env.CI = "true";
      expect(() => notOnThisDatabase("[x] 0999 is not on this database yet.")).toThrow(/0999 is not on this database yet\. In CI the test database carries every migration/);
    } finally {
      if (was === undefined) delete process.env.CI;
      else process.env.CI = was;
    }
  });
});

describe("CI refuses a test database that is behind supabase/migrations", () => {
  const req = createRequire(import.meta.url);
  const { stepsOnDisk, ledgerBehind } = req("../scripts/test-db/steps.cjs") as {
    stepsOnDisk: () => { name: string; kind: string; md5: string }[];
    ledgerBehind: (s: { name: string; md5: string }[], r: Map<string, string | null>) => { missing: string[]; changed: string[] };
  };
  const steps = stepsOnDisk();

  it("the steps are every file in supabase/migrations, in order, plus the test-db shims", () => {
    const onDisk = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(steps.filter((s) => s.kind === "migration").map((s) => s.name)).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThan(300);
  });

  it("names each migration the database never recorded, and each one edited since", () => {
    const all = new Map<string, string | null>(steps.map((s) => [s.name, s.md5]));
    expect(ledgerBehind(steps, all)).toEqual({ missing: [], changed: [] });

    const last = steps.filter((s) => s.kind === "migration").at(-1)!;
    const behind = new Map(all);
    behind.delete(last.name); // 0346 applied by hand, never recorded (the audit's case)
    expect(ledgerBehind(steps, behind)).toEqual({ missing: [last.name], changed: [] });

    const edited = new Map(all);
    edited.set(last.name, "0".repeat(32));
    expect(ledgerBehind(steps, edited)).toEqual({ missing: [], changed: [last.name] });

    // A checksum from before checksums existed is not judged; another branch's extra row is not ours.
    const old = new Map(all);
    old.set(last.name, null);
    old.set("9999_another_branch.sql", "x");
    expect(ledgerBehind(steps, old)).toEqual({ missing: [], changed: [] });
  });

  it("check-test-db.cjs reads the ledger with the same steps and says how to fix it", () => {
    const script = fs.readFileSync(path.join(root, "scripts/test-db/check-test-db.cjs"), "utf8");
    expect(script).toContain('require("./steps.cjs")');
    expect(script).toContain("ledgerBehind(");
    expect(script).toContain("the test database is behind: run node scripts/test-db/rebuild.cjs");
    const rebuild = fs.readFileSync(path.join(root, "scripts/test-db/rebuild.cjs"), "utf8");
    expect(rebuild).toContain('require("./steps.cjs")');
    expect(rebuild).not.toMatch(/function stepsOnDisk/);
  });
});
