import { describe, expect, it } from "vitest";
import { classifyConfirmReply } from "@/lib/confirm-parse";

/**
 * CHANGE 3 — the by-voice confirm-gate must handle CORRECTIONS, not just yes/no. The old parser tested
 * the negative regex first, so "no wait, yes do the second one" matched "no" and CANCELLED — a
 * dangerous misfire. These cases pin the new intent order: correction > standalone-no > yes.
 */
describe("classifyConfirmReply — voice confirm intent", () => {
  it("pure yes / no fast paths", () => {
    expect(classifyConfirmReply("yes")).toBe("yes");
    expect(classifyConfirmReply("yeah")).toBe("yes");
    expect(classifyConfirmReply("go ahead")).toBe("yes");
    expect(classifyConfirmReply("do it")).toBe("yes");
    expect(classifyConfirmReply("no")).toBe("no");
    expect(classifyConfirmReply("nope")).toBe("no");
    expect(classifyConfirmReply("cancel")).toBe("no");
    expect(classifyConfirmReply("never mind")).toBe("no");
  });

  it("THE dangerous case: a no walked back by a later yes is NOT a veto", () => {
    // Old code cancelled this. New code re-sends it as a correction.
    expect(classifyConfirmReply("no wait, yes do the second one")).toBe("correction");
  });

  it("qualified 'no ... yes' never cancels", () => {
    expect(classifyConfirmReply("no actually yes")).toBe("correction");
    // "no, but yeah change it to Dave" — has correction keywords + name → correction, not no.
    expect(classifyConfirmReply("no, actually change it to Dave")).toBe("correction");
  });

  it("corrections re-send instead of yes/no", () => {
    expect(classifyConfirmReply("actually make it 3")).toBe("correction");
    expect(classifyConfirmReply("change it to the Miller job")).toBe("correction");
    expect(classifyConfirmReply("use the second one instead")).toBe("correction");
    expect(classifyConfirmReply("make it two hundred")).toBe("correction");
  });

  it("a bare number or ordinal is a correction", () => {
    expect(classifyConfirmReply("the first one")).toBe("correction");
    expect(classifyConfirmReply("225")).toBe("correction");
    expect(classifyConfirmReply("do the last one")).toBe("correction");
  });

  it("a leading affirmative that also names a choice still CONFIRMS (fast path wins)", () => {
    // "yes, the first one" is an affirmation, not an edit — the confirm-gate should run, not re-send.
    expect(classifyConfirmReply("yes, the first one")).toBe("yes");
    expect(classifyConfirmReply("yep go ahead")).toBe("yes");
  });

  it("a standalone no with no walk-back cancels", () => {
    expect(classifyConfirmReply("no don't do that")).toBe("no");
    expect(classifyConfirmReply("cancel that")).toBe("no");
    expect(classifyConfirmReply("stop")).toBe("no");
  });

  it("garbage / unclear re-prompts", () => {
    expect(classifyConfirmReply("")).toBe("unclear");
    expect(classifyConfirmReply("hmmmm")).toBe("unclear");
    expect(classifyConfirmReply("uhh")).toBe("unclear");
  });

  // THE money-write misfire this fix closes: the mic is armed the instant Nort finishes speaking a
  // payment proposal, so the driver's next words — often a QUESTION — land in this classifier. An
  // affirmative filler in FRONT of a question ("sure, but…", "ok what's…") must NEVER commit.
  it("a leading affirmative in front of a QUESTION or HEDGE never confirms", () => {
    for (const u of [
      "sure, but which invoice is that?",
      "okay hold on",
      "ok what's the total",
      "sure one sec",
      "yes but wait which one",
      "ok but hang on",
      "sure, what am I confirming",
    ]) {
      expect(classifyConfirmReply(u)).not.toBe("yes");
    }
  });

  it("a bare question re-sends (correction) rather than re-prompting", () => {
    expect(classifyConfirmReply("what was that")).toBe("correction");
    expect(classifyConfirmReply("which invoice?")).toBe("correction");
  });

  it("the weak fillers ok / okay / sure still confirm when they STAND ALONE", () => {
    expect(classifyConfirmReply("ok")).toBe("yes");
    expect(classifyConfirmReply("okay")).toBe("yes");
    expect(classifyConfirmReply("sure")).toBe("yes");
    expect(classifyConfirmReply("ok do it")).toBe("yes");
  });

  it("never returns 'no' when a later affirmative is present (safety invariant)", () => {
    const walkbacks = [
      "no wait yes",
      "no hold on, do it",
      "nope, actually go ahead",
      "no scratch that, yeah",
    ];
    for (const u of walkbacks) {
      expect(classifyConfirmReply(u)).not.toBe("no");
    }
  });
});
