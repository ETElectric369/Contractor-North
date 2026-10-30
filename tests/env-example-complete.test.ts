import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * EVERY ENVIRONMENT NAME THE CODE READS IS IN .env.example (cn-v1139, Scout K). A name read by the
 * code and listed nowhere is a setting the next deploy forgets; the file is the one list, grouped
 * by who issues the value, one line of why each. It holds NAMES and placeholders only: a value
 * shaped like a key or a token is refused here, whoever pasted it.
 *
 * Read: `process.env.NAME` and `const { A, B } = process.env` across src, scripts, next.config.ts
 * and capacitor.config.ts, plus the few names a file reads through a COMPUTED key (`process.env[key]`
 * with the name assembled at runtime), which no regex can see: DYNAMIC_NAMES says which file reads
 * which, and the scan refuses a table row whose file no longer reads a computed key. The app's code
 * must be complete here; a test suite's own switch (a one-off *_APPLY_0341 gate, a *_REPLAY toggle)
 * is documented at the top of its suite and need not be, though the shared ones (the test database's
 * connection, CI) are listed and a listed name may be read by a suite.
 *
 * Listed: `NAME=` (a value to type), or `# NAME — …` (a name the platform sets for the process, kept
 * as a comment so a copy of this file never sets it by hand; it counts as listed, with no value).
 */
/** Names read through a computed key, by the file that reads them (lib/plans priceIdFor: STRIPE_PRICE_<TIER>_<CADENCE>). */
export const DYNAMIC_NAMES: Record<string, string[]> = {
  "src/lib/plans.ts": [
    "STRIPE_PRICE_HANDYMAN_MONTHLY",
    "STRIPE_PRICE_HANDYMAN_ANNUAL",
    "STRIPE_PRICE_CREW_MONTHLY",
    "STRIPE_PRICE_CREW_ANNUAL",
    "STRIPE_PRICE_COMPANY_MONTHLY",
    "STRIPE_PRICE_COMPANY_ANNUAL",
  ],
};
const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

/** A test file or a database suite: its switches are its own. */
const isSuite = (f: string) => /\.(test\.tsx?|db-suite\.ts)$/.test(f);

/** The names the code reads, each with one file that reads it; `suites` includes the test files. */
export function envNamesRead(suites: boolean): Map<string, string> {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts")), join(ROOT, "next.config.ts"), join(ROOT, "capacitor.config.ts")].filter(
    (f) => suites || !isSuite(f),
  );
  const names = new Map<string, string>();
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const rel = relative(ROOT, f);
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\b/g)) if (!names.has(m[1])) names.set(m[1], rel);
    for (const m of text.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g)) if (!names.has(m[1])) names.set(m[1], rel);
    for (const m of text.matchAll(/const \{([^}]+)\} = process\.env\b/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.split(":")[0].split("=")[0].trim();
        if (/^[A-Z][A-Z0-9_]*$/.test(name) && !names.has(name)) names.set(name, rel);
      }
    }
    // A computed key: the table names what the file assembles; a row whose file reads no computed key is stale.
    const dynamic = DYNAMIC_NAMES[rel];
    if (dynamic) {
      if (!/process\.env\[(?!["'])/.test(text)) throw new Error(`DYNAMIC_NAMES names ${rel}, which reads no computed process.env[key]`);
      for (const name of dynamic) if (!names.has(name)) names.set(name, `${rel} (computed key)`);
    }
  }
  return names;
}

/** The names .env.example lists, with their placeholder values: `NAME=value`, or `# NAME — why` for a platform-set name (no value). */
export function envNamesListed(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(join(ROOT, ".env.example"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out.set(m[1], m[2].trim());
    const c = line.match(/^# ([A-Z][A-Z0-9_]*) — /);
    if (c && !out.has(c[1])) out.set(c[1], "");
  }
  return out;
}

/** The platform-set names: listed as a comment, so nobody types them, and the line itself says so. */
export const PLATFORM_SET = ["NODE_ENV", "VERCEL", "CI", "VERCEL_ENV", "AWS_LAMBDA_JS_RUNTIME", "VERCEL_DEPLOYMENT_ID"];

/** A value that is not a placeholder: a vendor's key prefix, a PEM block, a JWT, or a long token-shaped string. */
export const looksLikeASecret = (v: string) =>
  /^(sk|pk|rk|whsec|sk_live|sk_test|AKIA|xox[abp]|ghp|AIza|SG\.)[-_A-Za-z0-9]/.test(v) ||
  /-----BEGIN/.test(v) ||
  /^eyJ[A-Za-z0-9_-]{10,}\./.test(v) ||
  /^[A-Za-z0-9+/_-]{32,}={0,2}$/.test(v) ||
  /:\/\/[^/\s]*:[^@\s]+@/.test(v);

/** The real count of names the app's code reads and the file lists at cn-v1140 (the six tier prices, the optional Extra usage price and the six platform-set names in); raise it as names land. */
export const NAMES_FLOOR = 83;

describe(".env.example", () => {
  const read = envNamesRead(false);
  const readAnywhere = envNamesRead(true);
  const listed = envNamesListed();

  it("the scan read a real number of names (the floor keeps it honest)", () => {
    expect(read.size).toBeGreaterThanOrEqual(NAMES_FLOOR);
    expect(listed.size).toBeGreaterThanOrEqual(NAMES_FLOOR);
    // The scanner sees both shapes: a dotted read and a destructured one (the replay suites' connection
    // is destructured; the test database's names are not spelled here, tests/db-guard.test.ts owns them).
    expect(read.get("NEXT_PUBLIC_SUPABASE_URL")).toBeDefined();
    expect(readAnywhere.get("REPLAY_DBPW")).toBeDefined();
    expect(read.get("REPLAY_DBPW")).toBeUndefined();
    // The computed key: lib/plans assembles STRIPE_PRICE_<TIER>_<CADENCE>; the table makes the six visible to the scan.
    for (const n of DYNAMIC_NAMES["src/lib/plans.ts"]) expect(read.get(n), n).toBe("src/lib/plans.ts (computed key)");
    expect(readFileSync(join(ROOT, "src/lib/plans.ts"), "utf8")).toContain("return process.env[key] || null;");
  });

  it("the platform-set names are listed as comments (`# NAME — set by the platform, never by hand`), never as a blank assignment a copy would set", () => {
    const text = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const n of PLATFORM_SET) {
      expect(listed.has(n), n).toBe(true);
      expect(text, `${n} is a bare assignment`).not.toMatch(new RegExp(`^${n}=`, "m"));
      expect(text).toMatch(new RegExp(`^# ${n} — set by the platform, never by hand`, "m"));
    }
    // The rule itself: a commented name counts, an ordinary comment does not.
    expect([...listed.entries()].filter(([, v]) => v === "").map(([n]) => n)).toEqual(expect.arrayContaining(PLATFORM_SET));
    expect(listed.has("Set")).toBe(false);
  });

  it("every name the app's code reads is listed", () => {
    const missing = [...read.entries()].filter(([n]) => !listed.has(n)).map(([n, f]) => `${n} (read in ${f})`);
    expect(missing, "add each to .env.example under its issuer, with one line of why").toEqual([]);
  });

  it("every name listed is read somewhere — the app, a script, or a suite (a stale line is a setting nothing honours)", () => {
    const stale = [...listed.keys()].filter((n) => !readAnywhere.has(n));
    expect(stale).toEqual([]);
  });

  it("holds placeholders only — nothing shaped like a key, a token, a PEM block or a password in a URL", () => {
    const secrets = [...listed.entries()].filter(([, v]) => looksLikeASecret(v)).map(([n]) => n);
    expect(secrets).toEqual([]);
    for (const [n, v] of listed) expect(v.length, `${n}'s value is long enough to be a real one`).toBeLessThanOrEqual(60);
    // The rule itself.
    expect(looksLikeASecret("")).toBe(false);
    expect(looksLikeASecret("...")).toBe(false);
    expect(looksLikeASecret("http://localhost:3000")).toBe(false);
    expect(looksLikeASecret("production")).toBe(false);
    expect(looksLikeASecret("sk_live_abcdefghijklmnop")).toBe(true);
    expect(looksLikeASecret("whsec_abcdefghijklmnop")).toBe(true);
    expect(looksLikeASecret("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(looksLikeASecret("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x")).toBe(true);
    expect(looksLikeASecret("postgres://user:hunter2@host/db")).toBe(true);
    expect(looksLikeASecret("A".repeat(40))).toBe(true);
  });

  it("every name has a line of why above it (a comment on the line before, or on the group's heading within three lines)", () => {
    const lines = readFileSync(join(ROOT, ".env.example"), "utf8").split("\n");
    const bare: string[] = [];
    lines.forEach((line, i) => {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
      if (!m) return;
      const above = lines.slice(Math.max(0, i - 3), i);
      if (!above.some((l) => l.startsWith("#"))) bare.push(m[1]);
    });
    expect(bare).toEqual([]);
  });
});
