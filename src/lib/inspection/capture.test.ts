import { describe, it, expect } from "vitest";
import {
  adhocSizing,
  captureItemsToDraftLines,
  fillFromAgent,
  inspectorReadiness,
  looseNumber,
  mergeCaptureSections,
  mergeStaleReplay,
  parseInspectorCapture,
  type CaptureItem,
} from "./capture";

const STORED = {
  notes: "Meter base pulling away from the wall on the south side.",
  measurements: "",
  materials: "roughly 200' of 12-2, a couple of 20A breakers",
  photos: ["org/appointments/a1/1-panel.jpg"],
  quote_id: "q-123",
};

describe("THE ANTI-MIRROR LAW — prose is never written by code", () => {
  it("a patch that touches only items leaves all three prose strings byte-identical", () => {
    // The single most important test in this file. The obvious design regenerates `materials`
    // from `items`; a stale PWA tab then writes an empty string over a list he typed, silently.
    const out = mergeCaptureSections(STORED, {
      items: [{ id: "i1", description: "12-2 romex", quantity: 200, unit: "ft" }],
    });
    expect(out.materials).toBe(STORED.materials);
    expect(out.notes).toBe(STORED.notes);
    expect(out.measurements).toBe(STORED.measurements);
  });

  it("a legacy four-key payload from a cached bundle cannot delete the typed arrays", () => {
    // THE ROLLOUT WINDOW. For hours after deploy the old component keeps posting exactly this
    // shape. It must be unable to express "delete items".
    const withItems = mergeCaptureSections(STORED, {
      items: [{ id: "i1", description: "20A breaker", quantity: 2, unit: "ea" }],
    });
    const legacy = mergeCaptureSections(withItems, {
      notes: "updated from an old tab",
      measurements: "",
      materials: withItems.materials,
      photos: withItems.photos,
    });
    expect(legacy.items).toHaveLength(1);
    expect(legacy.notes).toBe("updated from an old tab");
  });

  it("an absent section is unchanged, not blanked", () => {
    const out = mergeCaptureSections(STORED, { notes: "new note" });
    expect(out.materials).toBe(STORED.materials);
    expect(out.photos).toEqual(STORED.photos);
  });
});

describe("quote_id survives every writer", () => {
  it("through an items-only patch", () => {
    expect(mergeCaptureSections(STORED, { items: [] }).quote_id).toBe("q-123");
  });
  it("through a notes-only patch", () => {
    expect(mergeCaptureSections(STORED, { notes: "x" }).quote_id).toBe("q-123");
  });
  it("through a stale replay", () => {
    expect(mergeStaleReplay(STORED, { notes: "x" }).quote_id).toBe("q-123");
  });
});

describe("a quantity is null or a number, never a silent zero", () => {
  it.each([["a while", null], ["", null], ["about a dozen", null], ["85", 85], ["1,200", 1200], ["85 ft", 85]])(
    "%s → %s",
    (input, expected) => {
      expect(looseNumber(input)).toBe(expected);
    },
  );

  it("survives the parser, so an unparseable spoken quantity never prices as zero", () => {
    const c = parseInspectorCapture({
      ...STORED,
      items: [{ id: "i1", description: "romex", quantity: "a while", unit: "ft" }],
    });
    expect(c.items![0].quantity).toBeNull();
  });

  it("an unpriced line still becomes a real estimate line with quantity 1, not 0", () => {
    // qty 0 on an estimate line reads as "none of these", which is not what "I didn't count" means.
    const lines = captureItemsToDraftLines([{ id: "i", description: "romex", quantity: null, unit: "ft" }]);
    expect(lines[0].quantity).toBe(1);
    expect(lines[0].unit_price).toBe(0);
    expect(typeof lines[0].unit_price).toBe("number"); // DraftLineItem.unit_price is non-nullable
  });
});

describe("NORT FILLS HOLES, NEVER OVERWRITES A HAND", () => {
  const base = {
    ...STORED,
    items: [
      { id: "typed", description: "12-2 romex", quantity: 200, unit: "ft" },
      { id: "blank", description: "20A breaker", quantity: null, unit: "ea" },
    ],
  };

  it("leaves a hand-typed quantity alone and SAYS SO", () => {
    const r = fillFromAgent(base, { items: [{ id: "x", description: "12-2 romex", quantity: 150, unit: "ft" }] });
    expect(r.capture.items!.find((i) => i.id === "typed")!.quantity).toBe(200);
    expect(r.skipped).toEqual(["12-2 romex"]); // the spoken refusal, not silence
  });

  it("fills the one that was left empty", () => {
    const r = fillFromAgent(base, { items: [{ id: "x", description: "20A breaker", quantity: 2, unit: "ea" }] });
    expect(r.capture.items!.find((i) => i.id === "blank")!.quantity).toBe(2);
    expect(r.skipped).toEqual([]);
  });

  it("a session-manual id is protected even when its value is still empty", () => {
    const r = fillFromAgent(base, { items: [{ id: "x", description: "20A breaker", quantity: 9, unit: "ea" }] }, new Set(["blank"]));
    expect(r.capture.items!.find((i) => i.id === "blank")!.quantity).toBeNull();
    expect(r.skipped).toEqual(["20A breaker"]);
  });

  it("adds a line nobody had, flagged as heard", () => {
    const r = fillFromAgent(base, { items: [{ id: "x", description: "weatherhead", quantity: 1, unit: "ea" }] });
    const added = r.capture.items!.find((i) => i.description === "weatherhead")!;
    expect(added.flag).toBe("heard");
  });

  it("anything it could not map lands in notes VERBATIM", () => {
    // Nothing said on site is discarded because the sheet had no box for it.
    const r = fillFromAgent(base, { notesAppend: "he wants the sub outside by the gate" });
    expect(r.capture.notes).toContain(STORED.notes);
    expect(r.capture.notes).toContain("he wants the sub outside by the gate");
  });

  it("the same for measures", () => {
    const withM = { ...STORED, measures: [{ id: "m1", label: "run to garage", value: 85, unit: "ft" }] };
    const r = fillFromAgent(withM, { measures: [{ id: "x", label: "run to garage", value: 60, unit: "ft" }] });
    expect(r.capture.measures![0].value).toBe(85);
    expect(r.skipped).toEqual(["run to garage"]);
  });
});

describe("a flag is a live hint, never stored", () => {
  it("mergeCaptureSections output carries no flag at any depth", () => {
    const out = mergeCaptureSections(STORED, {
      items: [{ id: "i", description: "romex", quantity: 1, unit: "ft", flag: "heard" } as CaptureItem],
      measures: [{ id: "m", label: "run", value: 1, unit: "ft", flag: "heard" }],
    });
    expect(JSON.stringify(out)).not.toContain("flag");
  });
});

describe("a stale offline replay unions, it does not clobber", () => {
  it("keeps what the office added AND what the crawlspace queued", () => {
    const current = mergeCaptureSections(STORED, {
      items: [{ id: "office", description: "meter socket", quantity: 1, unit: "ea" }],
      notes: "office edited this while he was underground",
    });
    const replayed = mergeStaleReplay(current, {
      items: [{ id: "field", description: "romex", quantity: 200, unit: "ft" }],
    });
    expect(replayed.items!.map((i) => i.id).sort()).toEqual(["field", "office"]);
    // Scalars: storage wins, so a two-hour-old note cannot resurrect over a newer one.
    expect(replayed.notes).toBe("office edited this while he was underground");
  });

  it("does not duplicate a row that is already there", () => {
    const current = mergeCaptureSections(STORED, { items: [{ id: "same", description: "romex", quantity: 200, unit: "ft" }] });
    expect(mergeStaleReplay(current, { items: [{ id: "same", description: "romex", quantity: 200, unit: "ft" }] }).items).toHaveLength(1);
  });
});

describe("orphan photo placement is dropped", () => {
  it("a caption whose photo was deleted does not outlive it", () => {
    const c = parseInspectorCapture({
      ...STORED,
      photo_meta: { "org/appointments/a1/1-panel.jpg": { about: "Panel brand" }, "gone.jpg": { about: "nothing" } },
    });
    expect(Object.keys(c.photo_meta!)).toEqual(["org/appointments/a1/1-panel.jpg"]);
  });
});

describe("ad-hoc sizing is narrow on purpose", () => {
  it("a run is linear", () => {
    expect(adhocSizing([{ id: "m", label: "railing run", value: 62, unit: "ft" }]).linearFt).toBe(62);
  });

  it("a WIDTH is neither — one side of something is not a length", () => {
    // Guessing here is how a made-up number reaches a customer's price.
    const s = adhocSizing([{ id: "m", label: "trench width", value: 2, unit: "ft" }]);
    expect(s.sqft).toBeNull();
    expect(s.linearFt).toBeNull();
  });

  it("a zero or null measure sizes nothing", () => {
    expect(adhocSizing([{ id: "m", label: "area", value: 0, unit: "sqft" }]).sqft).toBeNull();
    expect(adhocSizing([{ id: "m", label: "area", value: null, unit: "sqft" }]).sqft).toBeNull();
  });
});

describe("the status strip counts, it never expresses confidence", () => {
  it("separates what is captured from what still needs confirming", () => {
    const r = fillFromAgent(STORED, {
      items: [{ id: "x", description: "romex", quantity: 200, unit: "ft" }],
      measures: [{ id: "y", label: "run", value: 85, unit: "ft" }],
    });
    const s = inspectorReadiness(r.capture);
    expect(s.items).toBe(1);
    expect(s.measures).toBe(1);
    expect(s.toConfirm).toBe(2); // both arrived by voice
    expect(s.hasProse).toBe(true);
  });
});

describe("nothing is ruled out", () => {
  it("an empty capture round-trips to the four keys the app has always had", () => {
    const c = parseInspectorCapture({});
    expect(c).toEqual({ notes: "", measurements: "", materials: "", photos: [] });
  });

  it("the prose measurements box survives even though nobody has used it", () => {
    // Used on 0 of 11 real inspections and KEPT anyway: the unanticipated sentence is the one
    // that saves the job, and "nothing gets ruled out" was an instruction, not a preference.
    expect(mergeCaptureSections(STORED, { measurements: "35' to the far corner, uphill" }).measurements).toBe(
      "35' to the far corner, uphill",
    );
  });
});
