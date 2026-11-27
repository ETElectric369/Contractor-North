import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ORPHANED /reset PAGE IS GONE (cn-v1202, the owner's "remove any old pages when they are
 * orphaned"). Since cn-v1199 the app's own reset email lands on /set-password, so no email, link or
 * redirect led to /reset; its form's action, login/actions updatePassword, was a public endpoint
 * that only that page used. Held here: the page's folder is gone, the action exports no
 * updatePassword, and no file under src builds a path to /reset. "reset" stays a reserved site slug
 * (lib/site-reserved), which names it without a slash and is the one place allowed to.
 */
const ROOT = process.cwd();
/** A path to /reset: after a quote, a paren, or the end of a template slot (`${base}/reset`, with or
 *  without a query after it). */
const RESET_PATH = /["'`(}]\/reset(?=[?"'`/#)]|$)/m;

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) files(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

describe("the orphaned reset page", () => {
  it("its folder is gone", () => {
    expect(existsSync(join(ROOT, "src/app/reset"))).toBe(false);
  });
  it("login/actions exports no updatePassword", async () => {
    const mod = await import("@/app/login/actions");
    expect(Object.keys(mod)).not.toContain("updatePassword");
    expect(readFileSync(join(ROOT, "src/app/login/actions.ts"), "utf8")).not.toMatch(/\bupdatePassword\b/);
  });
  it("the scan sees a path built in a string, a template literal or a call, and nothing longer", () => {
    for (const hit of ['"/reset"', "'/reset?x=1'", "`/reset`", "`${base}/reset`", "`${base}/reset?next=/planner`", 'redirect("/reset#top")', "(/reset)"]) {
      expect(RESET_PATH.test(hit), hit).toBe(true);
    }
    for (const miss of ['"/reset-password"', "`${base}/resets`", '"/set-password"', '"reset"']) expect(RESET_PATH.test(miss), miss).toBe(false);
  });
  it("no file under src builds a path to /reset", () => {
    const all = files("src");
    expect(all.length).toBeGreaterThan(500);
    const hits = all.filter((f) => f !== "src/lib/site-reserved.ts" && RESET_PATH.test(readFileSync(join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });
  it("the reserved slug stays, so a site page can never take the address", () => {
    expect(readFileSync(join(ROOT, "src/lib/site-reserved.ts"), "utf8")).toMatch(/"forgot", "reset", "set-password"/);
  });
});
