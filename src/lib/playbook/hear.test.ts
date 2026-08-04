import { describe, it, expect } from "vitest";
import { applyHeard, hearRequest, parseHeard } from "./hear";
import { ET_ELECTRIC } from "./starters/et-electric";
import { missingNeeds } from "./resolve";

/**
 * THE PARAGRAPH, verbatim, exactly as he said it — the whole reason any of this exists.
 * The shipped sheet answered it by asking him for the panel brand.
 */
const SAID =
  "2 new circuits one for lights and one for outlets installed new in a finished room with " +
  "sheetrock and paint made originally for storage but now converting to living space requiring " +
  'four 6" recessed cans connected in the ceiling requiring holes to be drilled in sheetrock to ' +
  "get wire into place and 2 outlets on each of 3 walls accessible from below by cutting the " +
  "outlet holes in sheetrock then drilling down to feed wire from one to another all the way " +
  "around connecting to a snap on breaker siemens style, 100 ft of 12.2 romex and 40' of 14/2 romex";

/** What a good extraction off that paragraph looks like. Every `heard` is a real substring. */
const GOOD = {
  fills: [
    { key: "work", value: ["Add circuits", "Lighting"], heard: "2 new circuits one for lights and one for outlets" },
    { key: "walls", value: "Finished", heard: "a finished room with sheetrock and paint" },
    { key: "access", value: "From below — cut and drill", heard: "accessible from below by cutting the outlet holes in sheetrock" },
    { key: "panel_condition", value: "snap on breaker siemens style", heard: "connecting to a snap on breaker siemens style" },
    { key: "materials_known", value: "100 ft of 12-2 and 40 ft of 14-2", heard: "100 ft of 12.2 romex and 40' of 14/2 romex" },
  ],
  leftover: "converting a storage room to living space",
};

describe("what gets asked of the model", () => {
  const req = hearRequest(ET_ELECTRIC, {}, SAID);
  // Once the work is named, the branch under it opens — the fork, the room, the panel.
  const deeper = hearRequest(ET_ELECTRIC, { work: ["Add circuits", "Lighting"] }, SAID);

  it("carries the question and the choices", () => {
    expect(req).toContain("What are we doing here?");
    expect(req).toContain("Add circuits | Lighting");
    expect(req).toContain("(a LIST of these is allowed)"); // outlets AND lights
  });

  it("carries HIS why, not our paraphrase of it", () => {
    expect(deeper).toContain("Ask me the fork. Don't ask me for its outputs.");
  });

  it("flags the measured ones, because those are the ones that become money", () => {
    expect(deeper).toContain("MEASURED");
  });

  it("says what is already known so it doesn't get re-answered or contradicted", () => {
    const withWork = hearRequest(ET_ELECTRIC, { work: ["Add circuits"] }, SAID);
    expect(withWork).toContain("ALREADY KNOWN");
    expect(withWork).toContain("Kind of work: Add circuits");
  });

  it("OFFERS EVERY UNANSWERED NEED, not just the ones that apply yet", () => {
    // The thing a live run proved. He says the whole job in one breath — the work AND the walls
    // AND the outlet count — and those last two wait on the first. Offer only what applies to an
    // empty sheet and half of what he said lands in the leftover instead of in a box.
    expect(req).toContain("key: walls");
    expect(req).toContain("key: device_count");
    expect(req).toContain("key: run_ft"); // gated on a feed nobody has picked — offered anyway
  });

  it("...and never re-offers something already answered", () => {
    expect(hearRequest(ET_ELECTRIC, { walls: "Finished" }, SAID)).not.toContain("key: walls");
  });
});

describe("parsing what comes back", () => {
  it("reads a clean object", () => {
    expect(parseHeard(JSON.stringify(GOOD)).fills).toHaveLength(5);
  });

  it("digs the object out of prose or a fence, because that is a formatting problem", () => {
    const wrapped = "Sure — here you go:\n```json\n" + JSON.stringify(GOOD) + "\n```\nHope that helps.";
    expect(parseHeard(wrapped).fills).toHaveLength(5);
  });

  it("drops a malformed fill rather than guessing at it", () => {
    const messy = parseHeard(
      JSON.stringify({ fills: [{ value: "x" }, { key: "walls" }, { key: "a", value: { deep: 1 } }, { key: "b", value: 3 }] }),
    );
    expect(messy.fills.map((f) => f.key)).toEqual(["b"]);
  });

  it("garbage is nothing, never a throw — this runs on a phone in a crawlspace", () => {
    for (const junk of ["", "no json here", "{ broken", "null"]) expect(parseHeard(junk).fills).toEqual([]);
  });
});

describe("applying it — HIS PARAGRAPH, END TO END", () => {
  const out = applyHeard(ET_ELECTRIC, {}, SAID, parseHeard(JSON.stringify(GOOD)));

  it("five facts land in five boxes", () => {
    expect(out.answers.work).toEqual(["Add circuits", "Lighting"]);
    expect(out.answers.walls).toBe("Finished");
    expect(out.answers.access).toBe("From below — cut and drill");
    expect(out.answers.materials_known).toContain("12-2");
  });

  it("and it says what it did — a fill is never invisible", () => {
    expect(out.filled).toContain("Kind of work");
    expect(out.filled).toContain("Walls");
  });

  it("WHAT'S LEFT IS THE TWO HE MUST NOT PRICE WITHOUT — plus the tape he hasn't pulled", () => {
    const still = missingNeeds(ET_ELECTRIC, out.answers).map((n) => n.key);
    // Nothing he said comes back at him.
    for (const k of ["work", "walls", "access", "panel_condition", "materials_known"])
      expect(still, k).not.toContain(k);
    // He never said where the power comes from or who's permitting it — both HOLDS, both asked.
    expect(still).toContain("power_source");
    expect(still).toContain("permitted");
    // And `feed` stays quiet until the power source is settled: "ask me the fork, don't ask me
    // for its outputs" cuts both ways — the fork itself waits on the fact it forks on.
    expect(still).not.toContain("feed");
    expect(still).toContain("length_ft");
  });
});

describe("the two rules the model does not get to bend", () => {
  // The room questions only exist once the work is named — so does anything that could be a
  // measurement. That is the resolver, not this file, and it is why the base isn't empty.
  const onJob = { work: ["Add circuits"] };

  it("A COMPUTED NUMBER IS REFUSED — the whole reason the gate exists", () => {
    // He said sixteen by twenty. The area is arithmetic and it is somebody else's job; a model
    // handing over 320 as though a tape had been pulled is the failure this forbids.
    const said = "the room is 16 by 20";
    const out = applyHeard(
      ET_ELECTRIC,
      onJob,
      said,
      parseHeard(JSON.stringify({ fills: [{ key: "length_ft", value: 320, heard: "16 by 20" }] })),
    );
    expect(out.answers.length_ft).toBeNull();
    expect(missingNeeds(ET_ELECTRIC, out.answers).map((n) => n.key)).toContain("length_ft");
  });

  it("...and the honest version of the same fill is accepted", () => {
    const out = applyHeard(
      ET_ELECTRIC,
      onJob,
      "the room is 16 by 20",
      parseHeard(JSON.stringify({ fills: [{ key: "length_ft", value: 16, heard: "16 by 20" }] })),
    );
    expect(out.answers.length_ft).toBe(16);
    // ...and the derived count stops being asked, without anybody choosing.
    expect(missingNeeds(ET_ELECTRIC, out.answers).map((n) => n.key)).not.toContain("device_count");
  });

  it("a `heard` that isn't in the transcript is refused — no paraphrasing a measurement", () => {
    const out = applyHeard(
      ET_ELECTRIC,
      onJob,
      "about sixteen feet across",
      parseHeard(JSON.stringify({ fills: [{ key: "length_ft", value: 16, heard: "16 feet across" }] })),
    );
    expect(out.answers.length_ft).toBeNull();
  });

  it("FILL HOLES, NEVER OVERWRITE A HAND", () => {
    const out = applyHeard(
      ET_ELECTRIC,
      { ...onJob, length_ft: 14 },
      "the room is 16 by 20",
      parseHeard(JSON.stringify({ fills: [{ key: "length_ft", value: 16, heard: "16 by 20" }] })),
    );
    expect(out.answers.length_ft).toBe(14);
    // And it doesn't nag about it: his answer standing is the rule working, not a loss.
    expect(out.note).toBe("");
  });

  it("a key the playbook never declared is an invention, not a fill", () => {
    const out = applyHeard(
      ET_ELECTRIC,
      onJob,
      "whatever",
      parseHeard(JSON.stringify({ fills: [{ key: "is_admin", value: true, heard: "whatever" }] })),
    );
    expect(out.answers.is_admin).toBeUndefined();
  });
});

describe("nothing he said is thrown away", () => {
  it("what didn't fit a question goes to the notes, in his words", () => {
    const said = "the meter base is pulling away from the wall";
    const out = applyHeard(ET_ELECTRIC, {}, said, { fills: [], leftover: said });
    expect(out.note).toBe(said);
  });

  it("a REFUSED fill's words go to the notes and its question comes back", () => {
    // "there's a roll-up door on that wall" — no number in it, so nothing is invented, and the
    // sentence survives instead of evaporating.
    const said = "there's a roll-up door on that wall so I lose some outlets";
    const out = applyHeard(
      ET_ELECTRIC,
      { work: ["Add circuits"] },
      said,
      parseHeard(JSON.stringify({ fills: [{ key: "device_count", value: 4, heard: "there's a roll-up door on that wall" }] })),
    );
    expect(out.answers.device_count).toBeNull();
    expect(out.note).toContain("roll-up door");
    expect(missingNeeds(ET_ELECTRIC, out.answers).map((n) => n.key)).toContain("device_count");
  });

  it("the same words twice are one note, not two", () => {
    const said = "watch the dog";
    const out = applyHeard(ET_ELECTRIC, {}, said, {
      fills: [{ key: "length_ft", value: 9, heard: said }],
      leftover: said,
    });
    expect(out.note).toBe(said);
  });
});
