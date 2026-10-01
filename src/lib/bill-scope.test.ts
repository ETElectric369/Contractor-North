import { describe, it, expect } from "vitest";
import { scopeAfterJobMove, scopeForWrite, scopeOptions, scopeSaid, SCOPE_UNCATEGORIZED } from "./bill-scope";

/**
 * THE ONE DECIDER FOR WHICH PART OF THE JOB A COST IS (item C1).
 *
 * Before this, one door in the app wrote `bills.scope_category` — the AI reading a snapped receipt —
 * so the same $900 of decking landed in Decking or under nothing depending on how it arrived, and
 * Nort reported "decking hasn't started" with the spend on the Costs tab. Every door answers now,
 * and this is the only thing that turns an answer into a stored value.
 */
describe("scopeForWrite", () => {
  const PARTS = ["Framing", "Decking"];

  it("stores a part the job's estimate really has", () => {
    expect(scopeForWrite({ jobId: "j1", answer: { kind: "scope", scope: "Decking" }, jobScopes: PARTS })).toEqual({
      value: "Decking",
      refusal: null,
    });
  });

  it("refuses a part the estimate has not got, and names the ones it has", () => {
    const r = scopeForWrite({ jobId: "j1", answer: { kind: "scope", scope: "Plumbing" }, jobScopes: PARTS });
    expect(r.value).toBeNull();
    expect(r.refusal).toContain("Plumbing");
    expect(r.refusal).toContain("Framing, Decking");
  });

  it("says so when the job's estimate isn't broken into parts at all, rather than inventing one", () => {
    const r = scopeForWrite({ jobId: "j1", answer: { kind: "scope", scope: "Framing" }, jobScopes: [] });
    expect(r.value).toBeNull();
    expect(r.refusal).toMatch(/isn't broken into parts/i);
  });

  it("the reserved word is stored as nothing, so one column never holds two spellings of none", () => {
    expect(scopeForWrite({ jobId: "j1", answer: { kind: "scope", scope: SCOPE_UNCATEGORIZED }, jobScopes: PARTS })).toEqual({
      value: null,
      refusal: null,
    });
  });

  it("a door that could not ask, and a person who said none of them, both store nothing and refuse nothing", () => {
    expect(scopeForWrite({ jobId: "j1", answer: { kind: "notAsked" }, jobScopes: PARTS })).toEqual({ value: null, refusal: null });
    expect(scopeForWrite({ jobId: "j1", answer: { kind: "none" }, jobScopes: PARTS })).toEqual({ value: null, refusal: null });
  });

  it("a business cost has no part of a job", () => {
    expect(scopeForWrite({ jobId: null, answer: { kind: "noJob" }, jobScopes: [] })).toEqual({ value: null, refusal: null });
    const r = scopeForWrite({ jobId: null, answer: { kind: "scope", scope: "Framing" }, jobScopes: ["Framing"] });
    expect(r.value).toBeNull();
    expect(r.refusal).toMatch(/business cost/i);
  });

  it("a door that answers 'no job' over a job id is told, not quietly obeyed", () => {
    const r = scopeForWrite({ jobId: "j1", answer: { kind: "noJob" }, jobScopes: PARTS });
    expect(r.value).toBeNull();
    expect(r.refusal).toMatch(/which part of the job/i);
  });

  it("whitespace is not an answer", () => {
    expect(scopeForWrite({ jobId: "j1", answer: { kind: "scope", scope: "  " }, jobScopes: PARTS })).toEqual({ value: null, refusal: null });
  });
});

describe("scopeAfterJobMove", () => {
  it("keeps the part when the job it moves to has one by the same name", () => {
    expect(scopeAfterJobMove("Framing", ["Framing", "Siding"])).toEqual({ value: "Framing", said: null });
  });

  it("drops it when the new job's estimate has no such part — and SAYS so", () => {
    const r = scopeAfterJobMove("Framing", ["Siding"]);
    expect(r.value).toBeNull();
    expect(r.said).toContain("Framing");
    expect(r.said).toMatch(/no part by that name/i);
  });

  it("a cost that was under no part has nothing to say", () => {
    expect(scopeAfterJobMove(null, ["Siding"])).toEqual({ value: null, said: null });
  });
});

describe("what the screen says", () => {
  it("names the part, or says plainly that none is set", () => {
    expect(scopeSaid("Decking")).toBe("Decking");
    expect(scopeSaid(null)).toBe("No Part Of The Job Set");
    // A stored "Uncategorized" from before the column was decided in one place reads the same way.
    expect(scopeSaid(SCOPE_UNCATEGORIZED)).toBe("No Part Of The Job Set");
  });

  it("a job whose estimate has no parts offers no question at all (no dead-end dropdown)", () => {
    expect(scopeOptions([])).toEqual([]);
    expect(scopeOptions([SCOPE_UNCATEGORIZED])).toEqual([]);
    expect(scopeOptions(["Framing", SCOPE_UNCATEGORIZED, "Decking"])).toEqual(["Framing", "Decking"]);
  });
});
