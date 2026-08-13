import { describe, it, expect } from "vitest";
import { stampNeeds } from "./stamp";
import type { Need } from "./types";
import { TAHOE_DECK } from "./starters/tahoe-deck";
import { ET_ELECTRIC } from "./starters/et-electric";
import { parsePlaybook } from "./parse";

const n = (key: string, ask = "?"): Need => ({ key, label: key, ask });

/**
 * THE CLOBBER THIS EXISTS FOR: two people in one playbook, the second Save silently overwriting
 * the first with a copy loaded before it. The row updated fine — it just updated to the wrong thing.
 */
describe("stampNeeds — the concurrent-edit guard", () => {
  it("the same questions stamp the same, so an untouched form always saves", () => {
    expect(stampNeeds([n("a"), n("b")])).toBe(stampNeeds([n("a"), n("b")]));
  });

  it("a changed ASK changes the stamp — the edit Andrew's save reverted", () => {
    expect(stampNeeds([n("photos", "Any photos?")])).not.toBe(stampNeeds([n("photos", "Upload your photos")]));
  });

  it("an ADDED question changes it — has_photos appearing must not be silently lost", () => {
    expect(stampNeeds([n("a")])).not.toBe(stampNeeds([n("a"), n("has_photos")]));
  });

  it("a REMOVED question changes it", () => {
    expect(stampNeeds([n("a"), n("b")])).not.toBe(stampNeeds([n("a")]));
  });

  it("REORDERING changes it — order is what the customer reads", () => {
    expect(stampNeeds([n("a"), n("b")])).not.toBe(stampNeeds([n("b"), n("a")]));
  });

  it("empty and null stamp the same, and nothing throws", () => {
    expect(stampNeeds([])).toBe(stampNeeds(null));
    expect(stampNeeds(undefined)).toBe(stampNeeds([]));
  });
});

describe("THE INVARIANT THE GUARD ACTUALLY RESTS ON: parse is a fixed point", () => {
  it("re-parsing an already-parsed playbook does not move the fingerprint", () => {
    // savePlaybook stores `parsePlaybook({ needs })` where `needs` is ALREADY parsed, and the
    // guard hashes a re-parse of the stored row. If those two disagree by one byte, every save is
    // refused with "someone else changed these questions" when nobody did — the freeze with no
    // cause. This is the test that would have caught it; the round-trip one everybody reaches for
    // (JSON.parse(JSON.stringify(x))) is near-vacuous on a plain object.
    for (const pb of [ET_ELECTRIC, TAHOE_DECK]) {
      const once = parsePlaybook(pb);
      const twice = parsePlaybook({ needs: once.needs });
      expect(stampNeeds(twice.needs)).toBe(stampNeeds(once.needs));
    }
  });

  it("holds for a value sitting exactly on a cap boundary, with trailing space", () => {
    // The concrete way it broke: trim-then-slice can cut mid-word and leave a trailing space that
    // the NEXT parse trims away — a different string, a different hash, a refused save.
    const pb = parsePlaybook({
      needs: [{ key: "k", label: "L", ask: "A", why: `${"w ".repeat(80)}tail`, note: "n".repeat(1200) }],
    });
    expect(stampNeeds(parsePlaybook({ needs: pb.needs }).needs)).toBe(stampNeeds(pb.needs));
  });

  it("and a leading indent is never charged against the cap", () => {
    // The trap in the other direction: slicing before the first trim would let whitespace eat the
    // budget, truncating a pasted why line mid-sentence.
    const why = `${" ".repeat(100)}Times the D2 railing rate.`;
    expect(parsePlaybook({ needs: [{ key: "k", label: "L", ask: "A", why }] }).needs[0].why)
      .toBe("Times the D2 railing rate.");
  });
});
