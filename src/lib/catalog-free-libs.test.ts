import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * THE LIBS A CUSTOMER'S PAGE LOADS CARRY NO DICTIONARY (cn-v1138, Fixer A's finding). lib/i18n
 * statically imports every catalog (~218 KB of a tech's words). lib/stock-take, lib/statuses and
 * lib/job-status are reached from the customer's portal, invoice and estimate pages (portal/[token]/jobs
 * → lib/portal/job-view → lib/unbilled-work → lib/stock-billing → stock-take; i/[token] →
 * lib/invoice-document-props → lib/job-financials → the same; q/[token] → lib/appointments/behind-quote
 * → statuses), so a helper in them that speaks to a person takes the CALLER's translator and its
 * English default is a local map — never an import of lib/i18n or lib/words. This test walks the
 * imports from every route outside (app) and api, the way a bundler would, and says which libs a
 * stranger's page reaches; the catalog-free rule is pinned on those, and the libs that keep lib/i18n
 * (long-shift, materials-stock, voice-failure) are proven unreached, so the day one of them is pulled
 * onto a customer page this fails instead of the bundle growing in silence.
 */
const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const read = (p: string) => readFileSync(p, "utf8");

const CATALOG_FREE = ["src/lib/stock-take.ts", "src/lib/statuses.ts", "src/lib/job-status.ts", "src/lib/locale.ts", "src/lib/utils.ts", "src/app/error.tsx", "src/app/error-words.ts"];
// The crew's own offline page is the one public entry whose CLIENT bundle may carry the dictionary: it
// is precached by the service worker for a signed-in tech, and no customer is ever sent there.
const CLIENT_MAY_CARRY = ["app/offline/page.tsx"];
const KEEP_THE_DICTIONARY = ["src/lib/long-shift.ts", "src/lib/materials-stock.ts", "src/lib/voice-failure.ts"];

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const e of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = base + e;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}
function importsOf(file: string): string[] {
  const s = read(file);
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const r = resolveSpec(file, m[1] || m[2] || m[3]);
    if (r) out.push(r);
  }
  return out;
}
function routes(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) routes(p, acc);
    else if (/^(page|layout|route|template|error|global-error|not-found|loading)\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const memo = new Map<string, Set<string>>();
function reach(file: string, seen = new Set<string>()): Set<string> {
  const had = memo.get(file);
  if (had) return had;
  seen.add(file);
  const set = new Set<string>();
  for (const d of importsOf(file)) {
    set.add(d);
    if (!seen.has(d)) for (const x of reach(d, seen)) set.add(x);
  }
  memo.set(file, set);
  return set;
}

const isClient = (f: string) => /^\s*["']use client["']/.test(read(f));
/** The first import chain from `entry` to `target` that crosses a "use client" file, else null. */
function clientChainTo(entry: string, target: string): string[] | null {
  const queue: Array<[string, string[], boolean]> = [[entry, [entry], isClient(entry)]];
  const seen = new Set([entry]);
  while (queue.length) {
    const [f, p, client] = queue.shift()!;
    if (f === target && client) return p;
    for (const d of importsOf(f)) {
      if (seen.has(d)) continue;
      seen.add(d);
      queue.push([d, [...p, d], client || isClient(d)]);
    }
  }
  return null;
}

describe("the libs a customer's page reaches", () => {
  const publicRoutes = routes(join(SRC, "app")).filter((p) => !p.includes("/app/(app)/") && !p.includes("/app/api/"));
  const reachedBy = (lib: string) => publicRoutes.filter((r) => reach(r).has(join(ROOT, lib))).map((r) => relative(SRC, r));

  it("walks a real set of public routes", () => {
    expect(publicRoutes.length).toBeGreaterThanOrEqual(20);
  });

  it("stock-take, statuses and job-status are on a customer's page, and import neither lib/i18n nor lib/words", () => {
    for (const lib of ["src/lib/stock-take.ts", "src/lib/statuses.ts", "src/lib/job-status.ts"]) expect(reachedBy(lib).length, `${lib} is no longer on a public route — move it to KEEP_THE_DICTIONARY if that is meant`).toBeGreaterThan(0);
    for (const lib of CATALOG_FREE) {
      const s = read(join(ROOT, lib));
      expect(s, lib).not.toMatch(/from\s+["'](@\/lib\/i18n|\.\/i18n|\.\.\/i18n|@\/lib\/words|\.\/words)/);
      expect(s, lib).not.toMatch(/require\(["'][^"']*(i18n|lib\/words)/);
    }
  });

  it("the libs that keep lib/i18n are reached by no public route (so no catalog rides a customer's bundle through them)", () => {
    for (const lib of KEEP_THE_DICTIONARY) expect(reachedBy(lib), lib).toEqual([]);
  });

  it("no public entry's CLIENT bundle carries lib/i18n, except the crew's offline page (the root error boundary rides every customer page)", () => {
    // A server component that imports the dictionary keeps it in the server bundle — a customer
    // downloads nothing. A "use client" file on the chain ships every catalog to the browser.
    const target = join(SRC, "lib/i18n.ts");
    const leaks: string[] = [];
    for (const r of publicRoutes) {
      if (CLIENT_MAY_CARRY.includes(relative(SRC, r))) continue;
      const chain = clientChainTo(r, target);
      if (chain) leaks.push(chain.map((x) => relative(SRC, x)).join(" → "));
    }
    expect(leaks, "a customer's page would download the whole dictionary").toEqual([]);
    expect(publicRoutes.map((r) => relative(SRC, r))).toContain("app/error.tsx");
  });
});
