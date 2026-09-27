import { describe, it, expect } from "vitest";
import { WHY_ASK, WHY_MAX_CHARS, WHY_SHAPES, whyHint, whyNudge, whyProblems } from "./why";
import { ET_ELECTRIC } from "./starters/et-electric";
import { PLAYBOOK_STARTERS } from "./starters";
import type { Need } from "./types";

const need = (n: Partial<Need> & { key: string }): Need => ({ label: n.key, ask: `${n.key}?`, ...n });

/**
 * Erik: "we need precision for every single person and based in the simplest of simplicities."
 *
 * These assert the reframe that made it teachable: a why line is THE PATH FROM THE ANSWER TO THE
 * NUMBER, not a justification. A justification can only be admired. A path can be checked.
 */

describe("the question never invites an essay", () => {
  it("asks where it LANDS, not why he asks", () => {
    expect(WHY_ASK.toLowerCase()).toContain("where");
    expect(WHY_ASK.toLowerCase()).not.toContain("why do you");
  });

  it("suggests the shape most likely to fit the answer", () => {
    // A measured number lands in arithmetic; a pick opens a branch; prose usually switches work on.
    expect(whyHint(need({ key: "len", slot: { type: "number" }, measured: true })).shape.key).toBe("formula");
    expect(whyHint(need({ key: "feed", slot: { type: "select", options: ["a", "b"] } })).shape.key).toBe("fork");
    expect(whyHint(need({ key: "gotcha" })).shape.key).toBe("trigger");
  });

  it("every shape carries a whole-sentence example, not a template", () => {
    for (const s of WHY_SHAPES) {
      expect(s.example.length).toBeGreaterThan(30);
      expect(s.example).not.toContain("…"); // the hint has ellipses; the example must be a real sentence
      // The example passes the check it teaches, and fits the one-line law.
      expect(whyProblems(s.example), s.key).toEqual([]);
      expect(s.example.length).toBeLessThanOrEqual(WHY_MAX_CHARS);
    }
  });

  it("...in NO trade's words: every company sees these, for every question", () => {
    // A plumber's "Water heater type" was shown "subpanel or home runs"; a painter was shown an
    // inspection trip. Erik: "Nort cant be giving examples that dont make sense."
    const TRADE_NOUNS = /board|joist|deck|subpanel|home ?run|panel|breaker|wire|circuit|outlet|permit|inspection|pipe|drain|roof|paint|tile|square footage/i;
    for (const s of WHY_SHAPES) {
      expect(s.example, s.key).not.toMatch(TRADE_NOUNS);
      expect(s.hint, s.key).not.toMatch(TRADE_NOUNS);
    }
  });
});

describe("BOTH BROTHERS PASS — the same shape covers a formula and a fork", () => {
  it("Chris's arithmetic", () => {
    // "because this gets multiplied by that and = x and that feeds the board length generator"
    expect(whyProblems("Length × width is the square footage, and that drives the board count.")).toEqual([]);
    expect(whyProblems("Times the boards per square foot. That's the order.")).toEqual([]);
  });

  it("Erik's fork", () => {
    expect(whyProblems("Decides subpanel or home runs — sets every run length after it.")).toEqual([]);
  });

  it("and a blunt one-liner from a man in a truck", () => {
    // The check must never punish brevity. This is the most likely REAL answer.
    expect(whyProblems("Tells me how much wire.")).toEqual([]);
    expect(whyProblems("Sets the trip count.")).toEqual([]);
  });
});

describe("what it actually catches", () => {
  it("an ESSAY — the failure that started this", () => {
    // Erik's own drafted lines ran to five sentences and he couldn't read fifteen of them.
    // His original line, now living in `note` where length is fine — the split, not a delete.
    const essay = ET_ELECTRIC.needs.find((n) => n.key === "power_source")!.note!;
    expect(whyProblems(essay)).toContain("too_long");
  });

  it("a line that names no destination", () => {
    expect(whyProblems("This one is really important on every job.")).toContain("no_destination");
    expect(whyProblems("Because I need to know it.")).toContain("no_destination");
  });

  it("THE 'x' HOLE: a letter x is not arithmetic", () => {
    // [×x*+] passed any line with an x in it. These name nothing downstream.
    expect(whyProblems("Exterior box, we check it.")).toContain("no_destination");
    expect(whyProblems("Extra fixtures, maybe.")).toContain("no_destination");
    expect(whyProblems("Next, the box.")).toContain("no_destination");
  });

  it("...but x as an operator still is, and so are the real symbols", () => {
    expect(whyProblems("Length x width is the square footage.")).toEqual([]);
    expect(whyProblems("20x16 on the tape, then the rate.")).toEqual([]);
    expect(whyProblems("Count × unit price.")).toEqual([]);
    expect(whyProblems("Hours * rate.")).toEqual([]);
    expect(whyProblems("Answer = the line on the estimate.")).toEqual([]);
  });

  it("ONE LINE IS 140 CHARACTERS (the why-line law), not 220", () => {
    expect(WHY_MAX_CHARS).toBe(140);
    const at = `Sets the ${"a".repeat(WHY_MAX_CHARS - "Sets the ".length)}`;
    expect(at).toHaveLength(WHY_MAX_CHARS);
    expect(whyProblems(at)).toEqual([]);
    expect(whyProblems(`${at}b`)).toContain("too_long");
    // A 224-character line (the length of one live line in production) is flagged, not blocked:
    // the nudge asks for a shorter one, and nothing refuses the save.
    expect(whyProblems(`Sets the labor. ${"word ".repeat(42)}`.slice(0, 224))).toContain("too_long");
  });

  it("the question said back at you — the most common first attempt", () => {
    const n = need({ key: "panel", ask: "What's the panel — brand, size, any room in it?" });
    expect(whyProblems("I need to know the panel brand, size and room in it.", n)).toContain("restates_the_question");
  });

  it("...but the same words WITH a destination are fine", () => {
    const n = need({ key: "panel", ask: "What's the panel — brand, size, any room in it?" });
    expect(whyProblems("Panel brand decides whether I can add a breaker at all, or it's a service change.", n)).toEqual([]);
  });

  it("empty is its own thing, not a scolding", () => {
    expect(whyProblems("")).toEqual(["empty"]);
    expect(whyProblems(undefined)).toEqual(["empty"]);
  });
});

describe("the nudge points at the destination, never grades", () => {
  const shape = WHY_SHAPES[0];

  it("gives a real example when there's nothing", () => {
    expect(whyNudge(["empty"], shape)).toContain(shape.example);
  });

  it("names the miss in one clause and shows the shape", () => {
    expect(whyNudge(["no_destination"], shape)).toContain(shape.hint);
    expect(whyNudge(["restates_the_question"], shape)!.toLowerCase()).toContain("where does the answer land");
  });

  it("never scolds — no 'bad', 'wrong', 'invalid', 'error'", () => {
    for (const p of ["empty", "too_long", "no_destination", "restates_the_question"] as const) {
      const t = (whyNudge([p], shape) ?? "").toLowerCase();
      for (const word of ["bad", "wrong", "invalid", "error", "must"]) expect(t, `${p}/${word}`).not.toContain(word);
    }
  });

  it("says nothing at all when the line is good", () => {
    expect(whyNudge([], shape)).toBeNull();
  });
});

describe("THE SHIPPED STARTERS PASS THEIR OWN CHECK", () => {
  /**
   * The guard that stops this regressing. Erik, about the lines in this very file: "nor do my why
   * lines." They were five-sentence essays because nothing ever looked at them — a rule the app
   * enforces on a user but not on its own seed data is a rule the app doesn't believe.
   *
   * Everything longer than a breath moved to `note`, verbatim. Nothing of his was deleted.
   */
  // EVERY starter, not just Erik's. The playbook is the product — the rule has to hold for whoever
  // we seed next, or "turnkey" is a claim about one org.
  for (const starter of PLAYBOOK_STARTERS) {
    for (const n of starter.playbook.needs) {
      it(`${starter.key}/${n.key} — one line, and it names where it lands`, () => {
        expect(whyProblems(n.why, n), `${n.key}: "${n.why}"`).toEqual([]);
        expect(n.why!.length, `${n.key} is still an essay`).toBeLessThanOrEqual(WHY_MAX_CHARS);
      });
    }
  }

  it("and his long-form reasoning survived, on the ones that had it", () => {
    // The split must not have been a delete. These are the war stories, the code section and the
    // asking rules — Nort still reads them; a human only sees them if they open the question.
    const withNotes = ET_ELECTRIC.needs.filter((n) => n.note?.trim());
    expect(withNotes.length).toBeGreaterThanOrEqual(10);
    expect(ET_ELECTRIC.needs.find((n) => n.key === "length_ft")!.note).toContain("210.52(A)");
    expect(ET_ELECTRIC.needs.find((n) => n.key === "power_source")!.note).toContain("Ask me the fork");
  });
});
