import { describe, it, expect } from "vitest";
import { LINES_OFF_THE_BILL, NOT_FILED_WITH_ITS_BILL, returnRowLine, rowOffersFileWithItsBill } from "./return-bill-door";

/**
 * WHEN A ROW OFFERS FILE WITH ITS BILL (cn-v1184): a credit recorded on a job (J-901), an original,
 * with a part line that still bills. A draft holding it never hides the door; an invoice that went out,
 * when the page knows it, does. Once filed its part lines bill nothing and the row says so.
 */
type Line = { amount: number; billable?: boolean | null; category?: string | null; description?: string | null };
type CreditRow = { amount: number | string; job_id: string | null; corrects_bill_id: string | null; superseded_by_bill_id: string | null; superseded: boolean };
type Input = { ready: boolean; bill: CreditRow; hasCorrections: boolean; lines: Line[]; heldBySent?: boolean | null };
const credit: CreditRow = { amount: -19.02, job_id: "job-1", corrects_bill_id: null, superseded_by_bill_id: null, superseded: false };
const part = (billable: boolean | null = true): Line => ({ description: "1/2 in EMT Connector Steel", amount: -10.5, billable });
const tax = (billable = true): Line => ({ description: "Sales Tax", category: "Tax", amount: -1.42, billable });
const base: Input = { ready: true, bill: credit, hasCorrections: false, lines: [part(), part(), tax()] };

describe("rowOffersFileWithItsBill", () => {
  const table: [string, Partial<Input>, boolean][] = [
    ["a credit on a job, with part lines that bill: offered", {}, true],
    ["one part line still bills: offered", { lines: [part(false), part(null), tax()] }, true],
    ["held by a draft (the page knows nothing went out): offered", { heldBySent: false }, true],
    ["the page cannot know: offered", { heldBySent: null }, true],
    ["an invoice that went out holds it, and the page knows: not offered", { heldBySent: true }, false],
    ["the correction column not read: not offered", { ready: false }, false],
    ["a purchase, above zero: not offered", { bill: { ...credit, amount: 19.02 } }, false],
    ["zero to the cent: not offered", { bill: { ...credit, amount: -0.004 } }, false],
    ["a cent below zero: offered", { bill: { ...credit, amount: "-0.01" } }, true],
    ["on no job: not offered", { bill: { ...credit, job_id: null } }, false],
    ["a correction: not offered", { bill: { ...credit, corrects_bill_id: "bill-p" } }, false],
    ["something filed under it: not offered", { hasCorrections: true }, false],
    ["set aside (the column): not offered", { bill: { ...credit, superseded_by_bill_id: "bill-2" } }, false],
    ["set aside (the page's flag): not offered", { bill: { ...credit, superseded: true } }, false],
    ["no lines: not offered", { lines: [] }, false],
    ["every part line off the bill (filed): not offered, though its tax still bills", { lines: [part(false), part(false), tax()] }, false],
    ["only a tax line that bills: not offered", { lines: [tax()] }, false],
    ["a positive line (a fee) is no part line: not offered", { lines: [{ description: "Restocking Fee", amount: 5, billable: true }] }, false],
  ];
  for (const [what, over, want] of table) it(what, () => expect(rowOffersFileWithItsBill({ ...base, ...over })).toBe(want));
});

describe("returnRowLine: the row's one slate line", () => {
  it("before: Not filed with its bill yet.; once none of its part lines bills: Its lines are off the customer's bill.; any other bill: nothing", () => {
    expect(returnRowLine(base)).toBe(NOT_FILED_WITH_ITS_BILL);
    expect(NOT_FILED_WITH_ITS_BILL).toBe("Not filed with its bill yet.");
    // The row cannot know who took them off (this door, or a person's Bill switch): never "Filed" (skeptic #86, S5).
    expect(returnRowLine({ ...base, lines: [part(false), part(false), tax()] })).toBe(LINES_OFF_THE_BILL);
    expect(LINES_OFF_THE_BILL).toBe("Its lines are off the customer's bill.");
    expect(returnRowLine({ ...base, bill: { ...credit, amount: 19.02 } })).toBeNull();
    expect(returnRowLine({ ...base, lines: [] })).toBeNull();
    expect(returnRowLine({ ...base, heldBySent: true })).toBeNull();
  });
});
