import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { featureForPath } from "@/lib/feature-doors";

/**
 * THE RECORD PAGES STILL OPEN, WITH THE OFF LINE ON TOP (the switch board, 0352, rule a), for the
 * money and public-output features. A switch hides doors; a record opened by a link or a card is
 * never blocked. Each page gets the one shared Off line (components/feature-off-line), which draws
 * nothing while the feature is on (so every page is unchanged for a company with no switches), a
 * Turn On for the owner, and "Ask The Owner" with no button for anyone else, techs included.
 *
 * These pages are switch routes, so the app layout's RouteOffLine draws their line, with the
 * owner worked out from the viewer's own role (feature-off-line-wiring.test.ts pins the layout and
 * that no page stacks a second copy). A button that can't work for this person must not render.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), "src/app/(app)", rel), "utf8");

const PAGES: [string, string, string][] = [
  ["recurring/page.tsx", "/recurring", "recurring_billing"],
  ["compliance/page.tsx", "/compliance", "licenses"],
  ["insurance/page.tsx", "/insurance", "licenses"],
  ["audits/page.tsx", "/audits", "licenses"],
  ["safety/page.tsx", "/safety", "safety_log"],
  ["purchasing/[id]/page.tsx", "/purchasing/abc", "purchase_orders"],
  ["inventory/page.tsx", "/inventory", "shop_stock"],
  ["site-studio/page.tsx", "/site-studio", "website"],
];

describe("record pages keep opening, under the Off line", () => {
  it.each(PAGES)("%s opens under the shell's Off line for its switch", (file, path, key) => {
    expect(featureForPath(path)).toBe(key);
    // Nothing on the page is gated away: no early return or notFound on the switch.
    expect(read(file)).not.toMatch(/if \(!featureOn\([^)]*\)\) (return|notFound|redirect)/);
  });

  it("a form is the Safety Log's only when it is a crew checklist, never the walk-through or the intake form", () => {
    expect(featureForPath("/forms/abc")).toBeNull();
    const src = read("forms/[id]/page.tsx");
    const at = src.indexOf('<FeatureOffLineFor feature="safety_log"');
    expect(at).toBeGreaterThan(-1);
    const guard = src.slice(Math.max(0, at - 300), at);
    expect(guard).toContain("is_inspection");
    expect(guard).toContain("is_public_intake");
    expect(src).not.toMatch(/if \(!featureOn\([^)]*\)\) (return|notFound|redirect)/);
  });
});

describe("doors outside the job page", () => {
  it("the material list's New PO follows Purchase Orders; Took From Stock is told Shop Stock", () => {
    const src = read("materials/[id]/page.tsx");
    expect(src).toMatch(/\{featureOn\(sw\.features, "purchase_orders"\) && \(\s*<NewPoButton/);
    expect(src).toContain('canTake={featureOn(sw.features, "shop_stock")}');
  });
  it("the job's panel card (on the Customer Page tab) draws nothing while Panel Map is off", () => {
    expect(read("jobs/[id]/job-portal-panel.tsx")).toContain("if (state.panelMapOn === false) return null;");
  });
  it("the customer's portal link card follows the Customer Portal switch, and stays staff-only", () => {
    const src = read("crm/[id]/page.tsx");
    expect(src).toContain("{viewerIsStaff && portalOn && (");
    expect(src).toContain('const portalOn = featureOn(sw.features, "customer_portal");');
  });
  it("Settings: Photos & Pages leaves the side nav while Website is off and still opens by ?tab= under the Off line; the Website group stays", () => {
    const src = read("settings/page.tsx");
    expect(src).toContain('const CLUSTER_FEATURE: Partial<Record<string, FeatureKey>> = { content: "website" };');
    expect(src).toContain("const navClusters = clusters.filter((c) => !clusterOff(c.id))");
    expect(src).toContain('{activeOff && <FeatureOffLine feature={activeOff} features={settings.features} isOwner={profile?.role === "owner"} />}');
    // The web address lives in the Website group (rule e), which carries its own Off line.
    expect(src).toContain('<FeatureOffLine feature="website" features={settings.features} isOwner={isOwner} />');
  });
  it("the recurring page draws no Generate or New while the switch is off; editing and pausing stay", () => {
    const src = read("recurring/page.tsx");
    expect(src).toContain("{recurringOn && dueCount > 0 && <GenerateDueButton count={dueCount} />}");
    expect(src).toContain("{recurringOn && <RecurringButton customers={custOpts} salesTax={salesTax} />}");
    expect(src).toContain("<RecurringRowActions id={t.id} active={t.active} canGenerate={recurringOn} />");
    expect(src).toContain("<RecurringButton customers={custOpts} template={value} salesTax={salesTax} />");
  });
});
