import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * NO PROMISE THE APP DOESN'T KEEP (Wave 0). Compliance and Insurance promised "renewal alerts so
 * nothing lapses", and nothing reads an expiry to warn anyone: no Needs You kind, no cron, no push.
 * The pages show the dates; they don't claim an alert. When a real alert ships, this test goes.
 */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx|ts)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("the app never promises a renewal alert", () => {
  it("no screen says it", () => {
    const root = process.cwd();
    const hits = files(join(root, "src/app"))
      .filter((f) => /renewal (alert|reminder)s?/i.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });
});
