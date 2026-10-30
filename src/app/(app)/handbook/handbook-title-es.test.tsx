import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageReadsTheMap, renderHeader, resetOfficeTables } from "@/test/office-title";

vi.mock("@/lib/supabase/server", async () => (await import("@/test/office-title")).supabaseServerModule());
vi.mock("@/lib/current-lang", async () => (await import("@/test/office-title")).currentLangModule());
vi.mock("next/navigation", async () => (await import("@/test/office-title")).navigationModule());
vi.mock("next/link", async () => (await import("@/test/office-title")).linkModule());
// The page's body — the phone checklist and the handbook's text — suspends under a static render and
// is not the title's business; the header is the real page's.
vi.mock("@/components/phone-setup-checklist", () => ({ PhoneSetupChecklist: () => null }));
vi.mock("./handbook-view", () => ({ HandbookView: () => null }));

import Page from "./page";

/**
 * /HANDBOOK IN THE PERSON'S LANGUAGE (cn-v1139, the map in Spanish): the title through nv_page_handbook,
 * and the line through nv_desc_handbook with the company's name in its {company} slot (fillText) — or
 * the catalog's stand-in, nv_desc_handbookCompany, when the company has no name yet. Rendered on the
 * real page over the fixture company (test/office-title): English is byte for byte the words the page
 * carried before the catalog; Spanish is the catalog's.
 */
beforeEach(() => resetOfficeTables());

describe("/handbook's title and line", () => {
  it("English, byte for byte as before: the company's name in the line", async () => {
    const { title, description } = await renderHeader(Page, "en");
    expect(title).toBe("Employee handbook");
    expect(description).toBe("Policies and expectations at Larkspur Electric.");
  });

  it("English with no company name: the stand-in, as before", async () => {
    resetOfficeTables({ organizations: [] });
    expect((await renderHeader(Page, "en")).description).toBe("Policies and expectations at the company.");
  });

  it("Spanish for a Spanish speaker: Manual Del Empleado, the company's name kept, the stand-in translated", async () => {
    const { title, description, html } = await renderHeader(Page, "es");
    expect(title).toBe("Manual Del Empleado");
    expect(description).toBe("Políticas y expectativas en Larkspur Electric.");
    expect(html).not.toContain(">Employee handbook<");
    resetOfficeTables({ organizations: [] });
    expect((await renderHeader(Page, "es")).description).toBe("Políticas y expectativas en la empresa.");
  });

  it("reads the person's language once through currentLangFor with its own session's id (no second getUser), and fills the company slot through the map", () => {
    pageReadsTheMap("handbook/page.tsx", "handbook", { description: false });
    const src = readFileSync(join(process.cwd(), "src/app/(app)/handbook/page.tsx"), "utf8");
    expect(src).toContain('description={fillText(t("nv_desc_handbook"), { company: (org as any)?.name ?? t("nv_desc_handbookCompany") })}');
    expect(src).not.toContain("Policies and expectations at ${");
    expect(src).not.toContain('?? "the company"');
  });
});
