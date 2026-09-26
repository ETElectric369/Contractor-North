import { describe, it, expect } from "vitest";
import { canTieToShelfReturn, isShelfCredit, returnDoorLabel, shelfReturnMoney } from "@/lib/supplier-returns";

/**
 * A RETURN FILED TO THE SHELF (Shop Stock, Phase 4): it lowers the roll, the credit is the shelf's,
 * and no customer is ever credited for shelf stock. What the pieces cost minus the credit is written
 * off, and the sentence says the figure.
 */
describe("a shelf credit is never a customer's", () => {
  it("a credit on the shelf, on no job, is the shelf's; a credit on a job is not", () => {
    expect(isShelfCredit({ amount: -30, job_id: null, on_shelf: true })).toBe(true);
    expect(isShelfCredit({ amount: -51.58, job_id: "J-011", on_shelf: false })).toBe(false);
    expect(isShelfCredit({ amount: 30, job_id: null, on_shelf: true })).toBe(false);
  });
  it("only a job-less credit can be tied to a shelf return: one filed on a job would come off that customer's bill", () => {
    expect(canTieToShelfReturn({ amount: -30, job_id: null })).toBe(true);
    expect(canTieToShelfReturn({ amount: -51.58, job_id: "J-011" })).toBe(false);
    expect(canTieToShelfReturn({ amount: -30, job_id: null, superseded_by_bill_id: "b2" })).toBe(false);
    expect(canTieToShelfReturn({ amount: 12, job_id: null })).toBe(false);
  });
});

describe("what a return from the shelf comes to", () => {
  it("CED gives back less: the difference is written off, in words, and no customer is credited", () => {
    const m = shelfReturnMoney({ qty: 50, unit: "ft", supplier: "Consolidated Electrical Dist.", cost: 36.03, creditAmount: -30 });
    expect(m).toMatchObject({ cost: 36.03, credit: 30, lost: 6.03 });
    expect(m.words).toBe(
      "50 ft went back to CED. CED's credit gives back $30.00, and they cost $36.03 off the roll, so the $6.03 difference is written off as Shop Stock Lost. No customer is credited for it.",
    );
  });
  it("no credit tied: the whole cost is written off, and it says so", () => {
    const m = shelfReturnMoney({ qty: 50, unit: "ft", supplier: "Consolidated Electrical Dist.", cost: 36.03, creditAmount: null });
    expect(m).toMatchObject({ cost: 36.03, credit: 0, lost: 36.03 });
    expect(m.words).toContain("no credit from CED is tied to them, so $36.03 is written off as Shop Stock Lost");
  });
  it("the credit covers it exactly: nothing is written off", () => {
    expect(shelfReturnMoney({ qty: 1, unit: "ea", supplier: "CED", cost: 30, creditAmount: -30 }).lost).toBe(0);
  });
  it("CED gives back more: money back, never invented as a loss", () => {
    const m = shelfReturnMoney({ qty: 1, unit: "ea", supplier: "The Home Depot", cost: 20, creditAmount: -21.5 });
    expect(m.lost).toBe(-1.5);
    expect(m.words).toContain("The Home Depot gave back $1.50 more than they cost. That counts as money back.");
  });
  it("one memo for two rolls: the difference is the memo's, counted once", () => {
    const first = shelfReturnMoney({ qty: 250, unit: "ft", supplier: "CED", cost: 180.17, creditAmount: -300 });
    const second = shelfReturnMoney({ qty: 250, unit: "ft", supplier: "CED", cost: 121.64, creditAmount: -300, otherReturnsCost: 180.17 });
    expect(first.lost).toBe(-119.83); // alone, the memo looks generous...
    expect(second).toMatchObject({ cost: 301.81, credit: 300, lost: 1.81 }); // ...with both rolls back, $1.81 was lost
  });
  it("the door says CED for CED's rolls", () => {
    expect(returnDoorLabel("Consolidated Electrical Dist.")).toBe("Return To CED");
    expect(returnDoorLabel("Contractors Electrical Distributors")).toBe("Return To CED");
    expect(returnDoorLabel("The Home Depot")).toBe("Return To Supplier");
    expect(returnDoorLabel(null)).toBe("Return To Supplier");
  });
});
