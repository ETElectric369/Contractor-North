import { describe, it, expect } from "vitest";
import { placeSaid } from "./panel-form";

/**
 * WHERE A SPOKEN CIRCUIT GOES (the panel-first wave): Nort's words about a circuit's place turned
 * into the space, half and poles the Panel tab keeps. A tandem said twice on one space is its A and
 * B halves in the order said; a 2-pole said by its spaces is the top one; a quad hangs the way the
 * panel's numbers run (model quadCentreHalf, the rule the photo and Place From What Was Bought use);
 * words that disagree, a tandem with no space or no half, and a quad nobody can place come back as
 * a question.
 */

const ok = (said: Parameters<typeof placeSaid>[0]) => {
  const r = placeSaid(said);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
/** The same, on a panel whose numbers run the way given (a quad's halves depend on it). */
const ok2 = (said: Parameters<typeof placeSaid>[0], numbering: "top_down" | "bottom_up") => {
  const r = placeSaid(said, { numbering });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("placeSaid", () => {
  it("'put Bar and Mini Fridge on 17 as a tandem 20/20': 17A then 17B, one pole each", () => {
    expect(ok([{ space: 17, form: "tandem" }, { space: 17, form: "tandem" }])).toEqual([
      { space: 17, half: "A", poles: 1 },
      { space: 17, half: "B", poles: 1 },
    ]);
  });

  it("a half that was said is kept, and the other tandem takes the half left", () => {
    expect(ok([{ space: 17, form: "tandem" }, { space: 17, form: "tandem", half: "A" }])).toEqual([
      { space: 17, half: "B", poles: 1 },
      { space: 17, half: "A", poles: 1 },
    ]);
  });

  it("'Mini Split on 9 and 11, 2-pole 30': space 9, two poles, no half — and the spaces alone say 2-pole", () => {
    expect(ok([{ spaces: [9, 11], form: "2-pole" }])).toEqual([{ space: 9, half: null, poles: 2 }]);
    expect(ok([{ spaces: [11, 9] }])).toEqual([{ space: 9, half: null, poles: 2 }]);
    expect(ok([{ space: 9, form: "2-pole" }])).toEqual([{ space: 9, half: null, poles: 2 }]);
    expect(ok([{ spaces: [2, 4, 6], form: "3-pole" }])).toEqual([{ space: 2, half: null, poles: 3 }]);
  });

  it("a single is one pole on the whole space; nothing said is one pole with no space", () => {
    expect(ok([{ space: 19, form: "single" }])).toEqual([{ space: 19, half: null, poles: 1 }]);
    expect(ok([{}])).toEqual([{ space: null, half: null, poles: 1 }]);
    // A 2-pole said with its half stays as said.
    expect(ok([{ space: 25, half: "B", form: "2-pole" }])).toEqual([{ space: 25, half: "B", poles: 2 }]);
  });

  it("a hole asks: a tandem, or a half, with no space is never filed as a plain single", () => {
    expect(placeSaid([{ form: "tandem" }])).toEqual({ ok: false, error: "Circuit 1: which space is the tandem on?" });
    expect(placeSaid([{ half: "B" }])).toEqual({ ok: false, error: "Circuit 1: which space is the tandem on?" });
    expect(placeSaid([{ half: "B", poles: 2 }])).toEqual({ ok: false, error: "Circuit 1: which space is the 2-pole on?" });
    expect(placeSaid([{ form: "quad" }], { numbering: "top_down" })).toEqual({ ok: false, error: "Circuit 1: which space is the quad on?" });
  });

  it("a QUAD said on 1 (Garage, Floor Heat 2-pole, Porch): top down, the centre at 1B and the singles 1A then 3B", () => {
    const said = [
      { space: 1, form: "quad" as const, poles: 1 },
      { space: 1, form: "quad" as const, poles: 2 },
      { spaces: [1, 3], form: "quad" as const },
    ];
    expect(ok2(said, "top_down")).toEqual([
      { space: 1, half: "A", poles: 1 },
      { space: 1, half: "B", poles: 2 },
      { space: 3, half: "B", poles: 1 },
    ]);
  });

  it("the same quad on a panel numbered BOTTOM UP (3 hangs above 1): the centre at 1A, the singles 3A (top) then 1B", () => {
    const said = [
      { space: 1, form: "quad" as const, poles: 1 },
      { space: 1, form: "quad" as const, poles: 2 },
      { space: 1, form: "quad" as const },
    ];
    expect(ok2(said, "bottom_up")).toEqual([
      { space: 3, half: "A", poles: 1 },
      { space: 1, half: "A", poles: 2 },
      { space: 1, half: "B", poles: 1 },
    ]);
  });

  it("a quad asks instead of guessing: which panel (several, numbering unknown), which is the 2-pole, too many, a half or a 3-pole", () => {
    const three = [{ space: 5, form: "quad" as const }, { space: 5, form: "quad" as const }, { space: 5, form: "quad" as const }];
    expect(placeSaid(three, { numbering: null })).toMatchObject({ ok: false, error: expect.stringContaining("Which panel is the quad on 5 in?") });
    expect(placeSaid(three)).toMatchObject({ ok: false, error: expect.stringContaining("Which panel is the quad on 5 in?") });
    expect(placeSaid(three, { numbering: "top_down" })).toEqual({ ok: false, error: "The quad on 5: which one is the centre 2-pole?" });
    expect(placeSaid([...three, { space: 5, form: "quad", poles: 2 }], { numbering: "top_down" })).toEqual({
      ok: false,
      error: "A quad on 5 is two outer singles and one centre 2-pole; 4 circuits were said on it.",
    });
    expect(placeSaid([{ space: 5, form: "quad", half: "A" }], { numbering: "top_down" })).toMatchObject({ ok: false, error: expect.stringContaining("a quad's handles hang where the quad puts them") });
    expect(placeSaid([{ space: 5, form: "quad", poles: 3 }], { numbering: "top_down" })).toMatchObject({ ok: false, error: expect.stringContaining("not a 3-pole") });
  });

  it("asks instead of guessing: one tandem with no half, words that disagree, spaces that aren't one breaker", () => {
    expect(placeSaid([{ space: 17, form: "tandem" }])).toEqual({ ok: false, error: "Circuit 1: which half of space 17 is it, A (the top) or B (below)?" });
    expect(placeSaid([{ space: 17, form: "tandem", poles: 2 }])).toEqual({ ok: false, error: "Circuit 1: it was said as a tandem but with 2 poles. Which is it?" });
    expect(placeSaid([{ spaces: [9, 10], form: "2-pole" }])).toMatchObject({ ok: false, error: expect.stringContaining("spaces 9 and 10 aren't one breaker") });
    expect(placeSaid([{ spaces: [9, 11], form: "3-pole" }])).toMatchObject({ ok: false, error: expect.stringContaining("9 and 11 is 2 spaces, but it was said as 3 poles") });
    expect(placeSaid([{ space: 7, spaces: [9, 11] }])).toMatchObject({ ok: false, error: expect.stringContaining("don't agree") });
    expect(placeSaid([{ space: 19, form: "single", half: "A" }])).toMatchObject({ ok: false, error: expect.stringContaining("a single takes the whole space") });
    expect(placeSaid([{ space: 2, half: "A", poles: 3 }])).toMatchObject({ ok: false, error: expect.stringContaining("a 3-pole takes whole spaces") });
  });

  it("a space holds two halves: a third tandem on it, or two said on the same half, is a question", () => {
    expect(placeSaid([{ space: 5, form: "tandem" }, { space: 5, form: "tandem" }, { space: 5, form: "tandem" }])).toEqual({
      ok: false,
      error: "Space 5 holds two halves, A and B; 3 circuits were said on it as tandems.",
    });
    expect(placeSaid([{ space: 5, form: "tandem", half: "A" }, { space: 5, form: "tandem", half: "A" }])).toEqual({
      ok: false,
      error: "Circuits 1 and 2 were both said on 5A. Which goes on the other half?",
    });
  });
});
