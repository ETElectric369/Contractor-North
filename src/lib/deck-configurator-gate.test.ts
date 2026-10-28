import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deckConfiguratorOn } from "@/lib/org-trade";

/**
 * THE ONE GATE ON THE DECK CONFIGURATOR (cn-v1135): a DECK company pricing from its CATALOG. Before,
 * /estimate/<handle>, the header CTA, the sitemap and the site chat's deck tool each read catalog
 * mode alone, so a catalog-mode landscaper would have had a public page titled "Deck Estimate" and
 * a CTA pointing at it. One function, read by every door, so none can drift.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("deckConfiguratorOn", () => {
  it("deck + catalog: on", () => {
    expect(deckConfiguratorOn({ trade: "deck", estimating_mode: "catalog" })).toBe(true);
  });
  it("general + catalog: off (the route is deck-specific by construction)", () => {
    expect(deckConfiguratorOn({ trade: "general", estimating_mode: "catalog" })).toBe(false);
    expect(deckConfiguratorOn({ trade: "landscaping", estimating_mode: "catalog" })).toBe(false);
  });
  it("deck + research: off (nothing to price it from)", () => {
    expect(deckConfiguratorOn({ trade: "deck", estimating_mode: "research" })).toBe(false);
    expect(deckConfiguratorOn({ trade: "deck" })).toBe(false);
  });
  it("label-only 'deck builder' + catalog: on (orgTrade reads the words when no key is stored)", () => {
    expect(deckConfiguratorOn({ trade_label: "deck builder", estimating_mode: "catalog" })).toBe(true);
    expect(deckConfiguratorOn({ trade: "", trade_label: "I build decks", estimating_mode: "catalog" })).toBe(true);
  });
  it("nothing known: off", () => {
    expect(deckConfiguratorOn({})).toBe(false);
    expect(deckConfiguratorOn(null)).toBe(false);
    expect(deckConfiguratorOn({ estimating_mode: "catalog" })).toBe(false);
  });
});

describe("every door reads the one gate", () => {
  it("the page (its metadata and its body), its submit action, the header CTA, the sitemap and the site chat", () => {
    const page = src("src/app/estimate/[handle]/page.tsx");
    expect(page.match(/deckConfiguratorOn\(org\.settings\)/g)).toHaveLength(2);
    expect(page).not.toContain('estimating_mode !== "catalog"');
    const action = src("src/app/estimate/[handle]/actions.ts");
    expect(action).toContain("if (!deckConfiguratorOn(settings)) return { ok: false, error:");
    const chrome = src("src/app/site/site-chrome.tsx");
    expect(chrome).toContain("const hasConfigurator = deckConfiguratorOn(s) && !!s.public_handle;");
    expect(chrome).not.toContain('estimating_mode === "catalog"');
    const sitemap = src("src/app/sitemap.xml/route.ts");
    expect(sitemap).toContain("if (handle && deckConfiguratorOn(org.settings))");
    expect(sitemap).not.toContain('estimating_mode === "catalog"');
    const chat = src("src/app/api/site-chat/route.ts");
    expect(chat).toContain("const isDeck = deckConfiguratorOn(org.settings) && Object.keys(deckRates).length >= 3;");
  });
});
