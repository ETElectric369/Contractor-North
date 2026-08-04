import { describe, it, expect } from "vitest";
import { aboutFromSetup, applyDraft, draftRequest, explainWhy } from "./draft-playbook";
import { playbookFromSheet } from "@/lib/playbook/from-sheet";
import { starterSchemaJson } from "@/lib/inspection/starter-sheets";
import { applicableNeeds } from "@/lib/playbook/resolve";
import type { Playbook } from "@/lib/playbook/types";

const ELECTRICAL = playbookFromSheet(starterSchemaJson("electrical"));

describe("what the drafter is told", () => {
  const req = draftRequest(ELECTRICAL, aboutFromSetup({ trade: "general contractor, subs out electrical", city: "Reno", labor_rate: 110 }));

  it("his own words about his business ride along", () => {
    expect(req).toContain("subs out electrical");
    expect(req).toContain("Reno");
    expect(req).toContain("$110/hr");
  });

  it("every question, by key, with its shape", () => {
    for (const n of ELECTRICAL.needs) expect(req).toContain(`key: ${n.key}`);
    expect(req).toContain("he picks one of:");
  });

  it("a measured question is flagged as feeding a price", () => {
    const withMeasured = draftRequest(
      { needs: [{ key: "run_ft", label: "Run", ask: "Run?", slot: { type: "number", unit: "ft" }, measured: true }] },
      "x",
    );
    expect(withMeasured).toContain("feeds a price");
  });

  it("an existing why is handed over to IMPROVE, never silently replaced", () => {
    const pb: Playbook = { needs: [{ key: "a", label: "A", ask: "A?", why: "because the meter base falls off" }] };
    expect(draftRequest(pb, "x")).toContain("IMPROVE, do not discard");
    expect(draftRequest(pb, "x")).toContain("meter base falls off");
  });

  it("nothing known yet still produces a sentence, not an empty prompt", () => {
    expect(aboutFromSetup({})).toContain("Nothing else known");
  });
});

describe("STRUCTURE IS NEVER TAKEN FROM THE MODEL — only prose", () => {
  const drafted = applyDraft(ELECTRICAL, {
    needs: [
      { key: "work_type", ask: "What are we doing here?", why: "It routes everything under it." },
      { key: "panel_brand", ask: "What brand is the panel?", why: "Zinsco and I am not touching it." },
      { key: "GHOST", ask: "invented", why: "invented" },
    ],
  });

  it("same keys, same order, same count — a question cannot be invented or dropped", () => {
    expect(drafted.needs.map((n) => n.key)).toEqual(ELECTRICAL.needs.map((n) => n.key));
    expect(drafted.needs.map((n) => n.key)).not.toContain("GHOST");
  });

  it("slots and rules pass through untouched", () => {
    for (let i = 0; i < ELECTRICAL.needs.length; i++) {
      expect(drafted.needs[i].slot).toEqual(ELECTRICAL.needs[i].slot);
      expect(drafted.needs[i].when).toEqual(ELECTRICAL.needs[i].when);
    }
    // ...so the resolver behaves identically after a draft as before it.
    expect(applicableNeeds(drafted, {}).map((n) => n.key)).toEqual(applicableNeeds(ELECTRICAL, {}).map((n) => n.key));
  });

  it("the prose it DID write lands", () => {
    const panel = drafted.needs.find((n) => n.key === "panel_brand")!;
    expect(panel.ask).toBe("What brand is the panel?");
    expect(panel.why).toContain("Zinsco");
  });

  it("a need the model skipped keeps what it had — silence is not a deletion", () => {
    const untouched = drafted.needs.find((n) => n.key === "run_ft")!;
    const before = ELECTRICAL.needs.find((n) => n.key === "run_ft")!;
    expect(untouched.ask).toBe(before.ask);
  });

  it("FILL HOLES, NEVER OVERWRITE A HAND — a why somebody wrote is untouchable", () => {
    // Erik's own playbook carries fifteen long why lines in his own words. A walk-through that
    // quietly reworded them would destroy the exact thing this build exists to capture, and he'd
    // have to read fifteen paragraphs closely to notice. Enforced in code, not asked for in the
    // prompt — same law as the provenance gate.
    const his: Playbook = {
      needs: [{ key: "feed", label: "Feed", ask: "Subpanel, or home runs?", why: "The fork itself. Everything is downstream of it." }],
    };
    const after = applyDraft(his, {
      needs: [{ key: "feed", ask: "How will power be distributed?", why: "Determines the electrical distribution strategy." }],
    });
    expect(after.needs[0].why).toBe(his.needs[0].why);
    expect(after.needs[0].ask).toBe(his.needs[0].ask);
  });

  it("...but a BLANK one gets drafted, which is the whole point", () => {
    const blank: Playbook = { needs: [{ key: "feed", label: "Feed", ask: "Feed?" }] };
    const after = applyDraft(blank, { needs: [{ key: "feed", ask: "Subpanel, or home runs?", why: "The fork." }] });
    expect(after.needs[0].why).toBe("The fork.");
    expect(after.needs[0].ask).toBe("Subpanel, or home runs?");
  });

  it("garbage in leaves the playbook exactly as it was", () => {
    for (const junk of [null, undefined, "nope", {}, { needs: "x" }, { needs: [1, null] }])
      expect(applyDraft(ELECTRICAL, junk)).toEqual(ELECTRICAL);
  });
});

describe("walking one why line, out loud", () => {
  const n = { key: "permitted", label: "Permit", ask: "Is anybody pulling a permit, and what for?", why: "It's a second trip.", hold: true };

  it("says the question, the drafted reason, and what to do about it", () => {
    const t = explainWhy(n, 0, 6);
    expect(t).toContain("Is anybody pulling a permit");
    expect(t).toContain("It's a second trip.");
    expect(t.toLowerCase()).toContain("change it");
  });

  it("the FIRST one explains the format; later ones don't repeat the lecture", () => {
    // Teaching by repetition is how people learn to skip. Say it once, then trust them.
    expect(explainWhy(n, 0, 6).length).toBeGreaterThan(explainWhy(n, 3, 6).length);
    expect(explainWhy(n, 0, 6)).toContain("one at a time");
    expect(explainWhy(n, 3, 6)).not.toContain("one at a time");
  });

  it("flags the two that carry consequences", () => {
    expect(explainWhy(n, 1, 6)).toContain("shouldn't price without");
    expect(explainWhy({ ...n, hold: undefined, measured: true }, 1, 6)).toContain("goes straight into a price");
  });

  it("a blank why says it's blank rather than pretending there's a reason", () => {
    expect(explainWhy({ ...n, why: undefined }, 1, 6)).toContain("no reason written");
  });

  it("and it always ends somewhere — last one says so", () => {
    expect(explainWhy(n, 5, 6)).toContain("Last one");
  });
});
