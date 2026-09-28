import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE MORE MENU'S TWO VIEWS (W1-18). In the tiles look, More lists the tabs that hold something (in
 * their clusters, with their open counts), a divider, and "+ Add…"; "+ Add…" swaps the menu to "‹
 * More" and the tabs that hold nothing yet, by name and icon. Every row is a 44px tap target. The
 * underline look has no tucked tabs: its menu lists everything, as it always did.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/x", useSearchParams: () => new URLSearchParams() }));

import { MoreMenuRows, type TabBarItem } from "./tabs";
import { Camera, FileText, Receipt, Stamp } from "lucide-react";

const ITEMS: TabBarItem[] = [
  { id: "invoices", label: "Invoices", group: "Money", icon: Receipt, count: 2 },
  { id: "quotes", label: "Estimates", group: "Money", icon: FileText, tucked: true },
  { id: "photos", label: "Photos", group: "Docs", icon: Camera, count: 5 },
  { id: "permits", label: "Permits", group: "Docs", icon: Stamp, tucked: true },
];
const html = (p: Partial<Parameters<typeof MoreMenuRows>[0]> = {}) => renderToStaticMarkup(createElement(MoreMenuRows, { items: ITEMS, tile: true, ...p }));
const rowTags = (s: string) => Array.from(s.matchAll(/<(?:button|a)\b[^>]*>/g)).map((m) => m[0]);
const labels = (s: string) => Array.from(s.matchAll(/<span class="flex-1">([^<]+)<\/span>/g)).map((m) => m[1]);

describe("the main view", () => {
  it("the holding tabs in their clusters with their open counts, a divider, then + Add…", () => {
    const s = html();
    expect(labels(s)).toEqual(["Invoices", "Photos", "Add…"]);
    expect(s.indexOf(">Money<")).toBeLessThan(s.indexOf(">Invoices<"));
    expect(s.indexOf(">Docs<")).toBeLessThan(s.indexOf(">Photos<"));
    expect(s).toMatch(/>Invoices<\/span><span[^>]*>2<\/span>/);
    expect(s).toContain("border-t");
    expect(s).toContain("lucide-plus");
    expect(s).not.toContain("Estimates");
  });

  it("with nothing holding, only + Add… (and no divider above it)", () => {
    const s = html({ items: ITEMS.filter((t) => t.tucked) });
    expect(labels(s)).toEqual(["Add…"]);
    expect(s).not.toContain("border-t");
  });

  it("with nothing tucked, no + Add… at all", () => {
    expect(labels(html({ items: ITEMS.filter((t) => !t.tucked) }))).toEqual(["Invoices", "Photos"]);
  });
});

describe("the + Add… view", () => {
  it("‹ More first, then each tucked tab by name and icon, no counts", () => {
    const s = html({ view: "add" });
    expect(labels(s)).toEqual(["More", "Estimates", "Permits"]);
    expect(s).toContain("lucide-chevron-left");
    expect(s).toContain("lucide-file-text");
    expect(s).toContain("lucide-stamp");
    expect(s).not.toContain("Invoices");
  });
});

describe("every row is 44px, in both views and both looks", () => {
  it("min-h-11 on every button and link", () => {
    for (const s of [html(), html({ view: "add" }), html({ tile: false })]) {
      const tags = rowTags(s);
      expect(tags.length).toBeGreaterThan(0);
      for (const t of tags) expect(t).toContain("min-h-11");
    }
  });

  it("the underline look lists everything as before: nothing is tucked there", () => {
    expect(labels(html({ tile: false }))).toEqual(["Invoices", "Estimates", "Photos", "Permits"]);
  });
});

describe("the panel never hides under the bottom dock (bug triage 2026-09-27)", () => {
  it("More is placed by the shared glass-menu placement, like Manage and the team menus", () => {
    const src = readFileSync(join(process.cwd(), "src/components/tabs.tsx"), "utf8");
    expect(src).toContain("const { panelRef, panelStyle } = useGlassMenuPlacement(open);");
    expect(src).toMatch(/ref=\{panelRef\}\s+role="menu"\s+style=\{\{ \.\.\.panelStyle, right: 0 \}\}/);
  });
});
