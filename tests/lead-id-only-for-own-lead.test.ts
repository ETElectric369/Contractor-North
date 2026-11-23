import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A LEAD ID LEAVES THE SERVER ONLY FOR A LEAD THAT SAME CALL CREATED (cn-v1185, skeptic #87 S1).
 * createTriagedInquiry comes back to an open lead found by a TYPED phone or e-mail, and anyone can
 * type somebody's phone. So every file under src/app that calls it AND hands back a `leadId` must read
 * the create's `cameBack`. The partner webhook (a keyed partner) and the site chat return no leadId.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

describe("every public door that hands back a lead id reads cameBack", () => {
  const files = walk(join(process.cwd(), "src/app")).filter((f) => readFileSync(f, "utf8").includes("createTriagedInquiry("));
  it("finds the doors (so the scan is live)", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });
  it.each(files.map((f) => [f.slice(process.cwd().length + 1), f]))("%s", (_rel, f) => {
    const src = readFileSync(f, "utf8");
    if (src.includes("leadId")) expect(src).toContain("cameBack");
  });
});
