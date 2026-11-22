import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteSettled, saleWentAway, type SettledInvoice } from "./quote-settled";

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

/**
 * ONE ANSWER RECORDED ELSEWHERE (cn-v1175, R3), for a draft or a sent estimate only: its lead is Not Sold.
 * And NO SIBLING RULE (skeptic #78): another estimate accepted on the same job or lead answers nothing for
 * this one (Keep Both's restored offer; a second estimate for extra work).
 */
describe("quoteSettled: the lead's answer, and no sibling rule (cn-v1175)", () => {
  const DRAFT = { id: "q1", status: "draft", created_at: "2026-11-01T17:00:00Z" };
  const cases: [string, Parameters<typeof quoteSettled>[0], boolean, string | null][] = [
    ["a draft whose lead is Not Sold", { quote: DRAFT, lead: { status: "lost" } }, true, "lead-not-sold"],
    ["a sent one whose lead is Not Sold", { quote: { ...DRAFT, status: "sent" }, lead: { status: "lost" } }, true, "lead-not-sold"],
    ["a lead still open does not", { quote: DRAFT, lead: { status: "contacted" } }, false, null],
    ["an accepted estimate's lead going Not Sold does not touch it", { quote: { ...DRAFT, status: "accepted" }, lead: { status: "lost" } }, false, null],
    // Keep Both (cn-v1168): the earlier estimate is back to sent as an open offer, on the lead the accepted
    // one converted and on its scheduled job, with no revision of it accepted.
    [
      "Keep Both's restored sent estimate on a live job, its lead converted: NOT settled",
      { quote: { ...DRAFT, status: "sent", revisions: [] }, job: { id: "j1", status: "scheduled" }, jobInvoices: [], quoteInvoices: [], lead: { status: "converted" } },
      false,
      null,
    ],
    // A second estimate written for extra work on a job that already has an accepted one: still to send.
    [
      "a draft for extra work on a job with an accepted estimate: NOT settled",
      { quote: DRAFT, job: { id: "j1", status: "in_progress" }, jobInvoices: [{ id: "i1", job_id: "j1", status: "sent", invoice_kind: "deposit", created_at: "2026-11-02T17:00:00Z" }], lead: null },
      false,
      null,
    ],
    ["a revision of it accepted still settles it (the superseded arm)", { quote: { ...DRAFT, status: "sent", revisions: [{ status: "accepted" }] } }, true, "superseded"],
  ];
  for (const [name, input, settled, why] of cases) it(name, () => expect(quoteSettled(input)).toEqual({ settled, why }));

  it("the rule takes no siblings and names no sibling why", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/action-items/quote-settled.ts"), "utf8");
    expect(src).not.toContain("siblings?:");
    expect(src).not.toContain('"sibling-accepted"');
    expect(src).toContain("NO SIBLING RULE");
  });
});

describe("saleWentAway: a job whose every estimate ended unsold, with nothing done or billed (cn-v1175, R3)", () => {
  it.each([
    ["every estimate declined or expired, no time, no bill", [{ status: "declined" }, { status: "expired" }], false, false, true],
    ["one still sent", [{ status: "declined" }, { status: "sent" }], false, false, false],
    ["time on it", [{ status: "declined" }], true, false, false],
    ["a bill on it", [{ status: "declined" }], false, true, false],
    ["no estimate at all (a job made directly)", [], false, false, false],
    ["an accepted one", [{ status: "accepted" }], false, false, false],
  ] as const)("%s -> %s", (_name, quotes, hasTime, hasInvoice, expected) => {
    expect(saleWentAway({ quotes: [...quotes], hasTime, hasInvoice })).toBe(expected);
  });
});
