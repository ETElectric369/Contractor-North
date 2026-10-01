import { describe, it, expect } from "vitest";
import { scopeAfterJobMove, scopeAnswered, scopeForWrite, scopeOptions, scopeSaid, scopeSelected, SCOPE_UNCATEGORIZED } from "./bill-scope";

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

  /** NO DEAD ENDS. Delete the Framing lines off the estimate after a receipt was filed under Framing
   *  and, without this, the Edit Bill box could never save that cost again — not a corrected supplier,
   *  not a date, nothing — because the unchanged part would be refused. */
  it("the part a cost already carries is kept even when the estimate has lost it", () => {
    expect(scopeForWrite({ jobId: "j1", answer: { kind: "scope", scope: "Framing" }, jobScopes: ["Decking"], stored: "Framing" })).toEqual({
      value: "Framing",
      refusal: null,
    });
    // CHANGING it is still held to what the estimate has now.
    const r = scopeForWrite({ jobId: "j1", answer: { kind: "scope", scope: "Siding" }, jobScopes: ["Decking"], stored: "Framing" });
    expect(r.value).toBeNull();
    expect(r.refusal).toContain("Siding");
  });

  it("whitespace is not an answer", () => {
    expect(scopeForWrite({ jobId: "j1", answer: { kind: "scope", scope: "  " }, jobScopes: PARTS })).toEqual({ value: null, refusal: null });
  });
});

// REWRITTEN for item C1-2: the destination is now stated (`{ jobId, jobScopes }`), because a move to
// Business Cost and a move to a job without the part are two different sentences and an empty scopes
// list could not tell them apart.
describe("scopeAfterJobMove", () => {
  it("keeps the part when the job it moves to has one by the same name", () => {
    expect(scopeAfterJobMove("Framing", { jobId: "job-2", jobScopes: ["Framing", "Siding"] })).toEqual({ value: "Framing", said: null });
  });

  it("drops it when the new job's estimate has no such part — and SAYS so", () => {
    const r = scopeAfterJobMove("Framing", { jobId: "job-2", jobScopes: ["Siding"] });
    expect(r.value).toBeNull();
    expect(r.said).toContain("Framing");
    expect(r.said).toMatch(/no part by that name/i);
  });

  it("a cost that was under no part has nothing to say", () => {
    expect(scopeAfterJobMove(null, { jobId: "job-2", jobScopes: ["Siding"] })).toEqual({ value: null, said: null });
  });

  // ITEM C1-2: taken OFF every job, the one sentence spoke of "the job it moved to" (there isn't one)
  // and sent him to the Edit Bill box's Part Of The Job control, which is not drawn without a job.
  it("taken off every job it says what happened, invents no job, and names no door that isn't drawn", () => {
    const r = scopeAfterJobMove("Framing", { jobId: null, jobScopes: [] });
    expect(r.value).toBeNull();
    expect(r.said).toContain("Framing");
    expect(r.said).toBe(
      'This cost was under "Framing" on the job it came off. A business cost isn\'t part of a job, so the part it was under came off with it.',
    );
    expect(r.said).not.toMatch(/the job it moved to/i);
    expect(r.said).not.toMatch(/Edit Bill/i);
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

/**
 * ITEM C1-3: THE ONE CONTROL NEVER OFFERS TWO SPELLINGS OF NOTHING.
 *
 * main's receipt reader could store the literal "Uncategorized". The control kept a stored word the
 * estimate no longer has (right, so a dropdown can never silently re-file a cost under nothing just
 * by being opened) and so it kept that one too: "No Part Of The Job / Uncategorized / Framing /
 * Decking" — in the one control whose whole purpose is to stop a budget row splitting in two. The
 * Costs tab row beside it already said "No Part Of The Job Set" about the same cost, so the row and
 * the box disagreed until he saved. Both decisions moved in here.
 */
describe("what the one control shows (item C1-3)", () => {
  it("a stored part is what is chosen; the reserved word is chosen as none of them", () => {
    expect(scopeSelected("Decking")).toBe("Decking");
    expect(scopeSelected(null)).toBe("");
    expect(scopeSelected("  ")).toBe("");
    expect(scopeSelected(SCOPE_UNCATEGORIZED)).toBe("");
  });

  it("a stored 'Uncategorized' is shown as No Part Of The Job, with NO option of its own", () => {
    const options = scopeOptions(["Framing", "Decking"], SCOPE_UNCATEGORIZED);
    expect(options).toEqual(["Framing", "Decking"]);
    expect(options).not.toContain(SCOPE_UNCATEGORIZED);
    // And the box now agrees with the row the Costs tab prints beside it.
    expect(scopeSelected(SCOPE_UNCATEGORIZED)).toBe("");
    expect(scopeSaid(SCOPE_UNCATEGORIZED)).toBe("No Part Of The Job Set");
  });

  it("a part the estimate has LOST still rides in the list, so saving the box saves what is there", () => {
    expect(scopeOptions(["Decking"], "Framing")).toEqual(["Framing", "Decking"]);
    // Even on a job whose estimate has no parts left at all: otherwise the control would vanish and
    // the cost would quietly lose the part it carries on the next save.
    expect(scopeOptions([], "Framing")).toEqual(["Framing"]);
  });

  it("a part the estimate still has is offered once, not twice", () => {
    expect(scopeOptions(["Framing", "Decking"], "Decking")).toEqual(["Framing", "Decking"]);
  });
});

/**
 * ITEMS C1-1 AND C1-4 (ONE DEFECT): WHOSE WORD WINS, decided here and nowhere else.
 *
 * The Add Cost sheet drew Part Of The Job and then handed the receipt reader paid, category and the
 * date and NOT the answer — so on the default Read the Receipt save the model's guess won, Erik's
 * picked "Decking" never left the browser, and no sentence anywhere said it had been dropped.
 */
describe("scopeAnswered (items C1-1, C1-4)", () => {
  it("the person's answer beats the model's read of the paper", () => {
    expect(scopeAnswered("Decking", "Framing")).toEqual({ kind: "scope", scope: "Decking" });
  });

  it("a blank control is not an answer, so the paper's own read still stands", () => {
    expect(scopeAnswered("", "Framing")).toEqual({ kind: "scope", scope: "Framing" });
    expect(scopeAnswered(null, "Framing")).toEqual({ kind: "scope", scope: "Framing" });
    expect(scopeAnswered("   ", "Framing")).toEqual({ kind: "scope", scope: "Framing" });
  });

  it("nobody answered and nothing was read: none of them, never a guess", () => {
    expect(scopeAnswered(null, null)).toEqual({ kind: "none" });
    expect(scopeAnswered("", "")).toEqual({ kind: "none" });
  });

  it("a person's answer is still held to the estimate — whoever said it", () => {
    const parts = ["Framing", "Decking"];
    expect(scopeForWrite({ jobId: "job-1", answer: scopeAnswered("Plumbing", "Framing"), jobScopes: parts }).refusal).toMatch(/Plumbing/);
    expect(scopeForWrite({ jobId: "job-1", answer: scopeAnswered("Decking", "Framing"), jobScopes: parts }).value).toBe("Decking");
    // The model shouting the reserved word is still stored as nothing, not as a second spelling.
    expect(scopeForWrite({ jobId: "job-1", answer: scopeAnswered(null, SCOPE_UNCATEGORIZED), jobScopes: parts }).value).toBeNull();
  });
});
