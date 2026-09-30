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

import { MoreMenuRows, type TabBarItem } from "./tabs";
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

describe("the panel never hides under the bottom dock (bug triage 2026-09-27)", () => {
  const src = () => readFileSync(join(process.cwd(), "src/components/tabs.tsx"), "utf8");

  it("More is placed by the shared glass-menu placement, like Manage and the team menus", () => {
    expect(src()).toContain("const { panelRef, panelStyle } = useGlassMenuPlacement(open);");
    expect(src()).toMatch(/ref=\{panelRef\}\s+role="menu"\s+style=\{\{ \.\.\.panelStyle, right: 0 \}\}/);
  });

  // A new job's office More on a 667px phone: the strip's More chip spans y 330-382, the bottom dock's
  // top edge is at 595. The list is every unpinned tab now — nine rows and their cluster headers, which
  // the panel's own CSS cap (max-h-[min(70vh,24rem)]) stops at 384px.
  const chip = { anchorTop: 330, anchorBottom: 382, bottomLimit: 595 };

  it("the full list opens upward above the chip instead of hanging under the dock", () => {
    const p = placeGlassMenu({ panelH: 384, ...chip });
    expect(p.dropUp).toBe(true);
    // Room above the chip is 318px, so it also scrolls inside that room: every row can be reached.
    expect(p.maxHeight).toBe(318);
  });

  it("wherever it lands, the panel's bottom stays above the dock's top edge", () => {
    for (const top of [150, 250, 330, 420, 500]) {
      const a = { anchorTop: top, anchorBottom: top + 52, bottomLimit: 595 };
      const p = placeGlassMenu({ panelH: 384, ...a });
      const h = p.maxHeight ?? 384;
      const bottom = p.dropUp ? a.anchorTop - 4 : a.anchorBottom + 4 + h;
      expect(bottom).toBeLessThanOrEqual(a.bottomLimit);
      expect(bottom - h).toBeGreaterThanOrEqual(0);
    }
  });

  it("the rows scroll inside the capped panel, so the bottom of a long list is reachable", () => {
    const panel = src().match(/role="menu"[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
    expect(panel).toContain("max-h-[min(70vh,24rem)]");
    expect(src()).toMatch(/min-h-0 flex-1 overflow-y-auto[\s\S]*?<MoreMenuRows/);
  });

  it("opened upward, it sits over the job's sticky action dock (z-40), so no tap lands on Call or Navigate", () => {
    const panel = src().match(/role="menu"[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
    expect(panel).toContain("z-[90]");
    expect(panel).not.toMatch(/\bz-30\b/);
    const dock = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-action-dock.tsx"), "utf8");
    expect(dock).toContain("sticky -top-4 z-40");
  });
});
