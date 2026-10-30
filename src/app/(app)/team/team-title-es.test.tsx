import { describe, it, expect, vi, beforeEach } from "vitest";
import { catalog, pageReadsTheMap, renderHeader, resetOfficeTables } from "@/test/office-title";

vi.mock("@/lib/supabase/server", async () => (await import("@/test/office-title")).supabaseServerModule());
vi.mock("@/lib/current-lang", async () => (await import("@/test/office-title")).currentLangModule());
vi.mock("next/navigation", async () => (await import("@/test/office-title")).navigationModule());
vi.mock("next/link", async () => (await import("@/test/office-title")).linkModule());

import Page from "./page";

/**
 * /TEAM IN THE PERSON'S LANGUAGE (cn-v1139, the map in Spanish): the page's title and its line
 * come through lib/words/nav (nv_page_team / nv_desc_team) in the language lib/current-lang
 * answers. Rendered on the real page over the fixture company (test/office-title): English is byte
 * for byte the words the page carried before the catalog; Spanish is the catalog's.
 */
beforeEach(() => resetOfficeTables());

describe("/team's title and line", () => {
  it("English, byte for byte as before", async () => {
    const { title, description } = await renderHeader(Page, "en");
    expect(title).toBe("Team");
    expect(description).toBe("Your crew — invite people, set pay & charge rates, change roles, and deactivate anyone who's moved on.");
  });

  it("Spanish for a Spanish speaker: Equipo, and the catalog's line", async () => {
    const { title, description, html } = await renderHeader(Page, "es");
    expect(title).toBe("Equipo");
    expect(description).toBe(catalog.es.nv_desc_team);
    expect(description).not.toBe(catalog.en.nv_desc_team);
    expect(html).not.toContain(">Team<");
  });

  it("reads the person's language once through currentLangFor with its own session's id (no second getUser), and its words through the map", () => {
    pageReadsTheMap("team/page.tsx", "team");
  });
});
