import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYouCounts, NeedsYouTiles } from "./needs-you-tiles";
import { LangProvider } from "@/components/lang-provider";
import type { TileSummary } from "@/lib/action-items/needs-you-rule";

/**
 * ONE IS SINGULAR (cn-v1161 fixer): "1 abiertos" read wrong in Spanish. The header's last count and a
 * tile's head say one with the paired …One key, the way the app's other catalogs pair their plurals.
 */
const inLang = (lang: "en" | "es", el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang, children: el }));
const counts = (more: number, lang: "en" | "es") => inLang(lang, createElement(NeedsYouCounts, { summary: { now: 0, soon: 0, more } }));
const tile = (count: number): TileSummary => ({ group: "run_jobs", count, soon: 0, money: null, moneyCapped: false, unread: 0 });
const tiles = (count: number, lang: "en" | "es") =>
  inLang(lang, createElement(NeedsYouTiles, { tiles: [tile(count)], openId: null, onToggle: () => {}, controlsId: "rows", isStaff: true }));

describe("one versus many", () => {
  it("the header's open count", () => {
    expect(counts(1, "es")).toContain("1 abierto<");
    expect(counts(2, "es")).toContain("2 abiertos<");
    expect(counts(1, "en")).toContain("1 open<");
  });

  it("a tile's head", () => {
    expect(tiles(1, "es")).toContain("Sacar los Trabajos: 1 abierto");
    expect(tiles(1, "es")).not.toContain("1 abiertos");
    expect(tiles(3, "es")).toContain("Sacar los Trabajos: 3 abiertos");
    expect(tiles(1, "en")).toContain("Run the Jobs: 1 open");
  });
});

describe("the header's marks are said once", () => {
  it("each mark beside a count is hidden from a screen reader; its sr-only sentence says it", () => {
    const html = inLang("en", createElement(NeedsYouCounts, { summary: { now: 2, soon: 1, more: 0 } }));
    expect(html).not.toContain('role="img"');
    expect(html.match(/<svg[^>]*aria-hidden="true"/g)).toHaveLength(2);
    expect(html.match(/class="sr-only"/g)).toHaveLength(2);
  });
});
