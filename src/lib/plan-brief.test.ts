import { describe, it, expect } from "vitest";
import {
  BRIEF_LIMITS,
  answersFromBrief,
  briefProvenanceKeys,
  computeBriefFills,
  layerBriefAnswers,
  parsePlanBrief,
  pickReadablePlans,
} from "./plan-brief";
import { factsForEstimatorByProvenance } from "./playbook/answers";
import type { Playbook } from "./playbook/types";

const ORG = "7d6da1e2-c9a0-47d8-bcc1-5b4c3e412fed";
const p = (name: string) => `${ORG}/intake/1754500000000-0f1e2d3c-4b5a-6789-abcd-ef0123456789-${name}`;

const pb: Playbook = {
  needs: [
    { key: "describe", label: "The project", ask: "What is the project?", slot: { type: "text", long: true } },
    { key: "sqft", label: "Square footage", ask: "How big?", slot: { type: "number", unit: "sqft" }, measured: true },
    { key: "stories", label: "Stories", ask: "How many stories?", slot: { type: "select", options: ["1", "2", "3"] } },
    { key: "plan_files", label: "Plans", ask: "Upload plans", slot: { type: "file", multi: true } },
    { key: "scope_picks", label: "Scopes", ask: "Pick scopes", slot: { type: "scopes" } },
  ],
};

describe("parsePlanBrief — tolerant, or nothing", () => {
  it("reads a well-formed brief out of the intake bag", () => {
    const b = parsePlanBrief({
      plan_brief: {
        status: "ready",
        at: "2026-08-21T22:00:00Z",
        files: [p("plans.pdf")],
        skipped: [{ name: "site.dwg", reason: "CAD" }],
        summary: "A new build.",
        scope_excluded: ["garage", "entryway"],
        answers: { sqft: 2400 },
        cautions: ["sheet A3 is dense"],
      },
    });
    expect(b?.status).toBe("ready");
    expect(b?.scope_excluded).toEqual(["garage", "entryway"]);
    expect(b?.answers).toEqual({ sqft: 2400 });
    expect(b?.skipped[0]).toEqual({ name: "site.dwg", reason: "CAD" });
  });

  it("garbage shapes are simply no brief — never a throw", () => {
    expect(parsePlanBrief(null)).toBeNull();
    expect(parsePlanBrief({})).toBeNull();
    expect(parsePlanBrief({ plan_brief: "yes" })).toBeNull();
    expect(parsePlanBrief({ plan_brief: { status: "sideways" } })).toBeNull();
  });

  it("clamps runaway lists to the briefing limits", () => {
    const b = parsePlanBrief({
      plan_brief: { status: "ready", at: "", files: [], skipped: [], observations: Array(50).fill("x".repeat(999)) },
    });
    expect(b?.observations?.length).toBe(BRIEF_LIMITS.listItems);
    expect(b?.observations?.[0].length).toBe(BRIEF_LIMITS.itemChars);
  });
});

describe("answersFromBrief — the walk-through's own coercion, measured KEPT", () => {
  it("keeps a measured number (a plan sheet is where a pre-site dimension legitimately comes from)", () => {
    expect(answersFromBrief(pb, { sqft: 2400 })).toEqual({ sqft: 2400 });
  });

  it("drops file and scopes slots, unknown keys, empties, and off-menu selects", () => {
    const out = answersFromBrief(pb, {
      plan_files: [p("x.pdf")], // file — never AI-filled
      scope_picks: [{ code: "R1" }], // scopes — price-list codes, refused
      invented_key: "boo", // not a question
      describe: "", // empty
      stories: "4", // not one of the options → coerced to null → dropped
    });
    expect(out).toEqual({});
  });

  it("a select on the menu survives verbatim", () => {
    expect(answersFromBrief(pb, { stories: "2" })).toEqual({ stories: "2" });
  });
});

describe("layerBriefAnswers — the person outranks the machine", () => {
  it("customer answers win; the brief fills only holes, and names exactly what it filled", () => {
    const { answers, briefCarried } = layerBriefAnswers(
      pb,
      { describe: "Customer's own words" },
      { describe: "Model's summary", sqft: 2400 },
    );
    expect(answers).toEqual({ describe: "Customer's own words", sqft: 2400 });
    expect(briefCarried).toEqual(["Square footage"]); // labels, like carriedNote — and NOT describe
  });
});

describe("computeBriefFills — the button's count equals what a tap leaves answered", () => {
  const gated: Playbook = {
    needs: [
      { key: "work", label: "Work", ask: "What work?", slot: { type: "select", options: ["New build", "Repair"] } },
      {
        key: "sqft",
        label: "Square footage",
        ask: "How big?",
        slot: { type: "number", unit: "sqft" },
        when: [{ key: "work", in: ["New build"] }],
      },
    ] as never,
  };

  it("counts a chained fill the brief itself unlocks (gate + branch land in ONE tap)", () => {
    const fills = computeBriefFills(gated, { work: "New build", sqft: 2400 }, {});
    expect(fills.map((f) => f.key).sort()).toEqual(["sqft", "work"]);
  });

  it("drops a gated fill whose gate the brief does NOT open", () => {
    // Current answers say Repair — sqft is inapplicable and must not be offered or counted.
    const fills = computeBriefFills(gated, { sqft: 2400 }, { work: "Repair" });
    expect(fills).toEqual([]);
  });

  it("re-coerces against the CURRENT playbook — a stored answer off today's menu is not offered", () => {
    const fills = computeBriefFills(pb, { stories: "4", sqft: 2400 }, {});
    expect(fills.map((f) => f.key)).toEqual(["sqft"]);
  });

  it("never overwrites an answered need", () => {
    expect(computeBriefFills(pb, { sqft: 2400 }, { sqft: 2600 })).toEqual([]);
  });
});

describe("briefProvenanceKeys + factsForEstimatorByProvenance — the machine's words never wear his voice", () => {
  it("an untouched brief answer is machine; an edited one is his", () => {
    const keys = briefProvenanceKeys(pb, { sqft: 2400, describe: "Two-story new build" }, {
      sqft: 2400, // untouched — machine
      describe: "Two-story new build, garage excluded", // he edited — his
    });
    expect([...keys]).toEqual(["sqft"]);
  });

  it("partitions the estimator hand-off by those keys", () => {
    const { hand, machine } = factsForEstimatorByProvenance(
      pb,
      { sqft: 2400, describe: "His own scope" },
      new Set(["sqft"]),
    );
    expect(machine).toContain("Square footage");
    expect(machine).not.toContain("His own scope");
    expect(hand).toContain("His own scope");
    expect(hand).not.toContain("Square footage");
  });
});

describe("pickReadablePlans — no silent caps", () => {
  it("takes PDFs in order within the budget and names every skip with its reason", () => {
    const { read, skipped } = pickReadablePlans(
      [
        { path: p("plans.pdf"), bytes: 6 * 1024 * 1024 },
        { path: p("site.dwg"), bytes: 1024 },
        { path: p("photo.jpg"), bytes: 2048 },
        { path: p("big.pdf"), bytes: 18 * 1024 * 1024 }, // over what's left of the budget
        { path: p("gone.pdf"), bytes: null }, // vanished from storage
      ],
      BRIEF_LIMITS.readBudgetBytes,
    );
    expect(read).toEqual([p("plans.pdf")]);
    expect(skipped.map((s) => s.name)).toEqual(["site.dwg", "photo.jpg", "big.pdf", "gone.pdf"]);
    expect(skipped.find((s) => s.name === "big.pdf")?.reason).toMatch(/budget/);
    expect(skipped.find((s) => s.name === "gone.pdf")?.reason).toMatch(/storage/);
    expect(skipped.find((s) => s.name === "site.dwg")?.reason).toMatch(/CAD/);
  });
});
