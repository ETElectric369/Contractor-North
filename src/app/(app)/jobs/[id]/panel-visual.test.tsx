import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HALF_LINE_PX, PanelVisual, SPACE_PX, lineText, movePlan, panelVisualModel, type VisualLine } from "./panel-visual";
import type { JobCircuit, JobPanel } from "@/lib/types";

/**
 * THE DOOR AS IT LOOKS, PINNED ON "LARKSPUR" (the panel-first wave, P1): a 24-space Siemens door,
 * odd spaces down the left and even down the right, filled the way a real one is — tandems (two
 * handles, A over B, in one space), a full-width 2-pole (Mini Split on 9 and 11), a quad (outer
 * singles on the A halves, the centre 2-pole on the B halves, the model's way: slotsOf keeps a
 * half), one single (Laundry on 19), open spaces to tap, and a No Stab space, hatched.
 *
 * And the reads on it: a photo suggestion on an open space is a dimmed line with its own Keep; one
 * on a space a kept breaker holds is "Photo says: …" under that line with Use It and Skip; a label
 * check about a kept circuit sits under that circuit's line the same way.
 */

const PANEL_ID = "panel-larkspur";
const LARKSPUR: JobPanel = {
  id: PANEL_ID,
  org_id: "org-larkspur",
  job_id: "job-larkspur",
  name: "Panel 1",
  brand: "Siemens",
  bus_amps: 200,
  main_amps: 200,
  spaces: 24,
  numbering: "top_down",
  dead_spaces: [23],
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

let seq = 0;
function c(space: number | null, half: "A" | "B" | null, words: string | null, over: Partial<JobCircuit> = {}): JobCircuit {
  seq++;
  return {
    id: `larkspur-${seq}`,
    org_id: "org-larkspur",
    job_id: "job-larkspur",
    panel_id: PANEL_ID,
    room: null,
    description: words,
    panel_label: null,
    amps: 20,
    poles: 1,
    kind: null,
    wire: null,
    wire_tag: null,
    space,
    half,
    work: "existing",
    progress: "planned",
    state: "kept",
    source: "hand",
    source_quote_id: null,
    source_document_id: null,
    source_row: null,
    verified: false,
    verified_by: null,
    verified_at: null,
    sort_order: seq,
    created_by: null,
    created_at: "2026-10-30T08:00:00Z",
    updated_by: null,
    updated_at: "2026-10-30T08:00:00Z",
    removed_at: null,
    removed_by: null,
    ...over,
  };
}
const photo = (space: number, half: "A" | "B" | null, label: string, over: Partial<JobCircuit> = {}) =>
  c(space, half, null, { panel_label: label, state: "suggested", source: "photo", work: "existing", source_row: { key: `photo:${space}${half ?? ""}:${label}` }, ...over });

const garage = c(1, "A", "Garage");
const porch = c(1, "B", "Porch");
const split = c(9, null, "Mini Split", { poles: 2, amps: 30 });
// A quad on 5 and 7: the outer singles top and bottom (5A, 7B), the centre 2-pole in the middle
// (kept at 5B; slotsOf: 5B and 7A, straddling the line between the two spaces).
const holiday = c(5, "A", "Holiday", { amps: 15 });
const hall = c(7, "B", "Hall", { amps: 15 });
const floorHeat = c(5, "B", "Floor Heat", { poles: 2, amps: 20 });
const laundry = c(19, null, "Laundry");
const gdo = c(2, "A", "GDO 1");
const ev = c(6, null, "EV Charger", { poles: 2, amps: 50 });
const KEPT = [garage, porch, split, holiday, hall, floorHeat, laundry, gdo, ev];

const wineCooler = photo(13, null, "Wine Cooler");
const washer = photo(19, null, "Washer");
const check = c(null, null, "Mini Split", {
  state: "suggested",
  source: "photo",
  source_row: { key: "photo-flag:split", flag_for: split.id, check: "Panel Says Heat Pump, Your List Says Mini Split.", use: { panel_label: "Heat Pump" }, was: { panel_label: null } },
});
const ALL = [...KEPT, wineCooler, washer, check];

const model = panelVisualModel(LARKSPUR, ALL);
const left = model.rows.map((r) => r.left);
const right = model.rows.map((r) => r.right);
const lineAt = (space: number, half: "A" | "B" | null = null): VisualLine => {
  const cell = [...left, ...right].find((x) => x.space === space)!;
  return cell.lines.find((l) => l.half === half)!;
};

const noop = () => {};
const draw = (circuits: JobCircuit[], panel: JobPanel = LARKSPUR, moving: JobCircuit | null = null) =>
  renderToStaticMarkup(
    createElement(PanelVisual, {
      panel,
      circuits,
      moving,
      onOpen: noop,
      onFill: noop,
      onKeep: noop,
      onUse: noop,
      onSkip: noop,
      onMoveTo: noop,
      onCancelMove: noop,
    }),
  );
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], text: m[0].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim() }));

describe("Larkspur: two columns facing each other", () => {
  it("odd spaces down the left, even down the right, top first: twelve rows of two", () => {
    expect(model.rows).toHaveLength(12);
    expect(left.map((x) => x.space)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
    expect(right.map((x) => x.space)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
    const html = draw(ALL);
    // The space numbers in the order they hang, row by row: 1 beside 2, 3 beside 4…
    expect([...html.matchAll(/data-space="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it("flips when the numbers run bottom up", () => {
    const up = panelVisualModel({ ...LARKSPUR, numbering: "bottom_up" }, KEPT);
    expect(up.rows.map((r) => [r.left.space, r.right.space]).slice(0, 2)).toEqual([
      [23, 24],
      [21, 22],
    ]);
    expect(up.rows.at(-1)).toMatchObject({ left: { space: 1 }, right: { space: 2 } });
  });

  it("a tandem draws two half lines in one space, A over B, each half a 44px space", () => {
    const one = left[0];
    expect(one.lines.map((l) => [l.half, l.kind, lineText(l)])).toEqual([
      ["A", "tandem", "Garage · 20"],
      ["B", "tandem", "Porch · 20"],
    ]);
    const html = draw(ALL);
    expect(html).toMatch(/aria-label="Space 1A: Garage · 20"[^>]*class="[^"]*h-\[22px\]/);
    expect(html).toMatch(/aria-label="Space 1B: Porch · 20"[^>]*class="[^"]*h-\[22px\]/);
    // A tandem space with one handle used: the other half is an open half line to tap.
    expect(right[0].lines.map((l) => [l.half, l.kind])).toEqual([
      ["A", "tandem"],
      ["B", "empty"],
    ]);
    expect(html).toContain('aria-label="Space 2B is open. Tap to fill it."');
  });

  it("a 2-pole draws its words on both of its lines, whole lines, the same breaker", () => {
    expect([lineAt(9), lineAt(11)].map((l) => [l.space, l.kind, lineText(l), l.circuitId])).toEqual([
      [9, "pole2", "Mini Split · 30", split.id],
      [11, "pole2", "Mini Split · 30", split.id],
    ]);
    const html = draw(ALL);
    expect(html.match(/>Mini Split · 30</g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="Space 9: Mini Split · 30"[^>]*class="[^"]*h-11/);
    expect(textOf(html).match(/EV Charger · 50/g)).toHaveLength(2);
  });

  it("a quad's centre 2-pole straddles the space line: its words on 5B and 7A, between the outer singles", () => {
    expect([...left[2].lines, ...left[3].lines].map((l) => `${l.space}${l.half}:${lineText(l)}`)).toEqual([
      "5A:Holiday · 15",
      "5B:Floor Heat · 20",
      "7A:Floor Heat · 20",
      "7B:Hall · 15",
    ]);
    expect(lineAt(5, "B").circuitId).toBe(floorHeat.id);
    expect(lineAt(7, "A").circuitId).toBe(floorHeat.id);
    // The two Floor Heat lines are next to each other: the last line of space 5, the first of 7.
    const column = left.flatMap((x) => x.lines).map((l) => l.circuitId);
    expect(column.indexOf(floorHeat.id) + 1).toBe(column.lastIndexOf(floorHeat.id));
    expect(lineAt(5, "B").heightIn).toBe(0.5);
    expect(lineAt(7, "A").slotHalf).toBe("A");
    expect(model.warnings).toEqual([]);
  });

  it("an open half beside a quad's centre is the half that is open (a fill there writes 7B)", () => {
    const m = panelVisualModel(LARKSPUR, [holiday, floorHeat]);
    const seven = m.rows.find((r) => r.left.space === 7)!.left.lines;
    expect(seven.map((l) => [l.half, l.slotHalf, l.kind, l.circuitId])).toEqual([
      ["A", "A", "pole2", floorHeat.id],
      ["B", "B", "empty", null],
    ]);
  });

  it("an open space is a whole line to tap; No Stab is hatched and nothing to tap", () => {
    expect(lineAt(3)).toMatchObject({ kind: "empty", circuit: null, suggested: null });
    const html = draw(ALL);
    expect(html).toMatch(/<button[^>]*aria-label="Space 3 is open\. Tap to fill it\."[^>]*class="[^"]*h-11/);
    expect(lineAt(23).kind).toBe("dead");
    expect(html).toMatch(/<div data-line="dead"[^>]*style="background-image:repeating-linear-gradient[^"]*"[^>]*>No Stab<\/div>/);
    // While moving, No Stab is a line to tap too: the tab says why nothing can go there.
    expect(draw(ALL, LARKSPUR, laundry)).toMatch(/<button[^>]*data-line="dead"[^>]*>No Stab<\/button>/);
  });

  it("the main breaker on top, and what the box is", () => {
    const t = textOf(draw(ALL));
    expect(t).toContain("200A Main");
    expect(t).toContain("Siemens · 24 Spaces");
    expect(textOf(draw([], { ...LARKSPUR, brand: null, main_amps: null, spaces: null }))).toContain("Main Not Set Brand Not Set · Spaces Not Set");
  });
});

describe("the reads on the door", () => {
  it("a photo suggestion on an open space is a dimmed line with its own Keep", () => {
    const l = lineAt(13);
    expect(l.suggested?.id).toBe(wineCooler.id);
    expect(l.circuit).toBeNull();
    expect(model.dimmed.map((s) => s.id)).toEqual([wineCooler.id]);
    const html = draw(ALL);
    expect(html).toMatch(/data-line="suggested"[^>]*><button[^>]*>.*Space 13, Suggested From The Panel Photo:.*Wine Cooler · 20<\/button><button[^>]*>Keep<\/button>/);
    expect(html).toMatch(/data-line="suggested"[^>]*class="[^"]*opacity-80/);
  });

  it("a photo suggestion on a held space says 'Photo says' under the kept line, with Use It and Skip", () => {
    const l = lineAt(19);
    expect(l.circuit?.id).toBe(laundry.id);
    expect(l.notes.map((n) => [n.kind, n.says, n.words, n.suggestion.id])).toEqual([["words", "Photo says", "Washer", washer.id]]);
    const html = draw(ALL);
    expect(textOf(html)).toContain("Laundry · 20 Photo says: Washer Use It Skip");
  });

  it("a label check about a kept circuit sits under its line the same way", () => {
    expect(lineAt(9).notes.map((n) => [n.kind, n.words])).toEqual([["check", "Heat Pump"]]);
    expect(lineAt(11).notes).toEqual([]);
    expect(model.noted.map((s) => s.id).sort()).toEqual([washer.id, check.id].sort());
  });

  it("what the door can't draw stays off it: no space, past the end, on No Stab, two on one open line", () => {
    const estimate = c(null, null, "Range", { state: "suggested", source: "estimate" });
    const past = photo(25, null, "Past");
    const dead = photo(23, null, "Dead");
    const second = photo(13, null, "Beer Fridge");
    const m = panelVisualModel(LARKSPUR, [...ALL, estimate, past, dead, second]);
    const drawn = new Set([...m.dimmed, ...m.noted].map((s) => s.id));
    for (const s of [estimate, past, dead, second]) expect(drawn.has(s.id), s.panel_label ?? s.description ?? "").toBe(false);
  });

  it("says the model's warnings in one plain line under the door, never silent", () => {
    const clash = [...KEPT, c(19, null, "Freezer")];
    const html = draw(clash);
    expect(textOf(html)).toContain("Space 19 has Laundry and Freezer on it.");
    expect(html.match(/<p class="mt-3 flex items-start[^"]*bg-amber-50/g)).toHaveLength(1);
  });

  it("a circuit on no panel is drawn on the job's only panel (lib/panel/held belongsToPanel), never with several", () => {
    const loose = c(15, null, "Loose", { panel_id: null });
    const at15 = (livePanels?: number) => panelVisualModel(LARKSPUR, [loose], { livePanels }).rows.find((r) => r.left.space === 15)!.left.lines[0].circuit?.id;
    expect(at15()).toBeUndefined();
    expect(at15(1)).toBe(loose.id);
    expect(at15(2)).toBeUndefined();
  });

  it("a read's note carries the kept circuit it is drawn under: Use It names it", () => {
    expect(lineAt(19).notes[0].target.id).toBe(laundry.id);
    expect(lineAt(9).notes[0].target.id).toBe(split.id);
  });
});

describe("a panel with an odd count: the cell beside its last space is not on the panel", () => {
  const ODD = { ...LARKSPUR, spaces: 23, dead_spaces: [] };
  const m = panelVisualModel(ODD, KEPT);
  const last = m.rows.at(-1)!;

  it("draws 23 on the left and nothing to fill beside it: kind none, no space number, no tap", () => {
    expect(last.left.space).toBe(23);
    expect(last.right.lines.map((l) => l.kind)).toEqual(["none"]);
    const html = draw(KEPT, ODD);
    expect(html).not.toContain("Space 24 is open");
    expect(html).toContain('data-line="none"');
    expect(textOf(html)).toContain("Not on this panel");
    expect(html).not.toContain('data-space="24"');
    // Not tappable: never a button.
    expect(html).not.toMatch(/<button[^>]*data-line="none"/);
  });

  it("a 1-space panel is one space and one cell that isn't", () => {
    const one = panelVisualModel({ ...LARKSPUR, spaces: 1, dead_spaces: [] }, []);
    expect(one.rows.map((r) => [r.left.space, r.left.lines[0].kind, r.right.lines[0].kind])).toEqual([[1, "empty", "none"]]);
  });
});

describe("Move: tap a filled line, Move, then tap where it goes", () => {
  it("an open line takes it; a whole line keeps a tandem's half; a half line makes it that half", () => {
    expect(movePlan(LARKSPUR, ALL, laundry, { space: 3, half: null })).toEqual({ ok: true, space: 3, half: null });
    expect(movePlan(LARKSPUR, ALL, porch, { space: 3, half: null })).toEqual({ ok: true, space: 3, half: "B" });
    expect(movePlan(LARKSPUR, ALL, laundry, { space: 2, half: "B" })).toEqual({ ok: true, space: 2, half: "B" });
  });

  it("a line that is taken says so and nothing moves; so do No Stab and the end of the panel", () => {
    expect(movePlan(LARKSPUR, ALL, laundry, { space: 1, half: "A" })).toEqual({ ok: false, words: "Space 1 has Garage on it. Tap an open line." });
    expect(movePlan(LARKSPUR, ALL, laundry, { space: 23, half: null })).toEqual({ ok: false, words: "Space 23 has No Stab. Tap an open line." });
    expect(movePlan(LARKSPUR, ALL, split, { space: 24, half: null })).toEqual({ ok: false, words: "Mini Split would run past the end of this 24-space panel. Tap an open line." });
    expect(movePlan(LARKSPUR, ALL, laundry, { space: 19, half: null })).toEqual({ ok: false, words: "Laundry is on space 19 now. Tap the line it goes to." });
  });

  it("a 3-pole never lands on a half line: it needs three full spaces", () => {
    const motor = c(13, null, "Shop Motor", { poles: 3, amps: 30 });
    expect(movePlan(LARKSPUR, [...KEPT, motor], motor, { space: 2, half: "B" })).toEqual({ ok: false, words: "A 3-pole needs three full spaces. Tap a whole open line." });
    expect(movePlan(LARKSPUR, [...KEPT, motor], motor, { space: 14, half: null })).toEqual({ ok: true, space: 14, half: null });
  });

  it("a 2-pole moves by its first space and checks the next one on its side", () => {
    // Wine Cooler is only a suggestion: it holds nothing, so 13 and 15 are open for the Mini Split.
    expect(movePlan(LARKSPUR, ALL, split, { space: 13, half: null })).toEqual({ ok: true, space: 13, half: null });
    expect(movePlan(LARKSPUR, ALL, split, { space: 17, half: null })).toEqual({ ok: false, words: "Space 19 has Laundry on it. Tap an open line." });
  });

  it("while moving, the door says what is moving and offers Cancel", () => {
    const html = draw(ALL, LARKSPUR, laundry);
    expect(textOf(html)).toContain("Moving Laundry. Tap the line it goes to.");
    expect(buttons(html).map((b) => b.text)).toContain("Cancel");
    expect(html).toMatch(/aria-label="Space 19: Laundry · 20"[^>]*class="[^"]*ring-amber-400/);
    // The dimmed line's Keep waits: the next tap is the move.
    expect(buttons(html).map((b) => b.text)).not.toContain("Keep");
  });
});

describe("the 375px law and the words", () => {
  const html = draw(ALL);
  it("the door's scale is named: a space is 44px, a half line draws half of it", () => {
    expect(SPACE_PX).toBe(44);
    expect(HALF_LINE_PX).toBe(SPACE_PX / 2);
  });

  it("a half line DRAWS 22px and its tap REACHES a whole 44px space, outward and under every drawn line", () => {
    // Every half line that can be tapped has its reach: the top half's runs up, the bottom half's down.
    const reaches = [...html.matchAll(/<span aria-hidden="true" data-reach="(A|B)" class="([^"]*)" style="([^"]*)"><\/span>/g)];
    const halfLines = buttons(html).filter((b) => /data-half-line/.test(b.markup) && !/>Keep</.test(b.markup));
    expect(reaches.length).toBe(halfLines.length);
    for (const [, half, cls, style] of reaches) {
      expect(cls).toContain("z-0");
      expect(style).toContain(`height:${SPACE_PX}px`);
      expect(style).toContain(half === "A" ? `top:-${HALF_LINE_PX}px` : "top:0");
    }
    // Every drawn line, and every note's Use It / Skip, sits a layer above any reach.
    for (const b of buttons(html).filter((x) => /data-line=/.test(x.markup))) expect(b.markup, b.text).toMatch(/z-\[1\]/);
    expect(html).toMatch(/data-line="suggested" class="relative z-\[1\]/);
    expect(html).toMatch(/data-note="words" class="relative z-\[1\]/);
  });

  it("every button is a 44px target, or a tandem's half line (half a 44px space, reaching a whole one), and nothing is wider than a phone", () => {
    for (const b of buttons(html)) {
      if (/data-half-line/.test(b.markup)) expect(b.markup, b.text).toMatch(/h-\[22px\]/);
      else expect(b.markup, b.text).toMatch(/h-11|min-h-\[44px\]/);
    }
    const widths = [...html.matchAll(/(?:min-)?w-\[(\d+)px\]/g)].map((m) => Number(m[1]));
    expect(widths.filter((w) => w > 343)).toEqual([]);
    // Two columns side by side, each allowed to shrink: never a horizontal scroll.
    expect(html).toContain("grid-cols-[minmax(0,1fr)_6px_minmax(0,1fr)]");
    expect(html).not.toMatch(/overflow-x-(auto|scroll)/);
  });

  it("the door's own words are Title Case; nothing on it is a price", () => {
    for (const w of ["Keep", "Use It", "Skip", "No Stab"]) expect(textOf(html)).toContain(w);
    expect(html).not.toMatch(/\$\s?\d/);
  });
});
