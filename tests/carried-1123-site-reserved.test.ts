import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_SLUGS, isReservedSlug, pageSlugFromPath, slugifySiteSlug } from "@/lib/site-reserved";
import { tryAgainTarget } from "@/components/sign-in-check-failed";

/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123): the Try Again screen and the reserved slugs.
 */
const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "src/app");

/** True when a page or route file sits anywhere at or below this directory. */
function hasRoute(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((e) =>
    e.isFile() ? /^(page|route)\.tsx?$/.test(e.name) : e.isDirectory() && hasRoute(path.join(dir, e.name)),
  );
}
/** Every real top-level route segment: src/app/<x> and the (app) route group's children at root. */
function topLevelRouteSegments(): string[] {
  const out: string[] = [];
  for (const base of [APP, path.join(APP, "(app)")]) {
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || /^[(_[]/.test(e.name) || e.name.includes(".")) continue; // groups, private, dynamic, dotted
      if (hasRoute(path.join(base, e.name))) out.push(e.name);
    }
  }
  return out;
}

describe("/sign-in-check is not a reserved slug, so on a company's own domain the Try Again screen is rewritten into the marketing site", () => {
  it("the slug is reserved: no builder page can take it and the middleware never hands it to the page resolver", () => {
    expect(isReservedSlug("sign-in-check")).toBe(true);
    expect(isReservedSlug("Sign-In-Check")).toBe(true);
    expect(pageSlugFromPath("/sign-in-check")).toBeNull();
    expect(pageSlugFromPath("/sign-in-check/")).toBeNull();
  });

  it("a company can still not save a page titled Sign In Check (the save and the route read the same set)", () => {
    expect(isReservedSlug(slugifySiteSlug("Sign In Check"))).toBe(true);
  });

  it("every real top-level route directory is reserved, so the next new route can't drift out again", () => {
    const routes = topLevelRouteSegments();
    expect(routes).toContain("sign-in-check"); // the scan sees the route this finding is about
    expect(routes).toContain("reconcile"); // an (app) child that had drifted out the same way
    const loose = routes.filter((r) => !RESERVED_SLUGS.has(r));
    expect(loose, `add these to RESERVED_SLUGS in src/lib/site-reserved.ts: ${loose.join(", ")}`).toEqual([]);
  });

  it("the route itself exists outside the app shell and is public in the session guard", () => {
    expect(existsSync(path.join(APP, "sign-in-check/page.tsx"))).toBe(true);
    expect(readFileSync(path.join(ROOT, "src/lib/supabase/middleware.ts"), "utf8")).toContain('"/sign-in-check"');
  });
});

describe("Try Again goes back a page instead of trying the failed page again", () => {
  const origin = "https://app.example.test";

  it("a page named in ?next= is the page the button goes to, with its query, never history", () => {
    expect(tryAgainTarget("?next=%2Fjobs%2Fj-047", "", origin)).toBe("/jobs/j-047");
    expect(tryAgainTarget("?next=%2Fjobs%2Fj-047%3Ftab%3Dcosts", "https://messages.example.test/", origin)).toBe("/jobs/j-047?tab=costs");
  });

  it("a page tapped from a message or another site is never 'back': a cross-site or empty referrer lands on My Day", () => {
    expect(tryAgainTarget("", "", origin)).toBe("/planner");
    expect(tryAgainTarget("", "https://mail.example.test/inbox", origin)).toBe("/planner");
    expect(tryAgainTarget("", "https://app.example.test.evil.test/", origin)).toBe("/planner");
  });

  it("with no page named, the page before is used only when it is ours", () => {
    expect(tryAgainTarget("", `${origin}/jobs`, origin)).toBe("back");
  });

  it("a named page that is not a same-app path is ignored (no open redirect), and never loops on itself", () => {
    for (const bad of ["https://evil.test/x", "//evil.test/x", "/\\evil.test", "jobs", "/sign-in-check", "/sign-in-check?next=%2Fjobs"]) {
      expect(tryAgainTarget(`?next=${encodeURIComponent(bad)}`, "", origin), bad).toBe("/planner");
    }
  });

  it("the button hands the target to location.replace for a named page and keeps history.back() for ours only", () => {
    const c = readFileSync(path.join(ROOT, "src/components/sign-in-check-failed.tsx"), "utf8");
    expect(c).toContain("tryAgainTarget(window.location.search, document.referrer, window.location.origin)");
    expect(c).toContain('if (go === "back" && window.history.length > 1) window.history.back();');
    expect(c).toContain('else window.location.replace(go === "back" ? "/planner" : go);');
    expect(c).not.toContain("if (window.history.length > 1) window.history.back();\n          else window.location.replace(\"/planner\");");
  });
});
