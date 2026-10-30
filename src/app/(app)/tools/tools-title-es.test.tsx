import { describe, it, expect, vi, beforeEach } from "vitest";
import { catalog, pageReadsTheMap, renderHeader, resetOfficeTables } from "@/test/office-title";

vi.mock("@/lib/supabase/server", async () => (await import("@/test/office-title")).supabaseServerModule());
vi.mock("@/lib/current-lang", async () => (await import("@/test/office-title")).currentLangModule());
vi.mock("next/navigation", async () => (await import("@/test/office-title")).navigationModule());
vi.mock("next/link", async () => (await import("@/test/office-title")).linkModule());

import Page from "./page";

/**
 * /TOOLS IN THE PERSON'S LANGUAGE (cn-v1139, the map in Spanish): the page's title and its line
 * come through lib/words/nav (nv_page_tools / nv_desc_tools) in the language lib/current-lang
 * answers. Rendered on the real page over the fixture company (test/office-title): English is byte
 * for byte the words the page carried before the catalog; Spanish is the catalog's.
 */
beforeEach(() => resetOfficeTables());

describe("/tools's title and line", () => {
  it("English, byte for byte as before", async () => {
    const { title, description } = await renderHeader(Page, "en");
    expect(title).toBe("Tools");
    expect(description).toBe("Field calculators — measurements, materials, margins.");
  });

  it("Spanish for a Spanish speaker: Herramientas, and the catalog's line", async () => {
    const { title, description, html } = await renderHeader(Page, "es");
    expect(title).toBe("Herramientas");
    expect(description).toBe(catalog.es.nv_desc_tools);
    expect(description).not.toBe(catalog.en.nv_desc_tools);
    expect(html).not.toContain(">Tools<");
  });

  it("reads the person's language once through the no-id door currentLang() (it never resolves a session of its own), and its words through the map", () => {
    pageReadsTheMap("tools/page.tsx", "tools", { door: "none" });
  });
});
