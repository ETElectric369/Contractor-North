import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_KEYS, type FeatureKey } from "./features";
import { featureForPath } from "./feature-doors";

/**
 * EVERY RECORD PAGE OF A SWITCHABLE FEATURE CARRIES ITS OFF LINE (0352). A switch hides the doors
 * to these pages; a link, a bell or a Needs You card still opens them, and the page says the
 * feature is off (with Turn On for the owner) instead of looking like nothing happened.
 *
 * ONE Off line per page. A page under a switch route (lib/feature-doors FEATURE_ROUTES) gets it
 * from the app layout's RouteOffLine, so the page itself must not draw a second copy; every other
 * page names its feature in an Off line in its own source. The component renders nothing while
 * the feature is on.
 */
const ROOT = join(process.cwd(), "src/app/(app)");
const PAGES: [string, FeatureKey][] = [
  ["leads/page.tsx", "leads"],
  ["inspections/page.tsx", "leads"],
  ["appointments/[id]/page.tsx", "leads"],
  ["quotes/page.tsx", "estimates"],
  ["quotes/[id]/page.tsx", "estimates"],
  ["quotes/new/page.tsx", "estimates"],
  ["change-orders/page.tsx", "estimates"],
  ["work-orders/page.tsx", "estimates"],
  ["work-orders/[id]/page.tsx", "estimates"],
  ["price-list/page.tsx", "kits"],
  ["jobs/[id]/page.tsx", "contracts"],
  ["jobs/[id]/page.tsx", "purchase_orders"],
  ["purchasing/[id]/page.tsx", "purchase_orders"],
  ["bills/bills-receipts.tsx", "purchase_orders"],
  ["inventory/page.tsx", "shop_stock"],
  ["recurring/page.tsx", "recurring_billing"],
  ["compliance/page.tsx", "licenses"],
  ["insurance/page.tsx", "licenses"],
  ["audits/page.tsx", "licenses"],
  ["safety/page.tsx", "safety_log"],
  ["forms/[id]/page.tsx", "safety_log"],
  ["site-studio/page.tsx", "website"],
  ["settings/page.tsx", "website"],
  ["tools/page.tsx", "calculators"],
];

/** "quotes/[id]/page.tsx" → "/quotes/x"; a file that isn't a page has no route of its own. */
const routeOf = (file: string) =>
  file.endsWith("page.tsx") ? "/" + file.replace(/\/?page\.tsx$/, "").replace(/\[[^\]]+\]/g, "x") : null;

describe("the Off line on every record page", () => {
  it("the app layout mounts the route Off line with the viewer's own owner check", () => {
    const src = readFileSync(join(ROOT, "layout.tsx"), "utf8");
    expect(src).toContain('const isOwner = profile.role === "owner";');
    expect(src).toContain("<RouteOffLine features={features} isOwner={isOwner} />");
  });

  for (const [file, feature] of PAGES) {
    it(`${file} → ${feature}`, () => {
      expect(FEATURE_KEYS).toContain(feature);
      const src = readFileSync(join(ROOT, file), "utf8");
      const own = new RegExp(`<FeatureOffLine(?:For)?\\s+feature="${feature}"`);
      const route = routeOf(file);
      if (route && featureForPath(route) === feature) {
        // The layout draws it; a second copy here would stack two identical lines.
        expect(src).not.toMatch(own);
      } else {
        expect(src).toMatch(own);
      }
    });
  }

  it("the job page's switch-owned tabs get theirs from arrangeJobTabs (job-tabs.test.ts)", () => {
    const src = readFileSync(join(ROOT, "jobs/[id]/page.tsx"), "utf8");
    expect(src).toContain("arrangeJobTabs(tabs, viewerIsStaff, switches)");
  });

  it("a safety form carries Safety Log's line; a walk-through sheet or the website's form does not", () => {
    const src = readFileSync(join(ROOT, "forms/[id]/page.tsx"), "utf8");
    const at = src.indexOf('<FeatureOffLineFor feature="safety_log"');
    const guard = src.slice(Math.max(0, at - 300), at);
    expect(guard).toContain("is_inspection");
    expect(guard).toContain("is_public_intake");
  });
});
