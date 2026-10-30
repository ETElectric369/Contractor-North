import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * FILLING AN OPEN LINE (the panel-first wave, P1), pinned on "Snowbell": the form a person picks
 * (Single · Tandem · 2-Pole · 3-Pole) is the space, half and poles Add A Circuit gets; a form that
 * would sit on a breaker already there, on No Stab or past the end is said in the model's words in
 * the sheet and Keep waits (never a silent save); a tandem the panel label doesn't allow is said and
 * still kept; a stand-in Panel 1 sends no panel, so the server makes the real one with the circuit.
 */

const s = vi.hoisted(() => ({ calls: [] as unknown[][], reply: null as unknown }));
vi.mock("../panel-actions", () => ({
  addCircuit: vi.fn(async (...args: unknown[]) => {
    s.calls.push(args);
    return s.reply;
  }),
}));

import { FORM_WORDS, LINE_FORMS, PanelLineSheet, formWords, lineDraft, linePayload, lineProblems, sendLine, startForm } from "./panel-line-sheet";
import type { JobCircuit, JobPanel } from "@/lib/types";

const PANEL_ID = "44444444-4444-4444-8444-444444444444"; // Snowbell's Panel 1 (a uuid: the write checks)
const SNOWBELL: JobPanel = {
  id: PANEL_ID,
  org_id: "org-snowbell",
  job_id: "job-snowbell",
  name: "Panel 1",
  brand: "Siemens",
  bus_amps: 125,
  main_amps: 125,
  spaces: 12,
  numbering: "top_down",
  dead_spaces: [11],
  twin_spaces: [1, 3],
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
const kept = (space: number, half: "A" | "B" | null, description: string, over: Partial<JobCircuit> = {}): JobCircuit => ({
  id: `snowbell-${++seq}`,
  org_id: "org-snowbell",
  job_id: "job-snowbell",
  panel_id: PANEL_ID,
  room: null,
  description,
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
});

// 1A Hall (1B open), 9 Bath Fan, 11 No Stab.
const hall = kept(1, "A", "Hall");
const fan = kept(9, null, "Bath Fan");
const CIRCUITS = [hall, fan];
const V = { description: "Dryer", room: "laundry", amps: "30", work: "new" as const };

beforeEach(() => {
  s.calls = [];
  s.reply = { ok: true, row: { ...kept(7, null, "Dryer"), id: "new-row" } };
});

describe("the form is where the circuit goes", () => {
  it("a whole open line starts on Single; a half line starts on Tandem in that half", () => {
    expect(startForm({ space: 7, half: null })).toBe("single");
    expect(startForm({ space: 1, half: "B" })).toBe("tandem");
    expect(LINE_FORMS.map((f) => FORM_WORDS[f])).toEqual(["Single", "Tandem", "2-Pole", "3-Pole"]);
  });

  it("Single, Tandem, 2-Pole and 3-Pole on space 7", () => {
    const at = { space: 7, half: null };
    expect(lineDraft(at, "single")).toEqual({ space: 7, half: null, poles: 1 });
    expect(lineDraft(at, "tandem")).toEqual({ space: 7, half: "A", poles: 1 });
    expect(lineDraft(at, "tandem", "B")).toEqual({ space: 7, half: "B", poles: 1 });
    expect(lineDraft(at, "pole2")).toEqual({ space: 7, half: null, poles: 2 });
    expect(lineDraft(at, "pole3")).toEqual({ space: 7, half: null, poles: 3 });
    expect(formWords(lineDraft(at, "pole2"))).toBe("Spaces 7 and 9, on this side.");
    expect(formWords(lineDraft(at, "pole3"))).toBe("Spaces 7, 9 and 11, on this side.");
    expect(formWords(lineDraft(at, "tandem"))).toBe("The top half of space 7 (A); the other half stays open.");
  });

  it("on the open half of a tandem space, the tap fills that half; a 2-pole there is a quad's centre", () => {
    expect(lineDraft({ space: 1, half: "B" }, "tandem", "A")).toEqual({ space: 1, half: "B", poles: 1 });
    expect(lineDraft({ space: 1, half: "B" }, "pole2")).toEqual({ space: 1, half: "B", poles: 2 });
  });

  it("a 2-pole in a half says the spaces it truly covers: on 7B it is 7B and 9A (model slotsOf), never 'the B halves'", () => {
    expect(formWords(lineDraft({ space: 7, half: "B" }, "pole2"))).toBe("Spaces 7B and 9A, on this side.");
    expect(formWords(lineDraft({ space: 7, half: "A" }, "pole2"))).toBe("Spaces 7A and 9B, on this side.");
    expect(formWords(lineDraft({ space: 7, half: "B" }, "pole2"))).not.toContain("halves");
  });

  it("a loose circuit on the job's only panel is in the way of a fill (the held rule), and nobody's with several", () => {
    const loose = kept(5, null, "Loose Porch", { panel_id: null });
    const d = lineDraft({ space: 5, half: null }, "single");
    expect(lineProblems(SNOWBELL, [loose], d, V, { livePanels: 1 }).block).toBe("Space 5 has Loose Porch and Laundry Dryer on it. Pick another form.");
    expect(lineProblems(SNOWBELL, [loose], d, V, { livePanels: 2 }).block).toBeNull();
  });

  it("Keep sends Add A Circuit the space, half and poles of the form, with the words, the room and the work", async () => {
    const r = await sendLine("job-snowbell", SNOWBELL, CIRCUITS, V, lineDraft({ space: 5, half: null }, "pole2"));
    expect(r.ok).toBe(true);
    expect(s.calls).toEqual([
      ["job-snowbell", { description: "Dryer", room: "Laundry", amps: 30, poles: 2, space: 5, half: null, work: "new", panel_id: PANEL_ID }],
    ]);
    await sendLine("job-snowbell", SNOWBELL, CIRCUITS, { ...V, description: "Porch", amps: "15" }, lineDraft({ space: 1, half: "B" }, "tandem"));
    expect(s.calls[1][1]).toMatchObject({ space: 1, half: "B", poles: 1, amps: 15 });
  });

  it("a stand-in Panel 1 (no panel yet) sends no panel: the server makes Panel 1 with the circuit, and it comes back", async () => {
    const made = { ...SNOWBELL, id: "panel-made" };
    s.reply = { ok: true, row: kept(3, null, "Dryer"), panel: made };
    const r = await sendLine("job-snowbell", { ...SNOWBELL, id: "" }, [], V, lineDraft({ space: 3, half: null }, "single"));
    expect(s.calls[0][1]).toMatchObject({ panel_id: null, space: 3 });
    expect(r).toMatchObject({ ok: true, panel: { id: "panel-made" } });
    expect(linePayload({ id: "" }, V, { space: 3, half: null, poles: 1 }).panel_id).toBeNull();
  });
});

describe("never a silent save", () => {
  it("a 2-pole whose next space is taken is said in the model's words and nothing is sent", async () => {
    // 5 + 7 is open; 7 + 9 is not: the Bath Fan is on 9.
    expect(lineProblems(SNOWBELL, CIRCUITS, lineDraft({ space: 5, half: null }, "pole2"), V).block).toBeNull();
    const d2 = lineDraft({ space: 7, half: null }, "pole2");
    expect(lineProblems(SNOWBELL, CIRCUITS, d2, V).block).toBe("Space 9 has Bath Fan and Laundry Dryer on it. Pick another form.");
    const r = await sendLine("job-snowbell", SNOWBELL, CIRCUITS, V, d2);
    expect(r).toEqual({ ok: false, error: "Space 9 has Bath Fan and Laundry Dryer on it. Pick another form." });
    expect(s.calls).toEqual([]);
  });

  it("a Single on the open half of a tandem space would sit on the other half's breaker", () => {
    expect(lineProblems(SNOWBELL, CIRCUITS, lineDraft({ space: 1, half: "B" }, "single"), V).block).toBe("Space 1 has Laundry Dryer and Hall on it. Pick another form.");
  });

  it("No Stab and the end of the panel are said the same way", () => {
    expect(lineProblems(SNOWBELL, [], lineDraft({ space: 9, half: null }, "pole2"), V).block).toBe("Laundry Dryer is on space 11, which has No Stab. Pick another form.");
    expect(lineProblems(SNOWBELL, [], lineDraft({ space: 12, half: null }, "pole2"), V).block).toBe("Laundry Dryer runs to space 14, past the end of this 12-space panel. Pick another form.");
  });

  it("a tandem where the panel label doesn't allow one is said, and still kept (the model's rule: a warning)", async () => {
    const p = lineProblems(SNOWBELL, CIRCUITS, lineDraft({ space: 7, half: null }, "tandem"), V);
    expect(p).toEqual({ block: null, warn: "Laundry Dryer is a tandem on space 7, and the panel label doesn't allow tandems there." });
    expect((await sendLine("job-snowbell", SNOWBELL, CIRCUITS, V, lineDraft({ space: 7, half: null }, "tandem"))).ok).toBe(true);
  });

  it("amps that aren't a breaker size get the server's own words before the trip", async () => {
    const r = await sendLine("job-snowbell", SNOWBELL, CIRCUITS, { ...V, amps: "33" }, lineDraft({ space: 7, half: null }, "single"));
    expect(r).toEqual({ ok: false, error: "33 amps isn't a breaker size. Pick 15, 20, 30…" });
    expect(s.calls).toEqual([]);
  });

  it("a refusal from the server is said, never swallowed", async () => {
    s.reply = { ok: false, error: "That job isn't in your book." };
    expect(await sendLine("job-snowbell", SNOWBELL, CIRCUITS, V, lineDraft({ space: 7, half: null }, "single"))).toEqual({ ok: false, error: "That job isn't in your book." });
  });
});

describe("the sheet on screen", () => {
  const draw = (over: Parameters<typeof PanelLineSheet>[0]["initial"], at = { space: 7, half: null as "A" | "B" | null }) =>
    renderToStaticMarkup(
      createElement(PanelLineSheet, { jobId: "job-snowbell", panel: SNOWBELL, circuits: CIRCUITS, at, initial: over, onAdded: () => {}, onClose: () => {} }),
    );
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], text: m[0].replace(/<[^>]+>/g, "").trim() }));

  it("What It Feeds, Room, the amps as chips with Other, the four forms and the work; every door 44px and Title Case", () => {
    const html = draw({});
    for (const w of ["What It Feeds", "Room", "Amps", "Form", "Work"]) expect(html).toContain(w);
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toEqual(expect.arrayContaining(["15", "20", "30", "40", "50", "60", "Other", "Single", "Tandem", "2-Pole", "3-Pole", "New", "Existing", "Reused", "Keep", "Cancel"]));
    expect(labels).not.toContain("Coming Out");
    for (const b of buttons(html)) {
      if (b.text) expect(b.markup, b.text).toMatch(/h-11|min-h-\[44px\]|h-12/);
      if (b.text) expect(b.text.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w)), b.text).toBe(true);
    }
    expect(html).toContain("Space 7");
  });

  it("a collision is said in the sheet and Keep waits", () => {
    const html = draw({ form: "pole2", description: "Dryer", room: "Laundry" });
    expect(html).toContain("Space 9 has Bath Fan and Laundry Dryer on it. Pick another form.");
    const keep = buttons(html).find((b) => b.text === "Keep")!;
    expect(keep.markup).toContain('disabled=""');
  });

  it("a whole open line on Tandem asks which half; a half line doesn't", () => {
    expect(buttons(draw({ form: "tandem" })).map((b) => b.text)).toEqual(expect.arrayContaining(["Top (A)", "Bottom (B)"]));
    expect(buttons(draw({}, { space: 1, half: "B" })).map((b) => b.text)).not.toContain("Top (A)");
  });
});
