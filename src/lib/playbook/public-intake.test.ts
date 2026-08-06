import { describe, it, expect } from "vitest";
import { INTAKE_STARTER, publicIntakeNeeds } from "./public-intake";
import { ET_ELECTRIC } from "./starters/et-electric";
import { parsePlaybook } from "./parse";
import { applicableNeeds, clearInapplicable } from "./resolve";

describe("THE PROJECTION — nothing private crosses to a public page", () => {
  it("why and note NEVER survive, even fed a playbook full of them", () => {
    // ET's real playbook: every need carries a why, most carry a note — his pricing logic and his
    // war stories. If either ever renders on /intake, every competitor with a browser gets his
    // estimating method. The serialized output is checked, not just the type, because a spread
    // that keeps extra keys would pass a type check and still leak.
    const out = JSON.stringify(publicIntakeNeeds(ET_ELECTRIC));
    expect(out).not.toContain("\"why\"");
    expect(out).not.toContain("\"note\"");
    expect(out).not.toContain("\"feeds\"");
    expect(out).not.toContain("subpanel or home runs"); // a real why line, verbatim
  });

  it("...but keeps everything the door needs: ask, slot, when", () => {
    const out = publicIntakeNeeds(INTAKE_STARTER);
    expect(out.map((n) => n.key)).toEqual(INTAKE_STARTER.needs.map((n) => n.key));
    expect(out.every((n) => n.ask.length > 0)).toBe(true);
    expect(out.find((n) => n.key === "plans_detail")?.when).toBeTruthy();
  });
});

describe("THE STARTER INTAKE — five questions a customer can actually answer", () => {
  it("every need has a SLOT — there is no Nort on the public page to phrase an open one", () => {
    for (const n of INTAKE_STARTER.needs) expect(n.slot, `${n.key} is open`).toBeTruthy();
  });

  it("it round-trips the real parser, so the seed can never be an invalid playbook", () => {
    expect(parsePlaybook(INTAKE_STARTER).needs.map((n) => n.key)).toEqual(
      INTAKE_STARTER.needs.map((n) => n.key),
    );
  });

  it("'Do you have plans?' reveals its follow-up — the conditional Andrew asked for", () => {
    const before = applicableNeeds(INTAKE_STARTER, {}).map((n) => n.key);
    expect(before).not.toContain("plans_detail");
    const after = applicableNeeds(INTAKE_STARTER, { has_plans: "Yes" }).map((n) => n.key);
    expect(after).toContain("plans_detail");
  });

  it("no why lines — these are the CUSTOMER's questions; a why is where the answer lands in HIS price", () => {
    for (const n of INTAKE_STARTER.needs) expect(n.why, n.key).toBeUndefined();
  });
});

describe("the door must not submit answers to questions it stopped showing", () => {
  /**
   * cn-v658 audit. The client hides a conditional follow-up when its trigger changes, but `set`
   * only merges keys — it never deletes. So: "do you have plans? Yes" → type the detail → change
   * to "No" still SUBMITTED the detail, and the lead read "Plans: No" and "About the plans: <text>"
   * in the same summary. The inspector has always cleared on save; this door didn't.
   */
  it("clearing the trigger drops the follow-up's answer", () => {
    const withDetail = { has_plans: "Yes", plans_detail: "Drawn by an architect, approved." };
    expect(clearInapplicable(INTAKE_STARTER, withDetail).plans_detail).toBe("Drawn by an architect, approved.");

    const changedMind = { has_plans: "No", plans_detail: "Drawn by an architect, approved." };
    expect(clearInapplicable(INTAKE_STARTER, changedMind).plans_detail).toBeNull();
  });
})
