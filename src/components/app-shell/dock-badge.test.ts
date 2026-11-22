import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translator } from "@/lib/i18n";
import { tileBadgeText, tileName } from "@/components/app-shell/dock";

/**
 * THE PHONE'S BAR DRAWS THE TILE'S NUMBER (cn-v1180, audit C40). The rail drew lib/dock tileBadge on
 * each tile and the phone's bottom bar drew nothing, so on a phone Sales or Admin never said it had
 * something open. One drawing (TileBadge) now serves both bars, from the one number, with the same cap
 * and the same screen-reader words.
 */
const src = readFileSync(join(process.cwd(), "src/components/app-shell/dock.tsx"), "utf8");
/** The phone's bar: from its marker class to the end of the component. */
const phoneBar = src.slice(src.indexOf('className="app-dock app-bottom-nav'));
const rail = src.slice(src.indexOf("<aside"), src.indexOf("</aside>"));

describe("a tile's badge: one number, one drawing, on both bars", () => {
  it("nothing at zero (or anything that is not a count), the figure up to 9, then 9+", () => {
    expect(tileBadgeText(0)).toBeNull();
    expect(tileBadgeText(-2)).toBeNull();
    expect(tileBadgeText(Number.NaN)).toBeNull();
    expect(tileBadgeText(1)).toBe("1");
    expect(tileBadgeText(9)).toBe("9");
    expect(tileBadgeText(10)).toBe("9+");
    expect(tileBadgeText(83)).toBe("9+");
  });

  it("a screen reader hears the tile and its figure, in the reader's language; nothing extra at zero", () => {
    const en = translator("en");
    const es = translator("es");
    expect(tileName("Sales", 3, en)).toBe("Sales, 3 open");
    expect(tileName("Sales", 12, en)).toBe("Sales, 9+ open");
    expect(tileName("Ventas", 3, es)).toBe("Ventas, 3 pendientes");
    expect(tileName("Sales", 0, en)).toBe("Sales");
  });

  it("the phone's bar reads tileBadge for each tile and draws the same badge the rail draws", () => {
    expect(phoneBar).toContain("const badge = tileBadge(badges, s);");
    expect(phoneBar).toContain("<TileBadge badge={badge}");
    expect(phoneBar).toContain("aria-label={tileName(tile, badge, t)}");
    expect(rail).toContain("const badge = tileBadge(badges, s);");
    expect(rail).toContain("<TileBadge badge={badge}");
    expect(rail).toContain("aria-label={tileName(tile, badge, t)}");
    // One drawing: the amber pill is written once, in TileBadge, never inline on a bar.
    expect(src.match(/bg-amber-400/g)).toHaveLength(1);
  });
});
