import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PHASE 5 CARDS ON SCREEN: the Panel tab's Print card (since the panel-first wave: Door Labels
 * and Circuit Map for everyone, Save As Circuit Map under it for the office) and the Customer Page
 * tab's switch with its preview of exactly what the customer reads (unchanged). 44px targets and
 * Title Case on every clickable.
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
import { FINAL_MAP, J011, PANEL, circuit } from "@/lib/panel/__fixtures__/honeysuckle";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const clickables = (html: string) => [...html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({ attrs: m[2], label: text(m[3]).trim() }));
const titleCase = (label: string) => label.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z0-9]/.test(w));

describe("the Panel tab's Print card (one door: Door Labels and Circuit Map)", () => {
  // The night's map with the first few in spaces, so the strips have words to fit.
  const PLACED = FINAL_MAP.map((c, i) => (i < 6 ? { ...c, space: i + 1 } : c));

  it("the office: Door Labels, Circuit Map and Save As Circuit Map under it, 44px and Title Case", () => {
    const html = renderToStaticMarkup(createElement(PanelDirectoryCard, { jobId: J011, staff: true, circuits: PLACED, panel: PANEL }));
    const t = text(html);
    const cs = clickables(html);
    expect(cs.map((c) => c.label)).toEqual(["Door Labels", "Circuit Map", "Save As Circuit Map"]);
    for (const c of cs) {
      expect(c.attrs).toMatch(/min-h-\[44px\]|h-11|h-10|min-h-11/);
      expect(titleCase(c.label)).toBe(true);
    }
    // Door Labels: the labels page for THIS panel, in the same window (no popup, no target).
    expect(html).toContain(`href="/print/panel-labels/${J011}?panel=${PANEL.id}"`);
    expect(html).not.toContain("target=");
    expect(t).toContain("Two strips at true size, cut on the line. Width 1.125 in; change it under Edit Panel.");
    expect(t).not.toContain("tight");
    // Circuit Map: the same PDF viewer page as before, and the saved document's door beside it.
    expect(html).toContain(`href="/print/pdf-preview?doc=panel&amp;id=${J011}&amp;back=${encodeURIComponent(`/jobs/${J011}?tab=panel`)}"`);
    expect(t).toContain("The door card and the circuit map, from the 22 kept circuits.");
    expect(t).toContain("Save As Circuit Map puts it on the customer's Plans And Drawings");
    expect(html.indexOf("Circuit Map</a>")).toBeLessThan(html.indexOf("Save As Circuit Map"));
    // Nothing on the tab is called Panel Directory any more.
    expect(t).not.toContain("Panel Directory");
    expect(html).toContain('aria-label="Print"');
  });

  it("says a tight label on the card, before anyone opens the labels page", () => {
    const long = { ...FINAL_MAP[0], space: 1, panel_label: "Bedroom And Chandelier Lights Over The Stair Landing" };
    const narrow = { ...PANEL, label_width_in: 0.5 };
    const html = renderToStaticMarkup(createElement(PanelDirectoryCard, { jobId: J011, staff: false, circuits: [long, ...FINAL_MAP.slice(1)], panel: narrow }));
    const t = text(html);
    expect(t).toContain("Width 0.5 in; change it under Edit Panel.");
    expect(t).toContain("1 label is tight — shorten it or widen the strip.");
    // A left and a right measured apart are both said.
    const two = renderToStaticMarkup(
      createElement(PanelDirectoryCard, { jobId: J011, staff: false, circuits: PLACED, panel: { ...PANEL, label_width_in: 1.25, label_width_in_right: 1.5 } }),
    );
    expect(text(two)).toContain("Width 1.25 in left, 1.5 in right; change it under Edit Panel.");
  });

  it("a tech prints both; Save As Circuit Map is the office's and never renders for the crew", () => {
    const html = renderToStaticMarkup(createElement(PanelDirectoryCard, { jobId: J011, staff: false, circuits: PLACED, panel: PANEL }));
    expect(clickables(html).map((c) => c.label)).toEqual(["Door Labels", "Circuit Map"]);
    expect(text(html)).not.toContain("Save As Circuit Map");
  });

  it("no panel handed in: Door Labels still opens the job's first panel, and no width is guessed", () => {
    const html = renderToStaticMarkup(createElement(PanelDirectoryCard, { jobId: J011, staff: false, circuits: FINAL_MAP }));
    expect(html).toContain(`href="/print/panel-labels/${J011}"`);
    const t = text(html);
    expect(t).toContain("Two strips at true size, cut on the line.");
    expect(t).not.toContain("Width");
  });

  it("a one-panel job's loose kept circuits are counted on the card the way the labels page prints them (lib/panel/held)", () => {
    const loose = { ...FINAL_MAP[0], space: 1, panel_id: null, panel_label: "Bedroom And Chandelier Lights Over The Stair Landing" };
    const narrow = { ...PANEL, label_width_in: 0.5 };
    const card = (livePanels: number) =>
      text(renderToStaticMarkup(createElement(PanelDirectoryCard, { jobId: J011, staff: false, circuits: [loose, ...FINAL_MAP.slice(1)], panel: narrow, livePanels })));
    // The only panel: the loose one is on its strips, and its tight name is said here.
    expect(card(1)).toContain("1 label is tight — shorten it or widen the strip.");
    // Several panels: it is nobody's until a person picks, so this panel's strips don't carry it.
    expect(card(2)).not.toContain("tight");
  });

  it("the printed Circuit Map is called Circuit Map everywhere: the page, its print button, the sheet and the PDF's file name", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const page = readFileSync(join(process.cwd(), "src/app/print/panel/[jobId]/page.tsx"), "utf8");
    expect(page).toContain('<PrintButton label="Print Circuit Map" />');
    expect(page).toContain('docTitle("Circuit Map"');
    expect(page).not.toMatch(/docType: "Panel Directory"|label="Print Panel Directory"|docTitle\("Panel Directory"/);
    const route = readFileSync(join(process.cwd(), "src/app/api/pdf/[doc]/[id]/route.ts"), "utf8");
    expect(route).toContain("filename = `Circuit Map${jobName");
    expect(route).not.toContain("`Panel Directory");
  });

  it("kept circuits with no space yet: the labels door says the strips print blank", () => {
    const t = text(renderToStaticMarkup(createElement(PanelDirectoryCard, { jobId: J011, staff: true, circuits: FINAL_MAP, panel: PANEL })));
    expect(t).toContain("No kept circuit has a space on this panel yet, so the strips print blank.");
  });

  it("nothing kept: no door to an empty page, and it says why", () => {
    const html = renderToStaticMarkup(
      createElement(PanelDirectoryCard, {
        jobId: J011,
        staff: true,
        circuits: [circuit({ room: "Garage", description: "Freezer", amps: 20, state: "suggested", source: "nort" })],
        panel: PANEL,
      }),
    );
    expect(clickables(html)).toEqual([]);
    expect(text(html)).toContain("Keep circuits first. The labels and the circuit map print the kept ones.");
  });
});

describe("the Customer Page tab's panel switch", () => {
  const preview = [directoryFromRows(PANEL, FINAL_MAP)];
  const view = (over: Partial<Parameters<typeof PanelCardView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(PanelCardView, {
        who: "Andrew Crake",
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
    expect(t).toContain("Andrew Crake doesn't see the panel. Turn it on when the list is ready.");
    expect(t).toContain("What Andrew Crake Would See");
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
    expect(t).toContain("What Andrew Crake Sees");
    expect(t).toContain('On their Plans And Drawings: "Circuit Map", shown Sep 25, 2026.');
  });

  it("no panel yet: no switch, a way to the Panel tab", () => {
    const html = view({ panels: [], preview: [] });
    expect(html).not.toContain('role="switch"');
    expect(text(html)).toContain("This job has no panel yet.");
    expect(clickables(html).map((c) => c.label)).toEqual(["Go To Panel"]);
  });
});
