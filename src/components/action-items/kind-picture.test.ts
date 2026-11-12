import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GROUP_ICON, GROUP_TINT, GroupPicture, KindPicture, PICTURE_ICON, PLAIN_PICTURE, TilePicture, pictureTint } from "./kind-picture";
import { CalendarClock } from "lucide-react";
import { KIND_PICTURE } from "@/lib/action-items/kind-picture";
import { GROUP_ORDER } from "@/lib/action-items/needs-you-rule";

/**
 * THE PICTURES' COMPONENT (cn-v1162): every picture is a real lucide icon, the tiles' colours are
 * never urgency's, one rule colours a row's picture, and every picture is hidden from a screen reader.
 */
const SRC = readFileSync(join(process.cwd(), "src/components/action-items/kind-picture.tsx"), "utf8");
const DTS = readFileSync(join(process.cwd(), "node_modules/lucide-react/dist/lucide-react.d.ts"), "utf8");

describe("the icons", () => {
  it("every icon imported is a real lucide export, never the deprecated FileSignature alias", () => {
    const imports = SRC.match(/import \{([^}]*)\} from "lucide-react"/)![1];
    const names = imports
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("type "));
    expect(names.length).toBe(22);
    for (const n of names) expect(DTS, n).toContain(`declare const ${n}:`);
    expect(imports).not.toMatch(/\bFileSignature\b/);
    expect(SRC).not.toMatch(/\bFileSignature[,\s]*[}>]|<FileSignature\b/);
  });

  it("every picture id has an icon, eighteen different ones; every tile has its own, none of them a row's", () => {
    for (const id of new Set(Object.values(KIND_PICTURE))) expect(PICTURE_ICON[id], id).toBeTruthy();
    expect(new Set(Object.values(PICTURE_ICON)).size).toBe(18);
    expect(new Set(Object.values(GROUP_ICON)).size).toBe(4);
    for (const g of GROUP_ORDER) expect(Object.values(PICTURE_ICON)).not.toContain(GROUP_ICON[g]);
  });
});

describe("the tiles' colours", () => {
  it("each tile has a pale chip and a darker ink, four different hues", () => {
    expect(Object.keys(GROUP_TINT)).toEqual(GROUP_ORDER);
    for (const g of GROUP_ORDER) {
      expect(GROUP_TINT[g].chip, g).toMatch(/^bg-[a-z]+-100$/);
      expect(GROUP_TINT[g].ink, g).toMatch(/^text-[a-z]+-[78]00$/);
    }
    expect(new Set(GROUP_ORDER.map((g) => GROUP_TINT[g].chip.split("-")[1])).size).toBe(4);
  });

  it("no tile is red, amber, orange, yellow, pink or the brand colour: those mean urgency, or may", () => {
    for (const g of GROUP_ORDER) for (const c of Object.values(GROUP_TINT[g])) expect(c, g).not.toMatch(/\b(?:red|amber|orange|yellow|pink|rose|brand)\b/);
    // And in source, nothing in the file is (the folder's own scan, level-mark.test.ts, pins red and amber too).
    expect(SRC).not.toMatch(/-(?:red|amber|orange|yellow|pink|rose)-\d{2,3}\b|\b(?:text|bg|fill|stroke|border|ring)-brand\b/);
    expect(SRC).not.toMatch(/slate-400/);
  });
});

describe("one rule colours a row's picture", () => {
  it("marked (now or soon) and not done: its tile's chip and ink; anything else: plain", () => {
    for (const g of GROUP_ORDER) {
      expect(pictureTint(g, "now")).toBe(GROUP_TINT[g]);
      expect(pictureTint(g, "soon")).toBe(GROUP_TINT[g]);
      expect(pictureTint(g, "soon", true)).toBeNull();
      expect(pictureTint(g, "now", true)).toBeNull();
      expect(pictureTint(g, "none")).toBeNull();
      expect(pictureTint(g, null)).toBeNull();
      expect(pictureTint(g, undefined)).toBeNull();
    }
    expect(PLAIN_PICTURE).toBe("text-slate-500");
  });
});

describe("drawn", () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

  it("a plain row's picture: a fixed 24px slot, grey, no chip, no tint, hidden from a screen reader", () => {
    const h = html(createElement(KindPicture, { kind: "quote_draft", group: "win_work", level: "none" }));
    expect(h).toMatch(/^<span aria-hidden="true" data-picture-slot="" data-picture="send" class="[^"]*\bh-6 w-6 shrink-0\b[^"]*rounded-full[^"]*text-slate-500"/);
    expect(h).not.toContain("data-tint");
    expect(h).not.toMatch(/bg-[a-z]+-100/);
    const svg = h.match(/<svg[^>]*>/)![0];
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toMatch(/class="[^"]*\bh-4 w-4\b/);
  });

  it("a marked row's picture is coloured in with its tile; a done one is not", () => {
    const h = html(createElement(KindPicture, { kind: "inquiry", group: "win_work", level: "soon" }));
    expect(h).toContain('data-tint="win_work"');
    expect(h).toContain("bg-sky-100 text-sky-700");
    const done = html(createElement(KindPicture, { kind: "inquiry", group: "win_work", level: "soon", done: true }));
    expect(done).not.toContain("data-tint");
    expect(done).toContain("text-slate-500");
  });

  it("kind null is the empty slot: the same size, nothing in it", () => {
    expect(html(createElement(KindPicture, { kind: null, group: "keep_books", level: "soon" }))).toBe(
      '<span aria-hidden="true" data-picture-slot="" class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"></span>',
    );
  });

  it("a tile's picture is always in its tile's colour, 28px round with an 18px icon", () => {
    for (const g of GROUP_ORDER) {
      const h = html(createElement(GroupPicture, { group: g }));
      expect(h).toContain(`data-tint="${g}"`);
      expect(h).toContain(`${GROUP_TINT[g].chip} ${GROUP_TINT[g].ink}`);
      expect(h).toMatch(/^<span aria-hidden="true"[^>]*class="[^"]*\bh-7 w-7\b/);
      expect(h).toContain("h-[18px] w-[18px]");
    }
  });
});

/**
 * ANY TILE'S PICTURE (TilePicture, cn-v1163): the Inspections page's tiles wear it, and Needs You's
 * GroupPicture is drawn through it. GroupPicture must not change by a byte, so its whole markup for
 * one tile is pinned here as it was drawn before TilePicture existed.
 */
describe("the generic tile picture", () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

  it("GroupPicture is byte for byte what it was", () => {
    expect(html(createElement(GroupPicture, { group: "win_work" }))).toBe(
      '<span aria-hidden="true" data-group-picture="win_work" data-tint="win_work" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trending-up h-[18px] w-[18px]" aria-hidden="true"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline><polyline points="16 7 22 7 22 13"></polyline></svg></span>',
    );
    for (const g of GROUP_ORDER) {
      expect(html(createElement(GroupPicture, { group: g }))).toBe(html(createElement(TilePicture, { icon: GROUP_ICON[g], group: g, "data-group-picture": g })));
    }
  });

  it("a group lends its chip and ink; null is plain grey on a pale chip, never slate-400; hidden either way", () => {
    const tinted = html(createElement(TilePicture, { icon: CalendarClock, group: "win_work" }));
    expect(tinted).toMatch(/^<span aria-hidden="true" data-tint="win_work" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700">/);
    expect(tinted).toContain("lucide-calendar-clock h-[18px] w-[18px]");
    expect(tinted).not.toContain("data-group-picture");
    const plain = html(createElement(TilePicture, { icon: CalendarClock, group: null }));
    expect(plain).toMatch(/^<span aria-hidden="true" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">/);
    expect(plain).not.toContain("data-tint");
    expect(plain).not.toContain("slate-400");
  });
});
