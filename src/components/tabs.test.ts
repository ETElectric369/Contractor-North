import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE MORE MENU IS ONE LIST OF EVERY TAB (Erik, report 002dbffc: "the more dropdown should contain
 * everything (remove + Add)"). In their clusters, with their open counts, full or empty — no second
 * "+ Add…" view, in either look. Every row is a 44px tap target.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/x", useSearchParams: () => new URLSearchParams() }));

import { MoreMenuRows, moreBeyondEdge, CUE_PX, type TabBarItem } from "./tabs";
import { placeGlassMenu } from "./ui/glass-menu";
import { Camera, FileText, Receipt, Stamp } from "lucide-react";

const ITEMS: TabBarItem[] = [
  { id: "invoices", label: "Invoices", group: "Money", icon: Receipt, count: 2 },
  { id: "quotes", label: "Estimates", group: "Money", icon: FileText },
  { id: "photos", label: "Photos", group: "Docs", icon: Camera, count: 5 },
  { id: "permits", label: "Permits", group: "Docs", icon: Stamp },
];
const html = (p: Partial<Parameters<typeof MoreMenuRows>[0]> = {}) => renderToStaticMarkup(createElement(MoreMenuRows, { items: ITEMS, ...p }));
const rowTags = (s: string) => Array.from(s.matchAll(/<(?:button|a)\b[^>]*>/g)).map((m) => m[0]);
const labels = (s: string) => Array.from(s.matchAll(/<span class="flex-1">([^<]+)<\/span>/g)).map((m) => m[1]);

describe("the More menu lists every tab", () => {
  it("all of them in their clusters, the ones with something open wearing their count", () => {
    const s = html();
    expect(labels(s)).toEqual(["Invoices", "Estimates", "Photos", "Permits"]);
    expect(s.indexOf(">Money<")).toBeLessThan(s.indexOf(">Invoices<"));
    expect(s.indexOf(">Docs<")).toBeLessThan(s.indexOf(">Photos<"));
    expect(s).toMatch(/>Invoices<\/span><span[^>]*>2<\/span>/);
    expect(s).toMatch(/>Photos<\/span><span[^>]*>5<\/span>/);
  });

  it("an empty tab is a plain row: no + Add…, no divider, no going back", () => {
    const s = html();
    expect(labels(s)).not.toContain("Add…");
    expect(s).not.toContain("lucide-plus");
    expect(s).not.toContain("lucide-chevron-left");
    expect(s).not.toContain("border-t");
    // Nothing behind a second door: the empty tabs are rows you can tap right now.
    expect(s).toContain("lucide-file-text");
    expect(s).toContain("lucide-stamp");
  });

  it("the tabs with nothing in them, on their own, still list by name and icon", () => {
    const s = html({ items: ITEMS.filter((t) => t.count == null) });
    expect(labels(s)).toEqual(["Estimates", "Permits"]);
  });
});

describe("every row is 44px (one list, so one row recipe for both looks)", () => {
  it("min-h-11 on every button and link", () => {
    const tags = rowTags(html());
    expect(tags.length).toBe(ITEMS.length);
    for (const t of tags) expect(t).toContain("min-h-11");
  });
});

/**
 * THE WHOLE LIST IS REACHABLE, AT BOTH ENDS (Erik e03465b6, a job page: "Can't see the bottom of
 * the list"). The bottom was answered in cn-v936 — the panel opens upward above the dock and the
 * rows scroll inside it. The top was not: "room above" was measured to the top of the WINDOW, so
 * on a 375x667 phone the nine-row office More opened to y 8 and lost its first rows above the
 * scrolling <main>, which starts at 84. And the panel's own `max-h-[min(70vh,24rem)]` cut the
 * 480px list to 384 even where the whole thing fit — on a 1024x900 screen it stopped 138px short
 * of the window with Appointments and Work Orders below the fold for no reason at all.
 */
describe("the panel never hides under the bottom dock, nor above the top of the page", () => {
  const src = () => readFileSync(join(process.cwd(), "src/components/tabs.tsx"), "utf8");

  it("More is placed by the shared glass-menu placement, like Manage and the team menus", () => {
    expect(src()).toContain("const { panelRef, panelStyle } = useGlassMenuPlacement(open);");
    expect(src()).toMatch(/ref=\{panelRef\}\s+role="menu"\s+style=\{\{ \.\.\.panelStyle, right: 0 \}\}/);
  });

  // A new job's office More on a 667px phone: the strip's More chip spans y 330-382, the bottom dock's
  // top edge is at 595 and the scrolling <main> starts at 84, under the top bar. The list is every
  // unpinned tab — nine rows and their three cluster headers, 480px of them, measured in a browser.
  const chip = { anchorTop: 330, anchorBottom: 382, bottomLimit: 595, topLimit: 84 };
  const LIST_H = 480;

  it("the full list opens upward above the chip instead of hanging under the dock", () => {
    const p = placeGlassMenu({ panelH: LIST_H, ...chip });
    expect(p.dropUp).toBe(true);
    // Room above the chip INSIDE main is 242px (330 − 4 gap − 84), so it scrolls inside that room.
    // Measured from the window instead it was 318, which put the Money header and Invoices above
    // main's edge, where nothing could scroll them back (e03465b6).
    expect(p.maxHeight).toBe(242);
  });

  it("wherever it lands, the panel stays between main's top edge and the dock's top edge", () => {
    for (const top of [150, 250, 330, 420, 500]) {
      const a = { anchorTop: top, anchorBottom: top + 52, bottomLimit: 595, topLimit: 84 };
      const p = placeGlassMenu({ panelH: LIST_H, ...a });
      const h = p.maxHeight ?? LIST_H;
      const bottom = p.dropUp ? a.anchorTop - 4 : a.anchorBottom + 4 + h;
      expect(bottom).toBeLessThanOrEqual(a.bottomLimit);
      // NOT `>= 0`: the window's top is not the limit, main's top is. This line read 0 until
      // 2026-10-03 and that is exactly why the top of the list was unreachable.
      expect(bottom - h).toBeGreaterThanOrEqual(a.topLimit);
    }
  });

  it("the measured room is the ONLY cap: no max-h of its own to cut the list shorter than it fits", () => {
    const panel = src().match(/role="menu"[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
    expect(panel).not.toMatch(/max-h-/);
    expect(src()).toMatch(/min-h-0 flex-1 overflow-y-auto[\s\S]*?<MoreMenuRows/);
  });

  it("a capped list says it continues — one cue, one definition, in the stylesheet", () => {
    // iOS draws no scrollbar at rest, so without it five rows of nine read as the whole list.
    expect(src()).toContain('"menu-scroll-cue"');
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(/\.menu-scroll-cue \{[^}]*mask-image: linear-gradient\(to bottom, #000 calc\(100% - 18px\), transparent\);/);
  });

  it("opened upward, it sits over the job's sticky action dock (z-40), so no tap lands on Call or Navigate", () => {
    const panel = src().match(/role="menu"[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
    expect(panel).toContain("z-[90]");
    expect(panel).not.toMatch(/\bz-30\b/);
    const dock = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-action-dock.tsx"), "utf8");
    expect(dock).toContain("sticky -top-4 z-40");
  });
});

/**
 * THE FADE IS A CLAIM, SO IT HAS TO BE TRUE (2026-10-03, the far end of the same report). The bottom
 * cue was drawn whenever the placement hook had capped the panel, and "capped" answers a coarser
 * question than "are there rows below what you can see". Two ways it lied, both measured in a
 * browser and in iOS Safari at 375x667:
 *   - the office More, 480px of rows capped to 234, scrolled to its very end (scrollTop 256 of 256):
 *     the last row, Work Orders, still sat under the fade with nothing below it — its glyph chip
 *     dimmed to 0.44 — so the one mark that means "there is more" pointed at nothing.
 *   - a tech's four-row More: 229px of rows in a 224px port, 5px hidden and every one of them blank
 *     row padding, and the fade lay over the last row from the moment it opened.
 * So the cue is measured off the scroller now, by the same one predicate ScrollStrip's right-edge
 * fade has always used. The port is the cap less its 1px borders and py-1: 234 − 2 − 8 = 224.
 */
describe("the bottom fade says there is more below only when there is", () => {
  const src = () => readFileSync(join(process.cwd(), "src/components/tabs.tsx"), "utf8");
  const OFFICE = { visible: 224, total: 480, slack: CUE_PX };

  it("at the end of the list it lets go: scrolled to the bottom, nothing is below the last row", () => {
    expect(moreBeyondEdge({ ...OFFICE, scrolled: 256 })).toBe(false);
  });

  it("at the top and through the middle it still says so", () => {
    expect(moreBeyondEdge({ ...OFFICE, scrolled: 0 })).toBe(true);
    expect(moreBeyondEdge({ ...OFFICE, scrolled: 120 })).toBe(true);
  });

  it("never for a 5px overflow: a short list the hook capped by a sliver of padding is not fringed", () => {
    expect(moreBeyondEdge({ visible: 224, total: 229, scrolled: 0, slack: CUE_PX })).toBe(false);
  });

  it("nor when less than the fade's own width is left — the fade would dim more row than it reveals", () => {
    expect(moreBeyondEdge({ ...OFFICE, scrolled: 256 - CUE_PX })).toBe(false);
    expect(moreBeyondEdge({ ...OFFICE, scrolled: 256 - CUE_PX - 1 })).toBe(true);
  });

  it("a port of 0 is 'not laid out yet', not 'it all fits'", () => {
    expect(moreBeyondEdge({ visible: 0, total: 0, scrolled: 0, slack: CUE_PX })).toBe(false);
  });

  it("the class follows the measurement, never the hook's cap", () => {
    const scroller = src().match(/"relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain",\s*([^\n]+)/)?.[1] ?? "";
    expect(scroller).toContain('cue && "menu-scroll-cue"');
    expect(scroller).not.toContain("panelStyle.maxHeight");
    expect(src()).not.toContain('panelStyle.maxHeight !== undefined && "menu-scroll-cue"');
    // Measured when the panel is placed AND on every scroll, or the cue can only be right once.
    expect(src()).toMatch(/el\.addEventListener\("scroll", update, \{ passive: true \}\);[\s\S]*?\}, \[open, cap\]\);/);
  });

  it("one predicate for both fades in this file: the strip's right edge asks it the same way", () => {
    expect(src().match(/moreBeyondEdge\(\{/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src()).not.toContain("el.scrollLeft + el.clientWidth < el.scrollWidth - 4");
  });

  it("CUE_PX is the fade's real width: the constant and the stylesheet cannot drift", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(
      new RegExp(`\\.menu-scroll-cue \\{[^}]*mask-image: linear-gradient\\(to bottom, #000 calc\\(100% - ${CUE_PX}px\\), transparent\\);`),
    );
  });
});
