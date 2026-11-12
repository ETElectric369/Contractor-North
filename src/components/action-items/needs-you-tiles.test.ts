import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYouCounts, NeedsYouTiles } from "./needs-you-tiles";
import { LangProvider } from "@/components/lang-provider";
import type { TileSummary } from "@/lib/action-items/needs-you-rule";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";

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
    expect(tiles(1, "es")).toContain("Operaciones: 1 abierto");
    expect(tiles(1, "es")).not.toContain("1 abiertos");
    expect(tiles(3, "es")).toContain("Operaciones: 3 abiertos");
    expect(tiles(1, "en")).toContain("Operations: 1 open");
  });
});

/**
 * ONE DUE VERSUS SEVERAL (cn-v1162 fixer): the header's screen-reader sentence and a tile's accessible
 * label both say the due count with the paired ny_countDueOne / ny_countDue keys. Spanish is where it
 * shows ("1 vence", "3 vencen"); the expected words are built from the real catalog.
 */
describe("one due versus several, said", () => {
  const due = (lang: "en" | "es", n: number) => fillSlots(translator(lang)(n === 1 ? "ny_countDueOne" : "ny_countDue"), { n });
  const soonTile = (soon: number): TileSummary => ({ group: "run_jobs", count: 4, soon, money: null, moneyCapped: false, unread: 0 });

  it("the catalog's words are the ones the owner reads", () => {
    expect(due("en", 1)).toBe("1 due");
    expect(due("en", 3)).toBe("3 due");
    expect(due("es", 1)).toBe("1 vence");
    expect(due("es", 3)).toBe("3 vencen");
  });

  it("the header's screen-reader sentence", () => {
    for (const lang of ["en", "es"] as const)
      for (const n of [1, 3]) {
        const html = inLang(lang, createElement(NeedsYouCounts, { summary: { now: 0, soon: n, more: 0 } }));
        expect(html).toContain(`<span class="sr-only">${due(lang, n)}</span>`);
      }
    expect(inLang("es", createElement(NeedsYouCounts, { summary: { now: 0, soon: 1, more: 0 } }))).not.toContain("1 vencen");
  });

  it("a tile's accessible label", () => {
    for (const lang of ["en", "es"] as const)
      for (const n of [1, 3]) {
        const html = inLang(lang, createElement(NeedsYouTiles, { tiles: [soonTile(n)], openId: null, onToggle: () => {}, controlsId: "rows", isStaff: true }));
        const label = /<button[^>]*aria-label="([^"]*)"/.exec(html)![1];
        expect(label.split(", ")).toContain(due(lang, n));
      }
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

describe("each tile has its picture (cn-v1162)", () => {
  const four = (["get_paid", "win_work", "run_jobs", "keep_books"] as const).map((group, i): TileSummary => ({ group, count: i === 3 ? 0 : 2, soon: 0, money: null, moneyCapped: false, unread: 0 }));
  const html = inLang("en", createElement(NeedsYouTiles, { tiles: four, openId: null, onToggle: () => {}, controlsId: "rows", isStaff: true }));
  const tileOf = (g: string) => html.slice(html.indexOf(`data-tile="${g}"`), html.indexOf("</button>", html.indexOf(`data-tile="${g}"`)));

  it("left of its name, on the name's line, in its own colour, hidden from a screen reader; the line wraps rather than cutting the name", () => {
    for (const g of ["get_paid", "win_work", "run_jobs", "keep_books"]) {
      const tile = tileOf(g);
      expect(tile).toMatch(new RegExp(`<span class="flex flex-wrap items-center gap-x-1\\.5 gap-y-1"><span aria-hidden="true" data-group-picture="${g}" data-tint="${g}"`));
      expect(tile.indexOf("data-group-picture")).toBeLessThan(tile.indexOf("font-semibold"));
    }
  });

  it("a zero tile is dimmed whole, its picture with it", () => {
    expect(html).toMatch(/<button[^>]*data-tile="keep_books"[^>]*disabled=""[^>]*class="[^"]*opacity-50/);
    expect(tileOf("keep_books")).toContain('data-group-picture="keep_books"');
  });
});
