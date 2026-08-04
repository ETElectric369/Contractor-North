import { describe, it, expect } from "vitest";
import { parsePlaybook, playbookForForm } from "./parse";
import { ET_ELECTRIC } from "./starters/et-electric";
import { applicableNeeds, missingNeeds } from "./resolve";
import { starterSchemaJson } from "@/lib/inspection/starter-sheets";

/** What jsonb hands back — the document has been through JSON and nothing enforced a type. */
const roundTrip = (pb: unknown) => JSON.parse(JSON.stringify(pb));

describe("Erik's playbook survives the database", () => {
  const back = parsePlaybook(roundTrip(ET_ELECTRIC));

  it("every need, in order", () => {
    expect(back.needs.map((n) => n.key)).toEqual(ET_ELECTRIC.needs.map((n) => n.key));
  });

  it("nothing is lost — asks, slots, rules, holds, whys", () => {
    expect(back).toEqual(ET_ELECTRIC);
  });

  it("AND IT STILL ANSWERS HIS PARAGRAPH", () => {
    // The acceptance test, re-run through storage. If a playbook only behaves before it is
    // saved, it is a demo.
    const heard = {
      work: ["Add circuits", "Lighting"],
      permitted: "Occupancy — homeowner pulling it",
      power_source: "Meter panel adjacent, 2 open slots; main panel far side",
    };
    const still = missingNeeds(back, heard).map((n) => n.key);
    expect(still).not.toContain("work");
    expect(still).not.toContain("permitted");
    expect(still).toContain("feed");
    expect(still).not.toContain("run_ft"); // the fork has to be settled first
  });
});

describe("how a broken document degrades — every direction is a decision", () => {
  it("a rule naming an unknown need loses the RULE, not the question", () => {
    // Hiding a question behind a rule nothing can evaluate is a question nobody knows they were
    // meant to answer — six of Chris's rules could never match, and that is how it looked.
    const pb = parsePlaybook({ needs: [{ key: "a", label: "A", ask: "A?", when: [{ key: "ghost", in: ["x"] }] }] });
    expect(pb.needs[0].when).toBeUndefined();
    expect(applicableNeeds(pb, {}).map((n) => n.key)).toEqual(["a"]);
  });

  it("a rule naming a LATER need is the same thing — forward rules can't resolve in one pass", () => {
    const pb = parsePlaybook({
      needs: [
        { key: "a", label: "A", ask: "A?", when: [{ key: "b", known: true }] },
        { key: "b", label: "B", ask: "B?" },
      ],
    });
    expect(pb.needs[0].when).toBeUndefined();
  });

  it("a select with no options goes OPEN — a box you can type in beats a question you can't answer", () => {
    const pb = parsePlaybook({ needs: [{ key: "a", label: "A", ask: "A?", slot: { type: "select", options: [] } }] });
    expect(pb.needs[0].slot).toBeUndefined();
  });

  it("a duplicate key drops the second need — two needs on one key overwrite each other", () => {
    const pb = parsePlaybook({ needs: [{ key: "a", label: "One" }, { key: "a", label: "Two" }] });
    expect(pb.needs.map((n) => n.label)).toEqual(["One"]);
  });

  it("no ask is filled in mechanically, never left blank", () => {
    // An open need renders NOTHING but its ask, so a blank one is a question that can't be asked.
    expect(parsePlaybook({ needs: [{ key: "panel", label: "Panel" }] }).needs[0].ask).toBe("Panel?");
    expect(parsePlaybook({ needs: [{ key: "panel" }] }).needs[0].ask).toBe("panel?");
  });

  it("garbage is an empty playbook, not a crash at a job site", () => {
    for (const junk of [null, undefined, "nope", 42, {}, { needs: "x" }, [null, 3, "a"]])
      expect(parsePlaybook(junk).needs).toEqual([]);
  });

  it("a clause that is neither in/known/unknown is dropped", () => {
    const pb = parsePlaybook({
      needs: [{ key: "a", label: "A" }, { key: "b", label: "B", when: [{ key: "a" }, { key: "a", in: ["x"] }] }],
    });
    expect(pb.needs[1].when).toEqual([{ key: "a", in: ["x"] }]);
  });
});

describe("playbookForForm — one read, and it is a no-op until somebody writes one", () => {
  it("no playbook column: the sheet is converted, exactly as before", () => {
    const pb = playbookForForm({ schema: starterSchemaJson("electrical"), playbook: null });
    expect(pb.needs.length).toBeGreaterThan(1);
    expect(applicableNeeds(pb, {})).toHaveLength(1);
  });

  it("a playbook column wins over the sheet", () => {
    const pb = playbookForForm({ schema: starterSchemaJson("electrical"), playbook: roundTrip(ET_ELECTRIC) });
    expect(pb.needs.map((n) => n.key)).toEqual(ET_ELECTRIC.needs.map((n) => n.key));
  });

  it("an EMPTY playbook column falls back rather than showing a blank sheet", () => {
    // `{}` and `{needs:[]}` are what a half-finished write leaves behind. Falling through to the
    // sheet keeps the inspector working; honouring the empty document makes it render nothing,
    // which is how the whole per-trade engine sat invisible in production for months.
    for (const empty of [{}, { needs: [] }, null])
      expect(playbookForForm({ schema: starterSchemaJson("deck"), playbook: empty }).needs.length).toBeGreaterThan(1);
  });

  it("no form at all is an empty playbook, not a throw", () => {
    expect(playbookForForm(null).needs).toEqual([]);
    expect(playbookForForm(undefined).needs).toEqual([]);
  });
});
