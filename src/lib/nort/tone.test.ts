import { describe, it, expect } from "vitest";
import { asRegister, clampHumor, DEFAULT_HUMOR, humorLabel, toneDirective, NORT_NOTES_MAX, clampNotes, standingOrders } from "./tone";

/**
 * Erik: "is there a humor setting we can put at like 55% and a swear word allowance we can match
 * the user (good industry form and mental health)."
 *
 * The dial is a preference. The four things it CANNOT do are the product, and they are what these
 * tests are for.
 */

describe("the dial itself", () => {
  it("55 is the default, because he picked it", () => {
    expect(DEFAULT_HUMOR).toBe(55);
    expect(humorLabel(55)).toBe("Like a person you'd work with");
  });

  it("garbage lands on the default rather than on 0 — a broken read must not mute him", () => {
    for (const junk of [undefined, null, "abc", NaN, {}]) expect(clampHumor(junk)).toBe(DEFAULT_HUMOR);
  });

  it("clamps instead of trusting", () => {
    expect(clampHumor(-40)).toBe(0);
    expect(clampHumor(1000)).toBe(100);
    expect(clampHumor("70")).toBe(70);
  });

  it("every setting has a label a person can choose by", () => {
    for (const n of [0, 10, 35, 55, 85, 100]) expect(humorLabel(n).length).toBeGreaterThan(3);
  });

  it("register defaults to matching, and only an explicit 'clean' turns it off", () => {
    expect(asRegister(undefined)).toBe("match");
    expect(asRegister("nonsense")).toBe("match");
    expect(asRegister("clean")).toBe("clean");
  });
});

describe("THE FOUR RULES THE DIAL NEVER OVERRIDES", () => {
  const everySetting = [0, 25, 55, 80, 100].flatMap((h) =>
    (["match", "clean"] as const).map((r) => ({ h, r, text: toneDirective(h, r) })),
  );

  it("1. nothing reaches a customer — at EVERY setting", () => {
    // The one that would cost him money and a reputation. Not a preference, not negotiable.
    for (const { text, h, r } of everySetting) {
      expect(text.toLowerCase(), `${h}/${r}`).toContain("clean and professional");
      expect(text.toLowerCase(), `${h}/${r}`).toContain("invoices");
    }
  });

  it("2. match, never lead — the swearing rule is always conditional on them going first", () => {
    const match = toneDirective(100, "match").toLowerCase();
    expect(match).toContain("never first");
    expect(match).toContain("never more than them");
    expect(match).toContain("if they never swear, you never do");
  });

  it("3. never at a person — at EVERY setting", () => {
    for (const { text, h, r } of everySetting) expect(text.toLowerCase(), `${h}/${r}`).toContain("never at a person");
  });

  it("4. clean means clean, whatever they say", () => {
    const clean = toneDirective(100, "clean").toLowerCase();
    expect(clean).toContain("keep it clean");
    expect(clean).not.toContain("you can swear back");
  });
});

describe("the humour end actually changes", () => {
  it("zero says no jokes; the top says run with it", () => {
    expect(toneDirective(0, "clean").toLowerCase()).toContain("no jokes");
    expect(toneDirective(100, "clean").toLowerCase()).toContain("loose and funny");
  });

  it("the default tells him to GET a joke, which is the bug that started this", () => {
    // "Hello. That works. What's next?" was a joke, and it came back as a parse failure.
    expect(toneDirective(55, "match").toLowerCase()).toContain("get it");
  });

  it("the answer always outranks the joke, at every level", () => {
    for (const h of [40, 55, 80, 100]) {
      const t = toneDirective(h, "match").toLowerCase();
      expect(t.includes("answer") || t.includes("right"), String(h)).toBe(true);
    }
  });
});

describe("standing orders — the durable home for 'keep it short' (0184)", () => {
  it("empty and blank produce NOTHING — no header over no orders", () => {
    expect(standingOrders(null)).toBe("");
    expect(standingOrders(undefined)).toBe("");
    expect(standingOrders("   ")).toBe("");
  });

  it("carries his words verbatim, framed as orders that outrank defaults", () => {
    const s = standingOrders("Keep answers short.\nDon't read lists back.");
    expect(s).toContain("STANDING ORDERS");
    expect(s).toContain("Keep answers short.");
    expect(s).toContain("outrank your defaults");
    // ...but never the boundaries that aren't his to move.
    expect(s).toContain("never the security rules");
  });

  it("clampNotes: trims, caps at the DB CHECK's limit, and empties to null", () => {
    expect(clampNotes("  hi  ")).toBe("hi");
    expect(clampNotes("")).toBeNull();
    expect(clampNotes("   ")).toBeNull();
    expect(clampNotes(42)).toBeNull();
    expect(clampNotes("x".repeat(5000))!.length).toBe(NORT_NOTES_MAX);
  });

  it("standingOrders never exceeds the cap either — belt and braces with the CHECK", () => {
    const s = standingOrders("y".repeat(5000));
    expect(s.length).toBeLessThan(NORT_NOTES_MAX + 400);
  });
});
