import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { clipTopLimit, placeGlassMenu } from "./glass-menu";

/**
 * A GLASS MENU STAYS INSIDE THE BOX THAT CLIPS IT — AT BOTH ENDS.
 *
 * The bottom end has been answered since c1dfab46: a panel never hangs under the floating dock.
 * The top end had no answer at all, and that is Erik's oldest open report (e03465b6, a job page,
 * 2026-07-29: "Can't see the bottom of the list") read from the other side. "Room above" was
 * measured from the top of the WINDOW, but the panel lives inside `<main className="turn-host
 * flex-1 overflow-y-auto">`, which starts BELOW the top bar — 84px down on a 375x667 phone, 123px
 * in the iOS shell at sat 59. The job strip's nine-row More panel opened upward to y 8 and its
 * first rows, the MONEY header and Invoices, were cut off above main's edge with no way back:
 * main has nothing to scroll there (scrollHeight === clientHeight) and the panel's own scroller
 * is already at the top. Measured in a real browser before the fix at 375x667: 76px of panel
 * above main's edge, the Money header and Invoices unreachable.
 *
 * This is the shared rule, so these cases are the rule's, not one menu's: the tab strip's More,
 * the job's Manage / Status / Add A Cost, the team-member menu and the section-actions menu all
 * place through placeGlassMenu, and any of them grows past the room the day someone adds a row.
 */

/** The app shell as a tree of plain objects: the trigger inside a non-scrolling page wrapper
 *  inside the one scroller, `<main>`, which starts below the top bar. The same stand-in idiom as
 *  pull-to-refresh.test.ts — a walk is readable without a browser, which is why it is a walk. */
function shell({ mainTop = 84, mainOverflow = "auto" } = {}) {
  const box = (overflowY: string, top: number, parentElement: unknown = null) => ({
    overflowY,
    parentElement,
    getBoundingClientRect: () => ({ top }),
  });
  const root = box("hidden", 0);
  const main = box(mainOverflow, mainTop, root);
  const page = box("visible", mainTop, main);
  const anchor = box("visible", 322, page); // the More chip's relative wrapper
  return { anchor, main, root };
}

function walk(anchor: unknown) {
  const realGCS = globalThis.getComputedStyle;
  (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = (n: { overflowY: string }) => ({
    overflowY: n.overflowY,
  });
  try {
    return clipTopLimit(anchor as HTMLElement);
  } finally {
    (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = realGCS;
  }
}

describe("where the top of a menu panel must stop", () => {
  it("the top edge of the nearest scrolling ancestor — <main>, which starts under the top bar", () => {
    expect(walk(shell().anchor)).toBe(84);
    expect(walk(shell({ mainTop: 123 }).anchor)).toBe(123); // the iOS shell, sat 59
    expect(walk(shell({ mainOverflow: "scroll" }).anchor)).toBe(84);
  });

  it("nothing that scrolls above it means nothing clips it: 0, so the window's own edge rules", () => {
    expect(walk(shell({ mainOverflow: "hidden" }).anchor)).toBe(0);
    expect(walk(null)).toBe(0);
  });
});

/**
 * THE CASE THAT WAS BROKEN, in the numbers a browser gave: a 375x667 phone in the iOS shell at
 * sat 20. Main spans from 84, the dock's top edge is 602, the More chip sits at 322..378, and the
 * office list is nine rows in three clusters — 480px of them.
 */
const PHONE = { panelH: 480, anchorTop: 322, anchorBottom: 378, bottomLimit: 602, topLimit: 84 };
const topOf = (p: { dropUp: boolean; maxHeight: number | undefined }, a: typeof PHONE) =>
  p.dropUp ? a.anchorTop - 4 - (p.maxHeight ?? a.panelH) : a.anchorBottom + 4;
const bottomOf = (p: { dropUp: boolean; maxHeight: number | undefined }, a: typeof PHONE) =>
  p.dropUp ? a.anchorTop - 4 : a.anchorBottom + 4 + (p.maxHeight ?? a.panelH);

describe("a panel opened upward starts inside the page, not above it", () => {
  it("the job strip's More on a 375x667 phone: its first row is on screen, not cut off over main", () => {
    const p = placeGlassMenu(PHONE);
    expect(p.dropUp).toBe(true);
    // 234px of room above the chip INSIDE main (322 − 4 gap − 84), not the 310 the window would
    // have allowed. Panel top lands exactly on main's edge instead of 76px above it.
    expect(p.maxHeight).toBe(234);
    expect(topOf(p, PHONE)).toBe(84);
    expect(topOf(p, PHONE)).toBeGreaterThanOrEqual(PHONE.topLimit);
  });

  it("wherever the chip sits on that phone, the panel stays between main's top and the dock", () => {
    for (const anchorTop of [120, 200, 322, 420, 500]) {
      const a = { ...PHONE, anchorTop, anchorBottom: anchorTop + 56 };
      const p = placeGlassMenu(a);
      expect(topOf(p, a)).toBeGreaterThanOrEqual(a.topLimit);
      expect(bottomOf(p, a)).toBeLessThanOrEqual(a.bottomLimit);
    }
  });

  it("off the shell (nothing clipping, topLimit 0) the window's 8px margin still holds", () => {
    const p = placeGlassMenu({ ...PHONE, topLimit: 0 });
    expect(topOf(p, PHONE)).toBe(8);
  });
});

describe("the hook asks the question for every menu, not just the tall one", () => {
  const src = readFileSync(join(process.cwd(), "src/components/ui/glass-menu.ts"), "utf8");

  it("useGlassMenuPlacement passes the clipping scroller's top, so all six menus inherit the fix", () => {
    expect(src).toMatch(/topLimit: clipTopLimit\(anchor\)/);
  });

  it("topLimit is required, so a new caller cannot quietly reopen the hole it closes", () => {
    const sig = src.match(/export function placeGlassMenu\(\{[\s\S]*?\}: \{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(sig).toMatch(/topLimit: number;/);
    expect(sig).not.toMatch(/topLimit\?/);
  });
});
