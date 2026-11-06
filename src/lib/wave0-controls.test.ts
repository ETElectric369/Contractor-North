import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translator } from "@/lib/i18n";

/**
 * THE CONTROLS WAVE 0 TOUCHED KEEP THE HOUSE LAWS: a 44px target on a 375px phone, and a Title Case
 * name on anything you tap. The older controls around them are a separate pass; these are the ones
 * the switch wiring re-wrapped, so they carry the law now.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("44px targets on the controls Wave 0 re-wrapped", () => {
  it("the staff-only Add buttons use the default 44px size", () => {
    const cases: [string, string][] = [
      ["src/app/(app)/audits/audits-manager.tsx", "Log Audit"],
      ["src/app/(app)/compliance/compliance-manager.tsx", "Add Item"],
      ["src/app/(app)/insurance/insurance-manager.tsx", "Add Policy"],
      ["src/app/(app)/resources/resources-manager.tsx", "Add Contact"],
      ["src/app/(app)/jobs/[id]/job-permits.tsx", "Add Permit"],
    ];
    for (const [file, label] of cases) {
      const line = src(file).split("\n").find((l) => l.includes(`/> ${label}</Button>`));
      expect(line, `${file}: ${label}`).toBeTruthy();
      expect(line, `${file}: ${label}`).not.toContain('size="sm"');
    }
  });

  it("their edit and delete icons are 44px squares with a name", () => {
    for (const file of [
      "src/app/(app)/audits/audits-manager.tsx",
      "src/app/(app)/compliance/compliance-manager.tsx",
      "src/app/(app)/insurance/insurance-manager.tsx",
      "src/app/(app)/resources/resources-manager.tsx",
      "src/app/(app)/safety/safety-manager.tsx",
      "src/app/(app)/settings/tax-rates-manager.tsx",
      "src/app/(app)/recurring/recurring-actions-ui.tsx",
    ]) {
      const all = src(file);
      // Settings > Money: only the Sales Tax card was re-wrapped (by its switch); pricing levels weren't.
      const s = file.endsWith("tax-rates-manager.tsx") ? all.slice(all.indexOf("{salesTax && ("), all.indexOf(">Defaults</h4>")) : all;
      // From each icon's title back to its own <button: the tag's attributes, arrows and all.
      const icons = [...s.matchAll(/title=(?:"(Edit|Delete|Generate One Now|Make Default)"|\{active \? "Pause" : "Resume"\})/g)];
      expect(icons.length, file).toBeGreaterThan(0);
      for (const m of icons) {
        const tag = s.slice(s.lastIndexOf("<button", m.index), m.index! + m[0].length + 80);
        expect(tag, `${file}: ${m[0]}`).toContain("h-11 w-11");
        expect(tag, `${file}: ${m[0]}`).toMatch(/aria-label=/);
      }
      for (const m of s.matchAll(/<DeleteButton[^\n]*className="([^"]*)"/g)) expect(m[1], file).toContain("h-11 w-11");
    }
    const rec = src("src/app/(app)/recurring/recurring-actions-ui.tsx");
    expect(rec).not.toContain("rounded-md p-1 ");
  });

  it("Settings' Print Business Cards and Open the Design Studio are 44px targets", () => {
    const s = src("src/app/(app)/settings/page.tsx");
    for (const label of ["Print Business Cards →", "Open the Design Studio"]) {
      const at = s.indexOf(label);
      const tag = s.slice(Math.max(s.lastIndexOf("<a\n", at), s.lastIndexOf("<Link", at)), at);
      expect(tag, label).toContain("min-h-11");
    }
  });

  it("Record as Cost is a 44px target", () => {
    const s = src("src/app/(app)/jobs/[id]/job-documents.tsx");
    // The button's own label (its text right before </button>), never a comment that names it.
    const at = s.search(/\{t\("jb_recordAsCost"\)\}\s*<\/button>/);
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(s.lastIndexOf("<button", at), at)).toContain("min-h-11");
  });
});

describe("Title Case on the clickables Wave 0 re-wrapped", () => {
  it("names each one in Title Case, and every sentence that names it says it the same way", () => {
    const settings = src("src/app/(app)/settings/page.tsx");
    expect(settings).toContain("Open Kits &amp; Job Lists");
    expect(settings).toContain("Open the Design Studio");
    const inspector = src("src/app/(app)/appointments/[id]/inspector.tsx");
    // (cn-v1144, the visit page in Spanish: both read the vi_ catalog through t(); the English is byte for byte what the screen said, pinned here)
    expect(inspector).toContain('<Button type="button">{t("vi_btn_startTheEstimate")}</Button>');
    expect(translator("en")("vi_btn_startTheEstimate")).toBe("Start the Estimate");
    expect(inspector).toContain('label={t("vi_dropPhotosPdfs3d")}');
    expect(translator("en")("vi_dropPhotosPdfs3d")).toBe("Drop Photos, PDFs or 3D Files");
    // The cap is gone (W1-09): its rows are built once, for Search or Ask and for Help; their words are
    // the shell catalog's since cn-v1139 (sh_help_again), English byte for byte.
    expect(src("src/lib/onboarding/help-rows.ts")).toContain('label: t("sh_help_again")');
    expect(src("src/lib/words/shell.ts")).toContain('sh_help_again: "Take the Setup Again"');
    const appt = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(appt).toContain('fallbackLabel={t("vp_btn_backToSchedule")}');
    expect(appt).toContain('fallbackLabel={t("vp_btn_backToMyDay")}');
    expect(translator("en")("vp_btn_backToSchedule")).toBe("Back to Schedule");
    expect(translator("en")("vp_btn_backToMyDay")).toBe("Back to My Day");
    for (const f of [
      "src/app/(app)/jobs/[id]/job-documents.tsx",
      "src/lib/receipt-capture.ts",
      "src/app/(app)/organize/actions.ts",
      "src/app/(app)/organize/paperwork-core.ts",
    ]) {
      const visible = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      // The door reads "Record as Cost" (cn-v1148 title case); neither older spelling may come back.
      expect(visible, f).not.toMatch(/Record As Cost|Record as cost/);
    }
    expect(src("src/lib/onboarding/tour.ts")).not.toContain("press Start the estimate");
  });
});
