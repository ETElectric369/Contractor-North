import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PHASE 5 CARDS ON SCREEN: the Panel tab's directory card (Print Panel Directory for everyone,
 * Save As Circuit Map for the office) and the Customer Page tab's switch with its preview of exactly
 * what the customer reads. 44px targets and Title Case on every clickable.
 */
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("../panel-portal-actions", () => ({
  saveCircuitMap: vi.fn(),
  undoCircuitMap: vi.fn(),
  loadPanelPortal: vi.fn(),
  setPanelOnPortal: vi.fn(),
}));

import { PanelDirectoryCard } from "./job-panel-directory";
import { PanelCardView } from "./job-portal-panel";
import { directoryFromRows } from "@/lib/panel/directory";
import { FINAL_MAP, J011, PANEL, circuit } from "@/lib/panel/__fixtures__/herringbone";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const clickables = (html: string) => [...html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({ attrs: m[2], label: text(m[3]).trim() }));
const titleCase = (label: string) => label.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z0-9]/.test(w));

describe("the Panel tab's directory card", () => {
  it("the office: Print Panel Directory and Save As Circuit Map, 44px and Title Case", () => {
    const html = renderToStaticMarkup(createElement(PanelDirectoryCard, { jobId: J011, staff: true, circuits: FINAL_MAP }));
    const t = text(html);
    expect(t).toContain("The door card and the circuit map, from the 22 kept circuits.");
    const cs = clickables(html);
    expect(cs.map((c) => c.label)).toEqual(["Print Panel Directory", "Save As Circuit Map"]);
    for (const c of cs) {
      expect(c.attrs).toMatch(/min-h-\[44px\]|h-11|h-10|min-h-11/);
      expect(titleCase(c.label)).toBe(true);
    }
    expect(html).toContain(`href="/print/pdf-preview?doc=panel&amp;id=${J011}&amp;back=${encodeURIComponent(`/jobs/${J011}?tab=panel`)}"`);
  });

  it("a tech prints; Save As Circuit Map is the office's and never renders for the crew", () => {
    const html = renderToStaticMarkup(createElement(PanelDirectoryCard, { jobId: J011, staff: false, circuits: FINAL_MAP }));
    expect(clickables(html).map((c) => c.label)).toEqual(["Print Panel Directory"]);
    expect(text(html)).not.toContain("Circuit Map");
  });

  it("nothing kept: no door to an empty page, and it says why", () => {
    const html = renderToStaticMarkup(
      createElement(PanelDirectoryCard, { jobId: J011, staff: true, circuits: [circuit({ room: "Garage", description: "Freezer", amps: 20, state: "suggested", source: "nort" })] }),
    );
    expect(clickables(html)).toEqual([]);
    expect(text(html)).toContain("Keep circuits first. The directory prints the kept ones.");
  });
});

describe("the Customer Page tab's panel switch", () => {
  const preview = [directoryFromRows(PANEL, FINAL_MAP)];
  const view = (over: Partial<Parameters<typeof PanelCardView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(PanelCardView, {
        who: "Andrew Cohen",
        jobId: J011,
        panels: [{ id: PANEL.id, name: "Main Panel", shown: false }],
        preview,
        circuitMap: null,
        busy: false,
        onFlip: () => {},
        ...over,
      }),
    );

  it("OFF by default: says the customer doesn't see it, and previews what they would", () => {
    const html = view();
    const t = text(html);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(t).toContain("Show The Panel On Their Page");
    expect(t).toContain("Andrew Cohen doesn't see the panel. Turn it on when the list is ready.");
    expect(t).toContain("What Andrew Cohen Would See");
    expect(html).toContain('data-panel-line="— · Entry Lights · feeds Kitchen And Living Lights · 15A"');
    expect(t).toContain("Never shown: part numbers, suppliers, prices, wire tags, notes, progress, or suggestions nobody kept.");
    for (const c of clickables(html)) {
      expect(c.attrs).toMatch(/min-h-\[44px\]/);
      expect(titleCase(c.label)).toBe(true);
    }
  });

  it("ON: says it is live on their page; the circuit map on their page is named", () => {
    const html = view({ panels: [{ id: PANEL.id, name: "Main Panel", shown: true }], circuitMap: { documentId: "d", title: "Circuit Map", sharedAt: "2026-09-25T17:00:00Z" } });
    const t = text(html);
    expect(html).toContain('aria-checked="true"');
    expect(t).toContain("What Andrew Cohen Sees");
    expect(t).toContain('On their Plans And Drawings: "Circuit Map", shown Sep 25, 2026.');
  });

  it("no panel yet: no switch, a way to the Panel tab", () => {
    const html = view({ panels: [], preview: [] });
    expect(html).not.toContain('role="switch"');
    expect(text(html)).toContain("This job has no panel yet.");
    expect(clickables(html).map((c) => c.label)).toEqual(["Go To Panel"]);
  });
});
