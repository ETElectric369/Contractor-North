import { describe, it, expect, vi, beforeEach } from "vitest";
import { catalog, pageReadsTheMap, renderHeader, resetOfficeTables } from "@/test/office-title";

vi.mock("@/lib/supabase/server", async () => (await import("@/test/office-title")).supabaseServerModule());
vi.mock("@/lib/current-lang", async () => (await import("@/test/office-title")).currentLangModule());
vi.mock("next/navigation", async () => (await import("@/test/office-title")).navigationModule());
vi.mock("next/link", async () => (await import("@/test/office-title")).linkModule());

import Page from "./page";

/**
 * /RESOURCES IN THE PERSON'S LANGUAGE (cn-v1139, the map in Spanish): the page's title and its line
 * come through lib/words/nav (nv_page_resources / nv_desc_resources) in the language lib/current-lang
 * answers. Rendered on the real page over the fixture company (test/office-title): English is byte
 * for byte the words the page carried before the catalog; Spanish is the catalog's.
 */
beforeEach(() => resetOfficeTables());

describe("/resources's title and line", () => {
  it("English, byte for byte as before", async () => {
    const { title, description } = await renderHeader(Page, "en");
    expect(title).toBe("Resources");
    expect(description).toBe("Building departments, inspectors, utilities, engineers and permit portals: the numbers and links the crew needs.");
  });

  it("Spanish for a Spanish speaker: Recursos, and the catalog's line", async () => {
    const { title, description, html } = await renderHeader(Page, "es");
    expect(title).toBe("Recursos");
    expect(description).toBe(catalog.es.nv_desc_resources);
    expect(description).not.toBe(catalog.en.nv_desc_resources);
    expect(html).not.toContain(">Resources<");
  });

  it("reads the person's language once through currentLangFor with its own session's id (no second getUser), and its words through the map", () => {
    pageReadsTheMap("resources/page.tsx", "resources");
  });
});
