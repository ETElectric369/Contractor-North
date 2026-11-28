import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE BUILD STAYS ON WEBPACK UNTIL ITS OWN WAVE SAYS OTHERWISE (cn-v1214, the move to Next 16).
 *
 * Since Next 16 a plain `next build` or `next dev` uses Turbopack, and it does so in silence: there
 * is no `webpack` key in next.config.ts for it to trip over, so a build without the flag passes and
 * ships a different bundler. The host does not run package.json's script either: vercel.json names
 * its own build command, which overrides it. So the flag has to be in BOTH places, and this file is
 * what notices the day one of them loses it.
 *
 * Why not Turbopack yet (each of these is unmeasured there, and is that wave's work):
 *   · src/lib/chunk-reload.ts knows a stale deploy by the words WEBPACK's loader throws;
 *   · the PDF preview and the PDF text reader name pdf.js's worker by a bare package URL;
 *   · the PDF route's file trace (next.config.ts, outputFileTracingIncludes) was only ever proven on
 *     a webpack build.
 * When that wave moves the build, it changes this file on purpose.
 *
 * WHO CAN OPEN THE APP (the last block). Next 16 compiles for Chrome, Edge and Firefox 111 and
 * Safari 16.4 where 15 went back to Safari 12, and the built `main` chunk of this app carries a
 * class static block, which an older engine cannot parse: there the page would draw from the
 * server's HTML and never come alive. That last part is read from the build and from what those
 * engines support; it was NOT seen on a device. It was put to Erik on 2026-11-27 with what could be
 * counted (every iPhone that filed a report in 120 days ran iOS 18) and his answer was "Go for 16".
 * So the floor is Next's own, on purpose, and the phone shell's own minimum follows it with the
 * next TestFlight build. A `browserslist` would move the floor in silence, in either direction,
 * and a Next that moves its own floor should be noticed too: both fail here.
 */
const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("the bundler is chosen on purpose, in every place that builds", () => {
  it("package.json builds and serves the dev app with webpack", () => {
    expect(pkg.scripts.build).toBe("next build --webpack");
    expect(pkg.scripts.dev).toBe("next dev --webpack");
  });

  it("the host's own build command carries the flag too (it overrides the script)", () => {
    const vercel = JSON.parse(read("vercel.json")) as { buildCommand?: string };
    expect(vercel.buildCommand).toBe("next build --webpack");
  });

  it("nothing else in the repository's own tooling calls the Next CLI to build", () => {
    // CI builds through the script (npm run build). A workflow that called the CLI itself would
    // need the flag as well, so it must not appear there without it.
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("run: npm run build");
    expect(ci).not.toMatch(/next (build|dev)(?! --webpack)/);
  });

  it("next.config.ts does not opt into Turbopack by a key of its own", () => {
    expect(read("next.config.ts")).not.toMatch(/\bturbopack\s*:/);
  });
});

describe("the installed Next is the one the tripwires were read against", () => {
  it("next and its lint config are pinned to one exact version, with no range", () => {
    // save-draws-the-page-once.test.ts and tests/next-router-queue.test.ts pin compiled text of this
    // exact release. A range would let an install move it under them.
    expect(pkg.dependencies.next).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["eslint-config-next"]).toBe(pkg.dependencies.next);
    const installed = JSON.parse(read("node_modules/next/package.json")) as { version: string };
    expect(installed.version).toBe(pkg.dependencies.next);
  });

  it("lint is plain eslint: `next lint` no longer exists", () => {
    expect(pkg.scripts.lint).toBe("eslint .");
    expect(read("next.config.ts")).not.toMatch(/\beslint\s*:/);
  });
});

describe("who can open the app is a decision, not an accident", () => {
  it("the floor is Next 16's own: Chrome, Edge and Firefox 111, Safari and iOS 16.4", () => {
    const floor = read("node_modules/next/dist/shared/lib/modern-browserslist-target.js");
    const list = floor.slice(floor.indexOf("MODERN_BROWSERSLIST_TARGET = ["), floor.indexOf("];"));
    expect(list.match(/'[^']+'/g)).toEqual(["'chrome 111'", "'edge 111'", "'firefox 111'", "'safari 16.4'"]);
  });

  it("no browserslist of the app's own moves it", () => {
    expect((pkg as { browserslist?: unknown }).browserslist).toBeUndefined();
    expect(existsSync(join(root, ".browserslistrc"))).toBe(false);
  });
});
