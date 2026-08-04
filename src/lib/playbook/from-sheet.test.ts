import { describe, it, expect } from "vitest";
import { askFromLabel, needFromField, playbookFromSheet, sheetFromPlaybook } from "./from-sheet";
import { applicableNeeds, isClosed, missingNeeds } from "./resolve";
import { parseInspectionSchema } from "@/lib/inspection/schema";
import { STARTER_TRADES, starterSchemaJson } from "@/lib/inspection/starter-sheets";
import type { Playbook } from "./types";

/**
 * The bridge exists so the migration is boring: a forms.schema written in July keeps working,
 * unchanged, through every phase of the playbook build. If these tests hold, nobody's sheet
 * breaks — including Chris's, which took a month of real use to shake out.
 */

describe("a converted sheet behaves exactly as it did", () => {
  it.each(STARTER_TRADES)("%s: same needs, same keys, same order", (trade) => {
    const fields = parseInspectionSchema(starterSchemaJson(trade));
    const pb = playbookFromSheet(starterSchemaJson(trade));
    expect(pb.needs.map((n) => n.key)).toEqual(fields.map((f) => f.key));
  });

  it.each(STARTER_TRADES)("%s: still lands on exactly one question", (trade) => {
    // The thesis, re-asserted through the new engine. If conversion changed this, it changed the
    // product.
    expect(applicableNeeds(playbookFromSheet(starterSchemaJson(trade)), {})).toHaveLength(1);
  });

  it.each(STARTER_TRADES)("%s: every converted sheet is CLOSED — no accidental interviews", (trade) => {
    // A sheet has only closed fields, so converting one must never produce an open need. If it
    // did, an org that never asked for a model would suddenly meet one.
    expect(isClosed(playbookFromSheet(starterSchemaJson(trade)), {})).toBe(true);
  });

  it("the same answers reveal the same next questions", () => {
    const pb = playbookFromSheet(starterSchemaJson("deck"));
    const after = applicableNeeds(pb, { work_type: "New deck" }).map((n) => n.key);
    expect(after).toContain("length");
    expect(after).toContain("width");
    expect(after).not.toContain("stair_count");
  });
});

describe("showIf becomes a one-clause when, and fires identically", () => {
  it("carries the rule across", () => {
    const n = needFromField({ key: "b", label: "B", type: "text", showIf: { key: "a", in: ["x"] } });
    expect(n.when).toEqual([{ key: "a", in: ["x"] }]);
  });

  it("an unruled field stays unconditional", () => {
    expect(needFromField({ key: "a", label: "A", type: "text" }).when).toBeUndefined();
  });
});

describe("a checkbox becomes a two-option question, and that is the point", () => {
  it("Yes / No, not a silent boolean", () => {
    // "Permit needed" as a checkbox could only be answered yes-or-silence, and silence got stored
    // as no. As a two-option select it must be ANSWERED, and the answer is visible.
    const n = needFromField({ key: "permit", label: "Permit needed", type: "checkbox" });
    expect(n.slot).toEqual({ type: "select", options: ["Yes", "No"] });
  });

  it("and it counts as missing until somebody picks one", () => {
    const pb: Playbook = { needs: [needFromField({ key: "permit", label: "Permit needed", type: "checkbox" })] };
    expect(missingNeeds(pb, {}).map((n) => n.key)).toEqual(["permit"]);
    expect(missingNeeds(pb, { permit: "No" })).toEqual([]);
  });
});

describe("ask is mechanical, never inventive", () => {
  it.each([
    ["What kind of work", "What kind of work?"],
    ["Is there attic access?", "Is there attic access?"],
    ["Panel", "Panel?"], // still a poor question — the conversion does not pretend to know better
    ["Run (ft)", "Run (ft)?"],
  ])("%s → %s", (label, expected) => {
    expect(askFromLabel(label)).toBe(expected);
  });

  it("never returns an empty ask for a real field", () => {
    for (const trade of STARTER_TRADES)
      for (const n of playbookFromSheet(starterSchemaJson(trade)).needs) expect(n.ask.trim()).not.toBe("");
  });
});

describe("round trip — nothing that mattered is lost", () => {
  it.each(STARTER_TRADES)("%s survives sheet → playbook → sheet", (trade) => {
    const before = parseInspectionSchema(starterSchemaJson(trade));
    const after = sheetFromPlaybook(playbookFromSheet(starterSchemaJson(trade)));
    expect(after.map((f) => f.key)).toEqual(before.map((f) => f.key));
    expect(after.map((f) => f.showIf ?? null)).toEqual(before.map((f) => f.showIf ?? null));
    // measured drives kit sizing — losing it silently un-sizes a deck.
    expect(after.map((f) => !!f.measured)).toEqual(before.map((f) => !!f.measured));
  });

  it("a checkbox comes back as a select, which is a DELIBERATE one-way change", () => {
    const back = sheetFromPlaybook(playbookFromSheet([{ key: "permit", label: "Permit needed", type: "checkbox" }]));
    expect(back[0].type).toBe("select");
    expect(back[0].options).toEqual(["Yes", "No"]);
  });
});

describe("what the old shape cannot carry is dropped, not mangled", () => {
  const rich: Playbook = {
    needs: [
      { key: "work", label: "Work", ask: "What are we doing?", slot: { type: "select", options: ["A", "B"] } },
      { key: "why", label: "Why", ask: "Why now?" }, // OPEN
      { key: "m", label: "Method", ask: "Fish or surface?", slot: { type: "text" },
        when: [{ key: "work", in: ["A"] }, { key: "why", known: true }] }, // TWO clauses
    ],
  };

  it("an open need has no sheet field — a control-less box is furniture", () => {
    expect(sheetFromPlaybook(rich).map((f) => f.key)).toEqual(["work", "m"]);
  });

  it("a multi-clause need degrades to UNCONDITIONAL, never half-gated", () => {
    // Showing a question too often is a nuisance. Hiding it on a rule the old engine cannot
    // evaluate is a question nobody knows they were meant to answer — the Tahoe Deck failure.
    expect(sheetFromPlaybook(rich).find((f) => f.key === "m")?.showIf).toBeUndefined();
  });
});

describe("the real tenants convert", () => {
  it("a sheet with a field the parser drops converts without throwing", () => {
    const pb = playbookFromSheet([
      { key: "ok", label: "Fine", type: "text" },
      { key: "bad", label: "Bad", type: "signature" }, // not a known type
      null,
      "garbage",
    ]);
    expect(pb.needs.map((n) => n.key)).toEqual(["ok"]);
  });

  it("an empty or unreadable schema is an empty playbook, not a crash", () => {
    expect(playbookFromSheet(null).needs).toEqual([]);
    expect(playbookFromSheet("nope").needs).toEqual([]);
  });
});
