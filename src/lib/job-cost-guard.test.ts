import { describe, it, expect } from "vitest";
import { isLinelessReturn, jobCostRefusal, RETURN_ON_JOB_WHY } from "./job-cost-guard";

/**
 * THE ONE TEST EVERY DOOR THAT PUTS A COST ON A JOB IS HELD TO (item C2).
 *
 * The INV-078 housings: a -$51.58 credit with nothing legible under it, on a job, is credited to the
 * customer in full at markup — for parts they were never charged for. DB4 put the rule on the paper
 * door. Typing it, Nort and the Edit Bill box had no such check, and the Edit Bill box is the
 * shortest road to it: a bank credit lands as a business cost with no lines and one dropdown
 * re-points it onto a job.
 */
describe("jobCostRefusal", () => {
  const LINE = { description: "H245ICAT 4 in LED Shallow IC HSG" };

  it("refuses a credit with no lines on a job, and the sentence says why", () => {
    const no = jobCostRefusal({ jobId: "j1", amount: -51.58, lines: [] });
    expect(no).toBe(RETURN_ON_JOB_WHY);
    expect(no).toMatch(/credit the customer the whole amount/i);
  });

  it("each door adds its own next step to the one reason, so the reason cannot drift", () => {
    const no = jobCostRefusal({ jobId: "j1", amount: -51.58, lines: [] }, "Snap the credit memo so its lines come with it.");
    expect(no?.startsWith(RETURN_ON_JOB_WHY)).toBe(true);
    expect(no).toContain("Snap the credit memo");
  });

  it("a credit WITH lines goes through: the cap can read them", () => {
    expect(jobCostRefusal({ jobId: "j1", amount: -51.58, lines: [LINE] })).toBeNull();
  });

  it("the company's own book is never held to it (a business cost reaches no customer)", () => {
    expect(jobCostRefusal({ jobId: null, amount: -51.58, lines: [] })).toBeNull();
  });

  it("a charge is not a credit", () => {
    expect(jobCostRefusal({ jobId: "j1", amount: 51.58, lines: [] })).toBeNull();
    expect(jobCostRefusal({ jobId: "j1", amount: 0, lines: [] })).toBeNull();
    expect(jobCostRefusal({ jobId: "j1", amount: null, lines: [] })).toBeNull();
  });

  it("a line with nothing written on it is not a line", () => {
    expect(jobCostRefusal({ jobId: "j1", amount: -51.58, lines: [{ description: "  " }] })).toBe(RETURN_ON_JOB_WHY);
    expect(jobCostRefusal({ jobId: "j1", amount: -51.58, lines: null })).toBe(RETURN_ON_JOB_WHY);
  });

  it("half a cent short of zero is not a credit (the rounding the money readers use)", () => {
    expect(isLinelessReturn(-0.004, [])).toBe(false);
    expect(isLinelessReturn(-0.01, [])).toBe(true);
  });
});
