import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LevelMark } from "./level-mark";
import { LangProvider } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

/**
 * THE TWO MARKS (cn-v1161): the octagon is NOW, the triangle is SOON. Shape, colour and words ride
 * together, so colour is never the only signal; and this is the one file in the box that holds red
 * or amber.
 */
const draw = (level: "now" | "soon" | "none" | undefined, lang: "en" | "es" = "en", decorative?: boolean) =>
  renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(LevelMark, { level, decorative }) }));

describe("LevelMark", () => {
  it("NOW: a red-600 octagon with a white '!', an image with the catalog's label", () => {
    const html = draw("now");
    expect(html).toContain('data-mark="now"');
    expect(html).toContain('data-shape="octagon"');
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="${translator("en")("ny_markNow")}"`);
    expect(html).toContain("fill-red-600");
    expect(html).toContain("fill-white");
  });

  it("SOON: an amber-400 triangle with an amber-700 edge (its 3:1 on white) and a dark '!'", () => {
    const html = draw("soon");
    expect(html).toContain('data-mark="soon"');
    expect(html).toContain('data-shape="triangle"');
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="${translator("en")("ny_markDue")}"`);
    expect(html).toContain("fill-amber-400");
    expect(html).toContain("stroke-amber-700");
    expect(html).toContain("fill-slate-900");
  });

  it("decorative: hidden from a screen reader, with no role and no label (the words beside it say it once)", () => {
    for (const level of ["now", "soon"] as const) {
      const html = draw(level, "en", true);
      expect(html).toContain(`data-mark="${level}"`);
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("role=");
      expect(html).not.toContain("aria-label=");
    }
    // The default is unchanged: an image with its label, never hidden.
    expect(draw("now")).not.toContain("aria-hidden");
  });

  it("no mark draws nothing", () => {
    expect(draw("none")).toBe("");
    expect(draw(undefined)).toBe("");
  });

  it("speaks the reader's language", () => {
    expect(draw("now", "es")).toContain(`aria-label="${translator("es")("ny_markNow")}"`);
    expect(draw("soon", "es")).toContain(`aria-label="${translator("es")("ny_markDue")}"`);
  });

  // The list's own surface holds no red but the marks. A sheet sits above the box and takes the app's
  // refusal look from components/ui/refusal (SHEET_REFUSAL), which lives outside this folder.
  it("is the only file in the box with a red or an amber class", () => {
    const dir = join(process.cwd(), "src/components/action-items");
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      if (f === "level-mark.tsx") expect(src).toMatch(/red-600/);
      else expect(src, f).not.toMatch(/\b(red|amber)-\d{2,3}\b/);
    }
  });
});
