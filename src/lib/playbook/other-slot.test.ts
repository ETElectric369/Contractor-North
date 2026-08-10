import { describe, it, expect } from "vitest";
import { coerceByPlaybook } from "./answers";
import { hearRequest } from "./hear";
import { playbookFromSheet, sheetFromPlaybook } from "./from-sheet";
import { parseInspectionSchema } from "@/lib/inspection/schema";
import { publicIntakeNeeds } from "./public-intake";
import type { Playbook } from "./types";

/**
 * THE DOOR IN THE WALL, END TO END.
 *
 * `other: true` — "you prompt me with options then a 'other' box i use often" — reached the
 * parser, the coercer, the inspector's chip row and the public projection, and stopped. It never
 * reached the fill path, the public form's multi branch, the sheet mirror, or the kind dropdown.
 * It has never bitten because the flag is set on ZERO of the 56 needs in production, so every one
 * of those was a trap armed for whoever ticked the box first.
 *
 * `multi` is the same story with one difference: eight of Vivian Builders' Site-inspection needs
 * ARE multi, so its half of this was live.
 *
 * These lock every crossing the capability has to make. THE PARSER IS THE GATE — a capability that
 * lands in one renderer and calls itself shipped is this codebase's most reliable defect.
 */

const materials: Playbook = {
  needs: [
    {
      key: "permitted",
      label: "Materials",
      ask: "What materials are needed?",
      slot: { type: "select", options: ["Wire", "Lighting & fans", "Panel & breakers"], multi: true, other: true },
    },
    { key: "walls", label: "Walls", ask: "Walls open, or finished?", slot: { type: "select", options: ["Open", "Finished"] } },
  ],
};

describe("the fill path is told the door exists", () => {
  const req = () => hearRequest(materials, {}, "we need about 100 ft of 12/2 romex");

  it("says his own words are allowed on an `other` need", () => {
    const block = req().split("- key: permitted")[1].split("- key:")[0];
    expect(block).toMatch(/his own words/i);
  });

  it("says nothing of the kind on a plain select — the closed set stays closed", () => {
    const block = req().split("- key: walls")[1];
    expect(block).not.toMatch(/his own words/i);
  });

  it("still lists the choices", () => {
    expect(req()).toContain("Wire | Lighting & fans | Panel & breakers");
  });
});

describe("coercion keeps the paragraph, not a chip-sized slice of it", () => {
  // Erik's Sara Cain scope is ~700 characters and the open branch allows 8000. A question that
  // gains choices must not quietly shorten the answer already stored against it.
  const long = "12/2 romex ".repeat(80).trim(); // ~880 chars

  it("a single-value `other` answer survives at open-branch length", () => {
    const pb: Playbook = {
      needs: [{ key: "work", label: "Scope", ask: "What is the job?", slot: { type: "select", options: ["Rough-in"], other: true } }],
    };
    expect(coerceByPlaybook(pb, { work: long }).work).toBe(long);
  });

  it("a multi `other` answer keeps both the taps and the sentence", () => {
    const got = coerceByPlaybook(materials, { permitted: ["Wire", long] }).permitted as string[];
    expect(got).toContain("Wire");
    expect(got).toContain(long);
  });

  it("a need WITHOUT `other` still refuses an unlisted value — the check is not loosened generally", () => {
    expect(coerceByPlaybook(materials, { walls: "Some of each" }).walls).toBeNull();
  });
});

describe("the sheet mirror round-trips both halves", () => {
  // savePlaybook writes sheetFromPlaybook(pb) on every save and clearPlaybook reads it back as
  // truth. A lossy mirror makes the documented undo a data-destroying operation.
  it("multi and other survive playbook → sheet → playbook", () => {
    const back = playbookFromSheet(parseInspectionSchema(sheetFromPlaybook(materials)));
    const slot = back.needs.find((n) => n.key === "permitted")!.slot as { multi?: boolean; other?: boolean; options: string[] };
    expect(slot.multi).toBe(true);
    expect(slot.other).toBe(true);
    expect(slot.options).toEqual(["Wire", "Lighting & fans", "Panel & breakers"]);
  });

  it("a plain select does not gain either on the way through", () => {
    const back = playbookFromSheet(parseInspectionSchema(sheetFromPlaybook(materials)));
    const slot = back.needs.find((n) => n.key === "walls")!.slot as { multi?: boolean; other?: boolean };
    expect(slot.multi).toBeUndefined();
    expect(slot.other).toBeUndefined();
  });

  it("`multi: \"yes\"` in a stored sheet is not truthy enough to widen a question", () => {
    const fields = parseInspectionSchema([
      { key: "a", label: "A", type: "select", options: ["x"], multi: "yes", other: 1 },
    ]);
    expect(fields[0].multi).toBeUndefined();
    expect(fields[0].other).toBeUndefined();
  });
});

describe("the public door carries the door", () => {
  it("publicIntakeNeeds projects multi and other, so the customer gets the exit too", () => {
    const slot = publicIntakeNeeds(materials)[0].slot as { multi?: boolean; other?: boolean };
    expect(slot.multi).toBe(true);
    expect(slot.other).toBe(true);
  });
});
