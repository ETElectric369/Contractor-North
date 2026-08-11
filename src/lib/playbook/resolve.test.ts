import { describe, it, expect } from "vitest";
import {
  acceptFill,
  applicableNeeds,
  splitAsk,
  isSettled,
  applyFills,
  clearInapplicable,
  holdingNeeds,
  isClosed,
  isOpen,
  missingNeeds,
  numbersIn,
} from "./resolve";
import type { Playbook } from "./types";

/**
 * THE JOB THIS FILE IS BUILT AROUND — 13125 Moraine Rd, Erik's own words:
 *
 *   "adding outlets and lights in a storage room they're converting. they're pulling a permit for
 *    occupancy. main panel's way the hell over on the other side but the meter panel's right here
 *    with two open slots."
 *
 * The shipped sheet answered that by asking him for the panel brand.
 */

const ERIK: Playbook = {
  needs: [
    { key: "work", label: "Kind of work", ask: "What are we doing here?",
      slot: { type: "select", multi: true, options: ["Add circuits", "Lighting", "Service / panel", "Troubleshoot"] } },
    { key: "power_source", label: "Where the power's coming from", hold: true,
      ask: "Where's the power coming from — which panel, how far, what's open in it?",
      why: "Ask me the fork; don't ask me for its outputs.",
      when: [{ key: "work", in: ["Add circuits", "Lighting"] }] },
    { key: "permitted", label: "Permit, and what for", hold: true,
      ask: "Is anybody pulling a permit, and for what?" },
    { key: "feed", label: "Feed", ask: "Subpanel, or home runs?",
      slot: { type: "select", options: ["Subpanel at the source", "Home runs to the existing panel"] },
      when: [{ key: "power_source", known: true }] },
    { key: "run_ft", label: "Run (ft)", ask: "How far, source to the work?", measured: true,
      slot: { type: "number", unit: "ft" }, when: [{ key: "feed", known: true }] },
    { key: "walls", label: "Walls", ask: "Walls open, or already finished?",
      slot: { type: "select", options: ["Open", "Finished", "Some of each"] } },
    { key: "wiring_method", label: "Wiring method", ask: "Fish it, or run surface?",
      slot: { type: "select", options: ["Fish it", "Surface EMT", "Surface MC"] },
      // THE CONJUNCTION. Meaningless before both are known.
      when: [{ key: "walls", known: true }, { key: "permitted", known: true }] },
  ],
};

const CHRIS: Playbook = {
  needs: [
    { key: "work", label: "Kind of job", ask: "What kind of job?",
      slot: { type: "select", options: ["New deck", "Repair"] } },
    { key: "length", label: "Length", ask: "How long?", measured: true,
      slot: { type: "number", unit: "ft" }, when: [{ key: "work", in: ["New deck"] }] },
    { key: "width", label: "Width", ask: "How deep?", measured: true,
      slot: { type: "number", unit: "ft" }, when: [{ key: "work", in: ["New deck"] }] },
  ],
};

describe("you land on one question", () => {
  it("nothing applies until the work is named", () => {
    const first = applicableNeeds(ERIK, {});
    // `permitted` and `walls` carry no `when`, so they apply from the start — that is the author's
    // choice, and the linter is what argues about landing shape. What matters here is that nothing
    // GATED leaks in early.
    expect(first.map((n) => n.key)).toEqual(["work", "permitted", "walls"]);
    expect(first.map((n) => n.key)).not.toContain("run_ft");
  });
});

describe("the multi-select router — Erik's job was outlets AND lights", () => {
  it("a single answer opens its branch", () => {
    expect(applicableNeeds(ERIK, { work: ["Add circuits"] }).map((n) => n.key)).toContain("power_source");
  });

  it("BOTH at once still opens it — a one-value router is the old failure rebuilt", () => {
    expect(applicableNeeds(ERIK, { work: ["Add circuits", "Lighting"] }).map((n) => n.key)).toContain("power_source");
  });

  it("an unrelated branch does not", () => {
    expect(applicableNeeds(ERIK, { work: ["Troubleshoot"] }).map((n) => n.key)).not.toContain("power_source");
  });
});

describe("THE CONJUNCTION — the question that was unanswerable", () => {
  const base = { work: ["Add circuits"], power_source: "meter panel, 2 slots", feed: "Subpanel at the source" };

  it("wiring method waits for BOTH walls and permit", () => {
    expect(applicableNeeds(ERIK, { ...base, walls: "Finished" }).map((n) => n.key)).not.toContain("wiring_method");
    expect(applicableNeeds(ERIK, { ...base, permitted: "Occupancy" }).map((n) => n.key)).not.toContain("wiring_method");
  });

  it("and appears the moment both are known", () => {
    const both = { ...base, walls: "Finished", permitted: "Occupancy" };
    expect(applicableNeeds(ERIK, both).map((n) => n.key)).toContain("wiring_method");
  });

  it("run_ft does not exist before the feed is settled", () => {
    // "subpanel makes it 25 ft of feeder, home runs makes it 100+ each. Asking me for one number
    // is why my brain goes sideways."
    const noFeed = { work: ["Add circuits"], power_source: "meter panel, 2 slots" };
    expect(missingNeeds(ERIK, noFeed).map((n) => n.key)).not.toContain("run_ft");
    expect(missingNeeds(ERIK, { ...noFeed, feed: "Subpanel at the source" }).map((n) => n.key)).toContain("run_ft");
  });
});

describe("a satisfied need is never asked", () => {
  it("the storage-room paragraph collapses the ask", () => {
    // What Nort extracts from one breath. Every one of these was said unprompted.
    const heard = {
      work: ["Add circuits", "Lighting"],
      permitted: "Occupancy — homeowner pulling it",
      power_source: "Meter panel adjacent, 2 open slots; main panel far side",
    };
    const still = missingNeeds(ERIK, heard).map((n) => n.key);
    expect(still).not.toContain("work");
    expect(still).not.toContain("permitted");
    expect(still).not.toContain("power_source");
    expect(still).toEqual(["feed", "walls"]);
  });

  it("nothing is holding once the hold needs are satisfied", () => {
    expect(holdingNeeds(ERIK, {}).map((n) => n.key)).toEqual(["permitted"]);
    expect(holdingNeeds(ERIK, { work: ["Add circuits"] }).map((n) => n.key)).toEqual(["power_source", "permitted"]);
  });
});

describe("silence is never an answer", () => {
  it.each([[null], [undefined], [""], ["   "], [[]]])("%s counts as unanswered", (v) => {
    expect(missingNeeds(ERIK, { work: v as never }).map((n) => n.key)).toContain("work");
  });

  it("but false and 0 are real answers", () => {
    const pb: Playbook = { needs: [{ key: "x", label: "X", ask: "X?", slot: { type: "number" } }] };
    expect(missingNeeds(pb, { x: 0 })).toEqual([]);
    expect(missingNeeds(pb, { x: false as never })).toEqual([]);
  });
});

describe("STATIC vs DYNAMIC is derived, and Chris never meets a model", () => {
  it("Chris's playbook is closed on every branch", () => {
    expect(isClosed(CHRIS, {})).toBe(true);
    expect(isClosed(CHRIS, { work: "New deck" })).toBe(true);
    expect(CHRIS.needs.every((n) => !isOpen(n))).toBe(true);
  });

  it("Erik's is open, because it holds sentences no control can carry", () => {
    expect(isClosed(ERIK, {})).toBe(false);
  });

  it("nobody declares the mode — it follows from the data", () => {
    // Add one open need to Chris's and his branch becomes an interview. That is the ONLY way it
    // can happen, and it takes him editing his own playbook.
    const withOpen: Playbook = { needs: [...CHRIS.needs, { key: "gotcha", label: "Gotcha", ask: "Anything odd?" }] };
    expect(isClosed(withOpen, {})).toBe(false);
  });
});

describe("stale answers can't ride into a price", () => {
  it("switching the work nulls what that choice hid — ALL THE WAY DOWN THE CHAIN", () => {
    // The bug this caught: one pass clears power_source, but feed's rule reads the answers it was
    // GIVEN, where power_source is still set — so feed survives, and run_ft survives under it. A
    // 25-ft measurement from an abandoned branch would have ridden into the estimate as a fact.
    // The old sheet's rules were one key deep so this never arose; `when` allows chains.
    const answered = { work: ["Add circuits"], power_source: "meter panel", feed: "Subpanel at the source", run_ft: 25 };
    const switched = clearInapplicable(ERIK, { ...answered, work: ["Troubleshoot"] });
    expect(switched.power_source).toBeNull();
    expect(switched.feed).toBeNull();
    expect(switched.run_ft).toBeNull();
  });

  it("keeps what still applies", () => {
    const answered = { work: ["Add circuits"], power_source: "meter panel", feed: "Subpanel at the source", run_ft: 25 };
    const same = clearInapplicable(ERIK, answered);
    expect(same.run_ft).toBe(25);
    expect(same.feed).toBe("Subpanel at the source");
  });

  it("terminates on a playbook whose rules point every which way", () => {
    // The loop is bounded by the need count; a pathological playbook must not hang a phone.
    const messy: Playbook = {
      needs: [
        { key: "a", label: "A", ask: "A?", slot: { type: "text" } },
        { key: "b", label: "B", ask: "B?", slot: { type: "text" }, when: [{ key: "a", known: true }] },
        { key: "c", label: "C", ask: "C?", slot: { type: "text" }, when: [{ key: "b", known: true }] },
        { key: "d", label: "D", ask: "D?", slot: { type: "text" }, when: [{ key: "c", known: true }] },
      ],
    };
    expect(clearInapplicable(messy, { b: "x", c: "y", d: "z" })).toEqual({ a: null, b: null, c: null, d: null });
  });
});

describe("numbersIn — what a phrase actually contains", () => {
  it.each([
    ["about 25 feet", [25]],
    ["sixteen by twenty four", [16, 24]],
    ["1,200", [1, 200]], // the comma splits; the gate only needs the value to APPEAR
    ["a hundred feet of twelve two", [12, 2]],
    ["there's a roll-up door on that wall", []],
    ["four cans", [4]],
  ])("%s → %j", (t, expected) => {
    expect(numbersIn(t as string)).toEqual(expected);
  });
});

describe("THE PROVENANCE GATE — a calculator input must trace to words a human said", () => {
  const runFt = ERIK.needs.find((n) => n.key === "run_ft")!;
  const walls = ERIK.needs.find((n) => n.key === "walls")!;

  it("accepts a number that is actually in the words", () => {
    expect(acceptFill(runFt, { key: "run_ft", value: 25, heard: "about 25 feet" }, "it's about 25 feet")).toBe("accept");
  });

  it("REJECTS a number the model computed rather than heard", () => {
    // The failure this forbids: the model working out a perimeter in its head and handing it over
    // as if somebody had measured it.
    expect(acceptFill(runFt, { key: "run_ft", value: 80, heard: "sixteen by twenty four" }, "sixteen by twenty four")).toBe("reject");
  });

  it("rejects a fill whose words aren't in the transcript at all", () => {
    expect(acceptFill(runFt, { key: "run_ft", value: 25, heard: "25 feet" }, "the panel is far away")).toBe("reject");
  });

  it("rejects a number invented from a phrase containing none", () => {
    expect(acceptFill(runFt, { key: "run_ft", value: 10, heard: "a roll-up door" }, "there's a roll-up door")).toBe("reject");
  });

  it("but context needs are ungated — only calculator inputs carry the burden", () => {
    expect(acceptFill(walls, { key: "walls", value: "Finished" }, "")).toBe("accept");
  });
});

describe("applyFills — fill holes, never overwrite, never drop silently", () => {
  it("writes into an empty need", () => {
    const r = applyFills(ERIK, {}, [{ key: "walls", value: "Finished" }], "walls are finished");
    expect(r.answers.walls).toBe("Finished");
    expect(r.rejected).toEqual([]);
  });

  it("refuses to overwrite a hand-typed value, and SAYS SO", () => {
    const r = applyFills(ERIK, { walls: "Open" }, [{ key: "walls", value: "Finished" }], "finished");
    expect(r.answers.walls).toBe("Open");
    expect(r.rejected.map((f) => f.key)).toEqual(["walls"]);
  });

  it("a rejected measurement is returned, not swallowed — so it can be re-asked", () => {
    const r = applyFills(ERIK, {}, [{ key: "run_ft", value: 10, heard: "a roll-up door" }], "there's a roll-up door");
    expect(r.answers.run_ft).toBeUndefined();
    expect(r.rejected).toHaveLength(1);
  });

  it("a key the playbook never declared is an invention, not a fill", () => {
    const r = applyFills(ERIK, {}, [{ key: "sqft", value: 384 }], "");
    expect(r.answers.sqft).toBeUndefined();
    expect(r.rejected.map((f) => f.key)).toEqual(["sqft"]);
  });
});

/**
 * THE KEYBOARD BUG, as a resolver fact — bug 48fbfd6e, "Can't type, keyboard disappears with one
 * click", filed from 13125 Moraine Rd. That walk-through's scope still reads "The scope of the job
 * is to add" and stops there: he could not enter the rest.
 *
 * The inspector renders a need in exactly ONE of three lists — ask / spine / answered — chosen by
 * whether it has an answer. Those are three different places in the tree, so the FIRST character
 * moved the textarea to another branch, React remounted it, and iOS took the keyboard with it.
 *
 * The fix holds the classification still while the cursor is in the field: the inspector passes a
 * view of the answers with the focused key blanked, so a half-typed answer is not yet an answer.
 * These assertions are what that view has to make true.
 */
describe("a half-typed answer must not reclassify its own field", () => {
  const pb: Playbook = {
    needs: [
      { key: "work", label: "Scope", ask: "What's the work?" },
      { key: "panel", label: "Panel", ask: "What's the panel?", slot: { type: "text" } },
    ],
  };

  it("one character normally moves the need out of the ask — the bug", () => {
    expect(missingNeeds(pb, {}).map((n) => n.key)).toContain("work");
    expect(missingNeeds(pb, { work: "T" }).map((n) => n.key)).not.toContain("work");
  });

  it("blanking the focused key keeps it exactly where it was, mid-word", () => {
    const settled = { work: null };
    expect(missingNeeds(pb, settled).map((n) => n.key)).toContain("work");
    // …and it stays there no matter how much he types, until he leaves the field.
    expect(missingNeeds(pb, { ...settled }).map((n) => n.key)).toContain("work");
  });

  it("only the FOCUSED field is held — everything else classifies normally", () => {
    const settled = { work: null, panel: "Siemens 200A" };
    const keys = missingNeeds(pb, settled).map((n) => n.key);
    expect(keys).toContain("work");
    expect(keys).not.toContain("panel");
  });

  it("on blur it reclassifies, which is when he is actually done", () => {
    expect(missingNeeds(pb, { work: "2 outlets on each of 3 walls" }).map((n) => n.key)).not.toContain("work");
  });
});

/**
 * HELD ≠ UNANSWERED TO THE `when` GRAPH (cn-v699).
 *
 * cn-v698 froze a need's classification by handing the resolver a copy of the answers with the
 * held key nulled. That is the same object applicableNeeds reads, so holding a router HID its
 * answer and every question gated on it disappeared mid-gesture.
 *
 * The shape below is Vivian Builders' live site inspection: a chain of eight multi-selects where
 * each question gates the next. Andrew taps one chip and the rest of his sheet should still be
 * there.
 */
describe("held keys freeze the zone without hiding the answer", () => {
  const chain: Playbook = {
    needs: [
      { key: "symptom", label: "Type", ask: "What type of project?", slot: { type: "select", options: ["New Construction", "Addition"], multi: true } },
      { key: "sub", label: "If new", ask: "If new construction, then…", when: [{ key: "symptom", in: ["New Construction"] }], slot: { type: "select", options: ["SFD", "Multi"], multi: true } },
      { key: "scope", label: "Plans", ask: "Plans prepared?", slot: { type: "select", options: ["Yes", "No"], multi: true } },
      { key: "size", label: "Size", ask: "How big?", when: [{ key: "scope", known: true }], slot: { type: "number" } },
    ],
  };
  const answers = { symptom: ["New Construction"], scope: ["Yes"] };
  const holdSymptom: ReadonlySet<string> = new Set(["symptom"]);

  it("the question gated on the chip being tapped STAYS ON SCREEN", () => {
    expect(applicableNeeds(chain, answers).map((n) => n.key)).toContain("sub");
    // The regression: with the answer masked, `sub` vanished the moment symptom was held.
    expect(missingNeeds(chain, answers, holdSymptom).map((n) => n.key)).toContain("sub");
  });

  it("the held need itself keeps its place in the ask list", () => {
    expect(missingNeeds(chain, answers, holdSymptom).map((n) => n.key)).toContain("symptom");
    // …and drops out again the moment the hold is released.
    expect(missingNeeds(chain, answers).map((n) => n.key)).not.toContain("symptom");
  });

  it("holding one link does not collapse the rest of the chain", () => {
    const keys = missingNeeds(chain, answers, new Set(["scope"])).map((n) => n.key);
    expect(keys).toContain("size"); // gated on scope being KNOWN
    expect(keys).toContain("scope");
  });

  it("splitAsk carries the hold through to the ask/reach split", () => {
    const { ask } = splitAsk(chain, answers, new Set(), holdSymptom);
    expect(ask.map((n) => n.key)).toEqual(expect.arrayContaining(["symptom", "sub"]));
  });

  it("isSettled is the exact inverse used for the answered/spine zones", () => {
    expect(isSettled(answers, "symptom")).toBe(true);
    expect(isSettled(answers, "symptom", holdSymptom)).toBe(false);
    expect(isSettled(answers, "size")).toBe(false);
  });

  it("no hold behaves exactly as before — every existing caller is untouched", () => {
    expect(missingNeeds(chain, answers).map((n) => n.key)).toEqual(missingNeeds(chain, answers, new Set()).map((n) => n.key));
  });
});
