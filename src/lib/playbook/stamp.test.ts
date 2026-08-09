import { describe, it, expect } from "vitest";
import { stampNeeds } from "./stamp";
import type { Need } from "./types";

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
