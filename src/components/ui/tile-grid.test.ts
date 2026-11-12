import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TileGrid, type GridTile } from "./tile-grid";

/**
 * THE GENERIC TILE GRID (cn-v1161): Needs You draws its four tiles with it, and the Inspections page
 * is next. Data in, one tap out, no state and no screen's words inside.
 */
const tiles: GridTile[] = [
  { id: "a", name: "Larkspur", label: "Larkspur: 3 open", count: 3, lines: ["$1,200.00 to collect", null, ""] },
  { id: "b", name: "Snowbell", label: "Snowbell: nothing open", count: 0 },
  { id: "c", name: "Bayberry", label: "Bayberry", mark: createElement("span", { "data-test-mark": "" }, "2") },
];
const draw = (openId: string | null) => renderToStaticMarkup(createElement(TileGrid, { tiles, openId, onToggle: () => {}, controlsId: "rows-1" }));
const buttons = (html: string) => Array.from(html.matchAll(/<button[^>]*>/g)).map((m) => m[0]);

describe("TileGrid", () => {
  it("two across on a phone, four from sm up; every tile a 72px button that names the region it opens", () => {
    const html = draw(null);
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("sm:grid-cols-4");
    const b = buttons(html);
    expect(b).toHaveLength(3);
    for (const tag of b) {
      expect(tag).toContain('type="button"');
      expect(tag).toContain("min-h-[72px]");
      expect(tag).toContain('aria-controls="rows-1"');
      expect(tag).toMatch(/aria-pressed="(true|false)"/);
      expect(tag).toContain("focus-visible:ring-2");
    }
    expect(b[0]).toContain('aria-label="Larkspur: 3 open"');
  });

  it("the open tile is pressed and outlined slate-900, never the brand colour; one at a time", () => {
    const html = draw("a");
    const b = buttons(html);
    expect(b[0]).toContain('aria-pressed="true"');
    expect(b[0]).toContain("border-slate-900");
    expect(b[2]).toContain('aria-pressed="false"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).not.toMatch(/\b(border|ring|bg|text)-brand\b/);
  });

  it("a zero tile is drawn, dimmed and disabled, with no number; once open it can still be closed", () => {
    const html = draw(null);
    const zero = buttons(html)[1];
    expect(zero).toContain('disabled=""');
    expect(zero).toContain("opacity-50");
    const body = html.slice(html.indexOf('data-tile="b"'), html.indexOf('data-tile="c"'));
    expect(body).toContain("Snowbell");
    expect(body).not.toMatch(/>0</);
    expect(buttons(draw("b"))[1]).not.toContain("disabled");
  });

  it("draws the count, the quiet lines it was given (skipping empty ones) and the mark", () => {
    const html = draw(null);
    expect(html).toMatch(/>3<\/span>/);
    expect(html).toContain("$1,200.00 to collect");
    expect(html.match(/text-xs leading-snug text-slate-600/g)).toHaveLength(1);
    expect(html).toContain("data-test-mark");
  });

  it("is generic and stateless: no Needs You word, no state, no red or amber, no slate-400 text", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ui/tile-grid.tsx"), "utf8");
    expect(src).not.toMatch(/useState|useReducer|ny_|needs-you|action-items/);
    expect(src).not.toMatch(/\b(red|amber)-\d/);
    expect(src).not.toContain("text-slate-400");
  });
});
