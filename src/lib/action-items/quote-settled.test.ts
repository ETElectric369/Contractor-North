import { describe, expect, it } from "vitest";
import { quoteSettled, type SettledInvoice } from "./quote-settled";

/** ONE RULE FOR "IS THIS ESTIMATE SETTLED?" (2026-11-04): each why, and what never settles. */
const Q = { id: "q1", status: "accepted", accepted_at: "2026-06-12T17:00:00Z", created_at: "2026-06-01T17:00:00Z" };
const JOB = { id: "j1", status: "in_progress" };
const inv = (o: Partial<SettledInvoice>): SettledInvoice => ({ id: "i1", job_id: "j1", status: "sent", created_at: "2026-07-01T17:00:00Z", invoice_kind: "standard", ...o });

describe("quoteSettled", () => {
  const cases: [string, Parameters<typeof quoteSettled>[0], boolean, string | null][] = [
    ["an invoice naming the estimate", { quote: Q, job: JOB, quoteInvoices: [inv({ quote_id: "q1", job_id: "j9" })] }, true, "invoice-names-quote"],
    ["a draft naming it does not (a draft never settles)", { quote: Q, quoteInvoices: [inv({ quote_id: "q1", status: "draft" })] }, false, null],
    ["a deposit naming it does not (money for work still ahead)", { quote: Q, quoteInvoices: [inv({ quote_id: "q1", invoice_kind: "deposit" })] }, false, null],
    ["a progress draw naming it does not", { quote: Q, quoteInvoices: [inv({ quote_id: "q1", invoice_kind: "progress" })] }, false, null],
    ["a final draw naming it does", { quote: Q, quoteInvoices: [inv({ quote_id: "q1", invoice_kind: "final" })] }, true, "invoice-names-quote"],
    ["a void invoice naming it does not", { quote: Q, quoteInvoices: [inv({ quote_id: "q1", status: "void" })] }, false, null],
    ["no job, an invoice naming it IS settled", { quote: Q, job: null, quoteInvoices: [inv({ quote_id: "q1", job_id: null })] }, true, "invoice-names-quote"],
    ["no job and no invoice is NOT settled", { quote: Q, job: null, quoteInvoices: [] }, false, null],
    ["the job billed after it was accepted", { quote: Q, job: JOB, jobInvoices: [inv({})] }, true, "job-billed"],
    ["the job billed the same day it was accepted", { quote: Q, job: JOB, jobInvoices: [inv({ created_at: "2026-06-12T08:00:00Z" })] }, true, "job-billed"],
    ["a final draw finishes it", { quote: Q, job: JOB, jobInvoices: [inv({ invoice_kind: "final" })] }, true, "job-billed"],
    ["a deposit does not", { quote: Q, job: JOB, jobInvoices: [inv({ invoice_kind: "deposit" })] }, false, null],
    ["a progress draw does not", { quote: Q, job: JOB, jobInvoices: [inv({ invoice_kind: "progress" })] }, false, null],
    ["a draft does not", { quote: Q, job: JOB, jobInvoices: [inv({ status: "draft" })] }, false, null],
    ["a void does not", { quote: Q, job: JOB, jobInvoices: [inv({ status: "void" })] }, false, null],
    ["a bill from before the estimate was accepted does not", { quote: Q, job: JOB, jobInvoices: [inv({ created_at: "2026-05-01T17:00:00Z" })] }, false, null],
    ["a sent estimate counts from the day it was made", { quote: { ...Q, status: "sent", accepted_at: null }, job: JOB, jobInvoices: [inv({ created_at: "2026-06-05T17:00:00Z" })] }, true, "job-billed"],
    ["the job complete", { quote: Q, job: { status: "complete" } }, true, "job-closed"],
    ["the job cancelled", { quote: Q, job: { status: "cancelled" } }, true, "job-closed"],
    ["the job invoiced (the retired status)", { quote: Q, job: { status: "invoiced" } }, true, "job-closed"],
    ["a held job is not closed", { quote: Q, job: { status: "on_hold" } }, false, null],
    ["superseded", { quote: { ...Q, status: "superseded" } }, true, "superseded"],
    ["a revision accepted", { quote: { ...Q, revisions: [{ status: "accepted" }] } }, true, "superseded"],
    ["a revision still sent does not", { quote: { ...Q, revisions: [{ status: "sent" }] } }, false, null],
  ];
  for (const [name, input, settled, why] of cases) {
    it(name, () => {
      expect(quoteSettled(input)).toEqual({ settled, why });
    });
  }
});

/**
 * BADGES SHOW OPEN: a pile whose rows settledOf drops in code can't take the read's SQL count (it
 * includes the settled ones); it says "N+" through codeCount, like the other settled piles.
 */
describe("the settled piles count what is open", () => {
  it("Contracts Not Signed counts in code, never the read's count", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "query.ts"), "utf8");
    expect(src).toMatch(/counts\.contracts_not_signed = codeCount\(conR\)/);
    expect(src).not.toMatch(/sqlCount\(conR\)/);
  });
});
