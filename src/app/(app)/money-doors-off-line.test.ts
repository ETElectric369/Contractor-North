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

  it("a form is the Safety Log's only when it is a crew checklist, never the inspection or the intake form", () => {
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
  it("the job's Customer Page tab keeps no door out to a switched-off portal: no link card, no Show Customer pointer", () => {
    expect(read("jobs/[id]/page.tsx")).toContain('portalOn={on("customer_portal")} />');
    const src = read("jobs/[id]/job-customer-page.tsx");
    expect(src).toContain("portalOn = true,");
    expect(src).toContain("{portalOn && <LinkCard link={link} who={who} jobId={jobId} />}");
    expect(src).toContain('{portalOn ? "Choose them on the Photos tab with Show Customer under each photo. " : null}');
    expect(src).toMatch(/\{portalOn && \(\s*<Link href=\{`\/jobs\/\$\{jobId\}\?tab=photos`\}/);
  });
  it("every way to take money on a bill is the one Get Paid sheet (W1-26): the invoice page mounts it; the job hub and the visit keep SettleUpButton, which renders it", () => {
    const invoice = read("billing/[id]/page.tsx");
    expect(invoice).toContain('import { GetPaidButton } from "@/components/settle-up-button";');
    expect(invoice).not.toMatch(/PayNowButton|RecordPaymentButton/);
    // A draft's small "Getting Paid Now?", the ⋯'s Get Paid on a draft, and the primary Get Paid $X.
    expect(invoice).toContain('<GetPaidButton {...payDoor} trigger="link" />');
    expect(invoice).toContain('<GetPaidButton {...payDoor} trigger="menuItem" />');
    expect(invoice).toContain("<GetPaidButton {...payDoor} label={`Get Paid ${formatCurrency(balance)}`} />");
    const settle = readFileSync(join(process.cwd(), "src/components/settle-up-button.tsx"), "utf8");
    expect(settle).toMatch(/export function SettleUpButton\([\s\S]*?return <GetPaidButton /);
    for (const page of ["jobs/[id]/page.tsx", "appointments/[id]/page.tsx"]) expect(read(page)).toContain("<SettleUpButton");
  });

  it("the invoice page's kit chips follow Kits, except in catalog mode (as on the estimate pages)", () => {
    const src = read("billing/[id]/page.tsx");
    expect(src).toContain('const kitDoors = featureOn(orgSettings.features, "kits") || orgSettings.estimating_mode === "catalog";');
    // W4: the plain picker never offers a TASK kit (partsKitsOnly) — the switch still gates the door.
    expect(src).toContain("kits={(kitDoors ? partsKitsOnly(kits ?? []) : []) as any}");
    // The kits are still read: a switch never gates a read.
    expect(src).toContain('supabase.from("kits").select(sel)');
  });
  it("the price list's Add to Kit and sizing fields follow Kits", () => {
    expect(read("price-list/page.tsx")).toContain("kitDoors={kitsOn}");
  });
  it("Forms: Safety Log takes only the crew checklists (and New Form); the inspection and intake forms stay", () => {
    const src = read("forms/page.tsx");
    expect(src).toContain("!f.is_inspection && !f.is_public_intake");
    expect(src).toContain("const list = (forms ?? []).filter((f) => safetyOn || !isChecklist(f));");
    expect(src).toContain("{isStaff && safetyOn && <NewFormButton />}");
    expect(src).toContain('<FeatureOffLine feature="safety_log" features={sw.features} isOwner={sw.isOwner} />');
    expect(featureForPath("/forms")).toBeNull();
  });
  it("Settings: Playbook with Leads and Estimates both off leaves the side nav and still opens by ?tab=playbook, each card under its Off line", () => {
    const src = read("settings/page.tsx");
    // Always declared (never spread away), so ?tab=playbook can't fall back to Company in silence.
    expect(src).not.toContain('? [{\n          id: "playbook"');
    expect(src).toContain('const playbookOff = !on("leads") && !on("estimates") && !playbookForms.some((f) => f.isWebsite);');
    expect(src).toContain('if (id === "playbook") return playbookOff;');
    expect(src).toContain('{inspectionSheetOff && <FeatureOffLine feature="leads" features={settings.features} isOwner={isOwner} />}');
    expect(src).toContain('{playbookOff && <FeatureOffLine feature="estimates" features={settings.features} isOwner={isOwner} />}');
    // A link that names an inspection (the form page's banner) still opens it with Leads off.
    expect(src).toContain("playbookForms.filter((f) => f.isWebsite || f.id === linkedForm)");
  });
  it("Licenses / Safety Log off: the record pages keep edit and delete, but draw no Add or Import under the Off line", () => {
    const pages: [string, string, string][] = [
      ["compliance/page.tsx", "licenses", "<ComplianceManager"],
      ["insurance/page.tsx", "licenses", "<InsuranceManager"],
      ["audits/page.tsx", "licenses", "<AuditsManager"],
      ["safety/page.tsx", "safety_log", "<SafetyManager"],
    ];
    for (const [file, key, tag] of pages) {
      const src = read(file);
      expect(src, file).toContain(`const canAdd = canEdit && featureOn((await viewerSwitches()).features, "${key}");`);
      expect(src, file).toMatch(new RegExp(`${tag}[^>]*canEdit=\\{canEdit\\} canAdd=\\{canAdd\\}`));
    }
    for (const file of ["compliance/compliance-manager.tsx", "insurance/insurance-manager.tsx", "audits/audits-manager.tsx"]) {
      const src = read(file);
      expect(src, file).toContain("canAdd = canEdit }");
      expect(src, file).toContain("{canAdd && adding && (");
    }
    expect(read("compliance/compliance-manager.tsx")).toMatch(/\{canAdd && \(\s*<div[^>]*>\s*<ImportDocsButton/);
    expect(read("insurance/insurance-manager.tsx")).toMatch(/\{canAdd && \(\s*<div[^>]*>\s*<ImportDocsButton/);
    expect(read("safety/safety-manager.tsx")).toContain('{canAdd && <Card className="space-y-3 p-4">');
  });

  it("the recurring page keeps its doors for repeat jobs and expenses while the switch is off; only the invoice doors go", () => {
    const src = read("recurring/page.tsx");
    // Not a switch route: the page draws its own Off line and never gates itself away.
    expect(featureForPath("/recurring")).toBeNull();
    expect(src).toContain('<FeatureOffLine feature="recurring_billing" features={sw.features} isOwner={sw.isOwner} />');
    expect(src).not.toMatch(/if \(!featureOn\([^)]*\)\) (return|notFound|redirect)/);
    // No Generate Due (W2-12): the daily cron makes what is due. Each row keeps its amber "due" chip,
    // on the org's own today, beside its Generate One Now.
    expect(src).not.toContain("GenerateDueButton");
    expect(src).not.toContain("dueCount");
    expect(src).toContain("const due = t.active && t.next_date <= today;");
    expect(src).toContain('{due && <Badge tone="amber">due</Badge>}');
    expect(src).toContain("<RecurringButton customers={custOpts} salesTax={salesTax} invoiceKind={recurringOn} />");
    expect(src).toContain('<RecurringRowActions id={t.id} active={t.active} kind={t.kind} canGenerate={recurringOn || t.kind !== "invoice"} />');
    expect(src).toContain("<RecurringButton customers={custOpts} template={value} salesTax={salesTax} invoiceKind={recurringOn} />");
  });
});
