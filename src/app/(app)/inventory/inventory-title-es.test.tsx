import { describe, it, expect, vi, beforeEach } from "vitest";
import { catalog, pageReadsTheMap, renderHeader, resetOfficeTables } from "@/test/office-title";

vi.mock("@/lib/supabase/server", async () => (await import("@/test/office-title")).supabaseServerModule());
vi.mock("@/lib/current-lang", async () => (await import("@/test/office-title")).currentLangModule());
vi.mock("next/navigation", async () => (await import("@/test/office-title")).navigationModule());
vi.mock("next/link", async () => (await import("@/test/office-title")).linkModule());

import Page from "./page";

/**
 * /INVENTORY IN THE PERSON'S LANGUAGE (cn-v1139, the map in Spanish): the page's title and its line
 * come through lib/words/nav (nv_page_inventory / nv_desc_inventory) in the language lib/current-lang
 * answers. Rendered on the real page over the fixture company (test/office-title): English is byte
 * for byte the words the page carried before the catalog; Spanish is the catalog's.
 */
beforeEach(() => resetOfficeTables());

describe("/inventory's title and line", () => {
  it("English, byte for byte as before", async () => {
    const { title, description } = await renderHeader(Page, "en", { searchParams: Promise.resolve({}) });
    expect(title).toBe("Shop Stock");
    expect(description).toBe("What's in stock, what it cost, where every roll came from and where every piece went.");
  });

  it("Spanish for a Spanish speaker: Inventario, and the catalog's line", async () => {
    const { title, description, html } = await renderHeader(Page, "es", { searchParams: Promise.resolve({}) });
    expect(title).toBe("Inventario");
    expect(description).toBe(catalog.es.nv_desc_inventory);
    expect(description).not.toBe(catalog.en.nv_desc_inventory);
    expect(html).not.toContain(">Shop Stock<");
  });

  it("reads the person's language once through currentLangFor with its own session's id (no second getUser), and its words through the map", () => {
    pageReadsTheMap("inventory/page.tsx", "inventory");
  });
});
