import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_KEYS, type FeatureKey } from "./features";

/**
 * EVERY RECORD PAGE OF A SWITCHABLE FEATURE CARRIES ITS OFF LINE (0352). A switch hides the doors
 * to these pages; a link, a bell or a Needs You card still opens them, and the page says the
 * feature is off (with Turn On for the owner) instead of looking like nothing happened. These are
 * server pages with their reads inline, so the wiring is checked in their source: each names its
 * feature in an Off line. The component itself renders nothing while the feature is on.
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

describe("the Off line on every record page", () => {
  for (const [file, feature] of PAGES) {
    it(`${file} → ${feature}`, () => {
      expect(FEATURE_KEYS).toContain(feature);
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).toMatch(new RegExp(`<FeatureOffLine(?:For)?\\s+feature="${feature}"`));
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
