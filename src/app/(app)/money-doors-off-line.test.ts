import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE RECORD PAGES STILL OPEN, WITH THE OFF LINE ON TOP (the switch board, 0352, rule a), for the
 * money and public-output features. A switch hides doors; a record opened by a link or a card is
 * never blocked. Each page mounts the one shared Off line (components/feature-off-line), which draws
 * nothing while the feature is on (so every page is unchanged for a company with no switches), a
 * Turn On for the owner, and "Ask The Owner" with no button for anyone else, techs included.
 *
 * The owner is always worked out from the viewer's own role, never assumed: a button that can't
 * work for this person must not render.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), "src/app/(app)", rel), "utf8");
const OWNER = /isOwner=\{(viewer\.isOwner|\(me as \{ role\?: string \}\)\.role === "owner"|profile\?\.role === "owner"|isOwner)\}/;

const PAGES: [string, string][] = [
  ["recurring/page.tsx", "recurring_billing"],
  ["compliance/page.tsx", "licenses"],
  ["insurance/page.tsx", "licenses"],
  ["audits/page.tsx", "licenses"],
  ["safety/page.tsx", "safety_log"],
  ["forms/[id]/page.tsx", "safety_log"],
  ["purchasing/[id]/page.tsx", "purchase_orders"],
  ["inventory/page.tsx", "shop_stock"],
  ["site-studio/page.tsx", "website"],
];

describe("record pages keep opening, under the Off line", () => {
  it.each(PAGES)("%s mounts the Off line for %s, with the viewer's own owner check", (file, key) => {
    const src = read(file);
    const line = src.match(new RegExp(`<FeatureOffLine feature="${key}"[^>]*/>`));
    expect(line, `${file} has no Off line for ${key}`).not.toBeNull();
    expect(line![0]).toMatch(OWNER);
    expect(line![0]).not.toContain("isOwner={true}");
    // Nothing on the page is gated away: no early return or notFound on the switch.
    expect(src).not.toMatch(/if \(!featureOn\([^)]*\)\) (return|notFound|redirect)/);
  });

  it("a form is the Safety Log's only when it is a crew checklist, never the walk-through or the intake form", () => {
    const src = read("forms/[id]/page.tsx");
    expect(src).toContain("const crewChecklist = !(form as { is_inspection?: boolean }).is_inspection && !(form as { is_public_intake?: boolean }).is_public_intake;");
    expect(src).toContain('{crewChecklist && <FeatureOffLine feature="safety_log"');
  });
});

describe("doors outside the job page", () => {
  it("the material list's New PO follows Purchase Orders; Took From Stock is told Shop Stock", () => {
    const src = read("materials/[id]/page.tsx");
    expect(src).toMatch(/\{featureOn\(viewer\.features, "purchase_orders"\) && \(\s*<NewPoButton/);
    expect(src).toContain('shopStock={featureOn(viewer.features, "shop_stock")}');
  });
  it("the job's panel card (on the Customer Page tab) draws nothing while Panel Map is off", () => {
    expect(read("jobs/[id]/job-portal-panel.tsx")).toContain("if (state.panelMapOn === false) return null;");
  });
  it("the customer's portal link card follows the Customer Portal switch, and stays staff-only", () => {
    const src = read("crm/[id]/page.tsx");
    expect(src).toContain("{viewerIsStaff && portalOn && (");
    expect(src).toContain('const portalOn = featureOn((await viewerP).features, "customer_portal");');
  });
  it("Settings: Website and Photos & Pages leave the side nav while Website is off, and still open by ?tab= under the Off line", () => {
    const src = read("settings/page.tsx");
    expect(src).toContain('const CLUSTER_FEATURE: Partial<Record<string, FeatureKey>> = { website: "website", content: "website" };');
    expect(src).toContain("const navClusters = clusters.filter((c) => !clusterOff(c.id))");
    expect(src).toContain('{activeOff && <FeatureOffLine feature={activeOff} features={settings.features} isOwner={profile?.role === "owner"} />}');
  });
  it("the recurring page draws no Generate while the switch is off; editing and pausing stay", () => {
    const src = read("recurring/page.tsx");
    expect(src).toContain("{generating && dueCount > 0 && <GenerateDueButton count={dueCount} />}");
    expect(src).toContain("<RecurringRowActions id={t.id} active={t.active} canGenerate={generating} />");
    expect(src).toContain("<RecurringButton customers={custOpts} template={value} salesTax={salesTax} />");
  });
});
