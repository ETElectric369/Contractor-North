import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CircuitMapSchedule, PanelDirectoryList, PanelDoorCard } from "./panel-directory";
import { directoryFromRows } from "@/lib/panel/directory";
import { FINAL_MAP, PANEL, circuit } from "@/lib/panel/__fixtures__/herringbone";

/**
 * THE ONE DIRECTORY RENDERER (Panel plan, phase 5): the printed map carries the hand-built J-011
 * map's content, the door card hangs like the door, and the list is the customer's lines.
 */
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("the circuit map page (the hand-built map, as data)", () => {
  const d = directoryFromRows(PANEL, FINAL_MAP);
  const html = renderToStaticMarkup(createElement(CircuitMapSchedule, { circuits: d.circuits }));
  const t = text(html);

  it("the chips and a section per size, as tonight's map read", () => {
    expect(t).toMatch(/22 Circuits 3 15 A 16 20 A 3 240-Volt/);
    expect(t).toContain("15 A Circuits Single-Pole · 3 Circuits");
    expect(t).toContain("20 A Circuits Single-Pole · 16 Circuits");
    expect(t).toContain("240-Volt Circuits Two-Pole · 3 Circuits");
  });

  it("every one of the 22 circuits, by room and what it feeds, with the door's words when they differ", () => {
    for (const words of [
      "Bath Lights",
      "Bedroom And Chandelier Lights",
      "Kitchen And Living Lights (Door Says Entry Lights)",
      "Outlets Right",
      "Outlets Left",
      "Disposal And Insta-Hot",
      "Fridge (Door Says Mini Fridge)",
      "Wine Cooler",
      "Outlets North",
      "TV And Entertainment",
      "Duplex Right",
      "Duplex Left",
      "Outlets West",
      "GFI Outlets",
      "Washer",
      "Dedicated",
      "Floor Heat",
      "Dryer",
      "Range",
    ]) {
      expect(t).toContain(words);
    }
    expect((html.match(/<tr /g) ?? []).length).toBe(22);
    expect(t).toContain("2P 50A GFCI");
    expect(t).toContain("Three circuits were already in the panel and stay in service");
  });

  it("no wire, no tag, no progress, no source: the map goes to the customer", () => {
    for (const secret of ["12/2", "14/2", "6/3", "Planned", "From "]) expect(t).not.toContain(secret);
  });
});

describe("the door card", () => {
  const d = directoryFromRows({ ...PANEL, spaces: 6, dead_spaces: [6] }, [
    circuit({ room: "Kitchen", description: "Range", amps: 50, poles: 2, space: 1, kind: "gfci" }),
    circuit({ room: "Bar", description: "Bar", amps: 20, space: 2, half: "A" }),
    circuit({ room: "Bar", description: "Wine Cooler", amps: 20, space: 2, half: "B" }),
  ]);
  const html = renderToStaticMarkup(createElement(PanelDoorCard, { panel: d }));
  const t = text(html);

  it("odd left, even right; a 2P on both its spaces naming its pair; the twin's halves; No Stab", () => {
    expect((html.match(/<tr /g) ?? []).length).toBe(3);
    expect(t).toMatch(/^ ?1 Range 2P 50A GFCI · With 3 A · Bar 20A B · Wine Cooler 20A 2 3 Range 2P 50A GFCI · With 1 +4 5 +No Stab 6 ?$/);
  });
});

describe("the list the customer reads", () => {
  it("one line per circuit in space order, the space first, a New tag on new work", () => {
    const d = directoryFromRows(PANEL, [
      circuit({ room: "Kitchen", description: "Kitchen And Living", panel_label: "Entry Lights", amps: 15, space: 7, work: "reused" }),
      circuit({ room: "Bath", description: "GFI Outlets", amps: 20, space: 9 }),
    ]);
    const html = renderToStaticMarkup(createElement(PanelDirectoryList, { panel: d }));
    expect(html).toContain('data-panel-line="7 · Entry Lights · feeds Kitchen And Living · 15A"');
    expect(html).toContain('data-panel-line="9 · GFI Outlets · 20A"');
    expect((text(html).match(/\bNew\b/g) ?? []).length).toBe(1);
    // Every line is a 44px row.
    expect((html.match(/<li [^>]*min-h-\[44px\]/g) ?? []).length).toBe(2);
  });
});
