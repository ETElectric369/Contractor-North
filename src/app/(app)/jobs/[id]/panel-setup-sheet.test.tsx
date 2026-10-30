import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PANEL'S SETUP SHEET (the panel-first wave, P1), pinned on "Bayberry": the sizes most panels
 * come in as chips (12 · 20 · 24 · 30 · 40 · 42, the field still takes any number), the makes the
 * door table knows as chips, and the door measured once under Door Labels — Space Pitch and Label
 * Width, each blank by default with the make's size as its placeholder (an inch on a Siemens, three
 * quarters a space on an Eaton CH; 1.125 in of label on a Siemens), and a Right Side Width only
 * behind Different On The Right. A blank field is the make's default: the write clears it.
 */

vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("../panel-actions", () => ({ savePanel: vi.fn() }));

import { BRAND_CHOICES, PanelSetupSheet, SPACE_PRESETS, draftOf, patchOf } from "./panel-setup-sheet";
import { inchWords } from "@/lib/panel/geometry";
import { normalizePanelPatch } from "@/lib/panel/input";
import type { JobPanel } from "@/lib/types";

const BAYBERRY: JobPanel = {
  id: "panel-bayberry",
  org_id: "org-bayberry",
  job_id: "job-bayberry",
  name: "Panel 1",
  brand: "Siemens",
  bus_amps: 200,
  main_amps: 200,
  spaces: 24,
  numbering: "top_down",
  dead_spaces: [],
  twin_spaces: [],
  space_pitch_in: null,
  label_width_in: null,
  label_width_in_right: null,
  photo_document_id: null,
  notes: null,
  shown_on_portal: false,
  created_by: null,
  created_at: "2026-10-30T08:00:00Z",
  updated_by: null,
  updated_at: "2026-10-30T08:00:00Z",
  removed_at: null,
  removed_by: null,
};

const draw = (panel: JobPanel | null) =>
  renderToStaticMarkup(createElement(PanelSetupSheet, { jobId: "job-bayberry", panel, photos: [], onSaved: () => {}, onClose: () => {} }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], text: m[0].replace(/<[^>]+>/g, "").trim() }));
const placeholderOf = (html: string, label: string) => {
  const at = html.indexOf(`>${label}</span>`);
  return at < 0 ? null : (/placeholder="([^"]*)"/.exec(html.slice(at)) ?? [])[1] ?? null;
};

describe("the spaces and the make, as chips", () => {
  const html = draw(BAYBERRY);
  const labels = buttons(html).map((b) => b.text);

  it("offers 12 · 20 · 24 · 30 · 40 · 42, the one the panel has picked, and the field still takes any number", () => {
    expect(SPACE_PRESETS).toEqual([12, 20, 24, 30, 40, 42]);
    expect(labels).toEqual(expect.arrayContaining(["12", "20", "24", "30", "40", "42"]));
    expect(html).toMatch(/aria-checked="true"[^>]*>24</);
    expect(html).toContain('value="24"');
  });

  it("offers the makes the door table knows, the panel's own picked", () => {
    expect(labels).toEqual(expect.arrayContaining([...BRAND_CHOICES]));
    expect(html).toMatch(/aria-checked="true"[^>]*>Siemens</);
  });

  it("every door is 44px and Title Case", () => {
    for (const b of buttons(html)) {
      if (!b.text) continue;
      expect(b.markup, b.text).toMatch(/h-11|min-h-\[44px\]|h-12/);
      expect(b.text.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w)), b.text).toBe(true);
    }
  });
});

describe("Door Labels: the door measured once", () => {
  it("Space Pitch and Label Width are blank, the make's size as the placeholder, with the one line of help", () => {
    const html = draw(BAYBERRY);
    expect(html).toContain("Door Labels");
    expect(html).toContain("Measure the label area beside the breakers once; the printed strips use it.");
    expect(placeholderOf(html, "Space Pitch")).toBe("1");
    expect(placeholderOf(html, "Label Width")).toBe("1.125");
    expect(html).toContain("Different On The Right");
    // The right side's own width hides behind Different On The Right.
    expect(html).not.toContain("Right Side Width");
  });

  it("an Eaton CH door is three quarters of an inch a space; a make nobody named, an inch and an inch", () => {
    expect(placeholderOf(draw({ ...BAYBERRY, brand: "Eaton CH" }), "Space Pitch")).toBe("0.75");
    const plain = draw({ ...BAYBERRY, brand: null });
    expect(placeholderOf(plain, "Space Pitch")).toBe("1");
    expect(placeholderOf(plain, "Label Width")).toBe("1");
    expect(inchWords(1.125)).toBe("1.125");
  });

  it("a measured door shows what was measured, and a right side measured on its own shows its field", () => {
    const html = draw({ ...BAYBERRY, space_pitch_in: 0.875, label_width_in: 1.25, label_width_in_right: 1.5 });
    expect(html).toContain('value="0.875"');
    expect(html).toContain('value="1.25"');
    expect(html).toContain("Right Side Width");
    expect(html).toContain('value="1.5"');
  });

  it("a blank field is the make's default: the write clears it, and a tape reading is inches", () => {
    const d = draftOf({ ...BAYBERRY, space_pitch_in: 1, label_width_in: 1.125 });
    const cleared = patchOf({ ...d, space_pitch_in: "", label_width_in: "  " }, ["space_pitch_in", "label_width_in"]);
    expect(cleared).toEqual({ space_pitch_in: null, label_width_in: null });
    expect(normalizePanelPatch(cleared)).toEqual({ ok: true, value: { space_pitch_in: null, label_width_in: null } });
    const tape = patchOf({ ...d, label_width_in: "1 1/8" }, ["label_width_in"]);
    expect(normalizePanelPatch(tape)).toEqual({ ok: true, value: { label_width_in: 1.125 } });
  });
});

describe("a new panel", () => {
  it("is numbered like Panel 1 and is added with Add New Panel", () => {
    const html = draw(null);
    expect(html).toContain('value="Panel 1"');
    expect(buttons(html).map((b) => b.text)).toContain("Add New Panel");
    expect(html).not.toContain("Add The Panel");
  });
});
