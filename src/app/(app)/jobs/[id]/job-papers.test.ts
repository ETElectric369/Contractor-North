import { describe, it, expect } from "vitest";
import { onNeedsYouIds, paperNamesJob, papersNamingJob, type PaperDoc } from "./job-papers";

/**
 * NAMED ON A PAPER, NOT RECORDED YET (Erik, 2026-09-25). CED 8802-1107820, $187.64, job name
 * "85 WHITNEY", was in the app as a supplier document and on no cost list and no invoice. The rows
 * here are his live ones (org ET, account CED Truckee), plus the cases that must never be listed.
 */

const J28 = { id: "j28", job_number: "J-028", name: "85 Whitney Place", address: "85 Whitney Court", customerNames: ["Andrew Cohen"] };
const J33 = { id: "j33", job_number: "J-033", name: "5659 Rhodesia", address: "5659 Rhodesia Rd", customerNames: ["Pat Doe"] };
const mark = { markJobs: [J28, J33], pos: [], selfNames: ["Erik Taylor", "ET Electric"] };

const CED = "6fae3d9c";
let n = 0;
const doc = (over: Partial<PaperDoc>): PaperDoc => ({
  id: `d${++n}`,
  accountId: CED,
  invoiceNumber: `8802-110${n}`,
  kind: "invoice",
  invoiceDate: "2026-09-16",
  dueDate: null,
  jobNameRaw: null,
  jobId: null,
  total: 100,
  openBalance: null,
  closed: false,
  discountAmount: null,
  discountBy: null,
  jobName: null,
  billCount: 0,
  ...over,
});

describe("paperNamesJob — the paperwork tray's exact rule, never a likeness", () => {
  it("CED's job name names the job by its street (a street type left off is not another street)", () => {
    expect(paperNamesJob({ jobId: null, jobNameRaw: "85 WHITNEY" }, "j28", mark)).toBe(true);
    // CED's other spelling is the job's own name, word for word.
    expect(paperNamesJob({ jobId: null, jobNameRaw: "85 WHITNEY PLACE" }, "j28", mark)).toBe(true);
    expect(paperNamesJob({ jobId: null, jobNameRaw: "85 WHITNEY" }, "j33", mark)).toBe(false);
  });

  it("a paper a person filed decides by its job, whatever it prints", () => {
    expect(paperNamesJob({ jobId: "j28", jobNameRaw: "5659 RHODESIA" }, "j28", mark)).toBe(true);
    expect(paperNamesJob({ jobId: "j33", jobNameRaw: "85 WHITNEY" }, "j28", mark)).toBe(false);
  });

  it("names nothing on a near miss, shop stock, the form's own header, or a street two open jobs share", () => {
    expect(paperNamesJob({ jobId: null, jobNameRaw: "86 WHITNEY" }, "j28", mark)).toBe(false);
    expect(paperNamesJob({ jobId: null, jobNameRaw: "STOCK" }, "j28", mark)).toBe(false);
    expect(paperNamesJob({ jobId: null, jobNameRaw: "CUSTOMER ORDER NO." }, "j28", mark)).toBe(false);
    const twin = { ...J28, id: "j29", job_number: "J-029", name: "Whitney Garage" };
    expect(paperNamesJob({ jobId: null, jobNameRaw: "85 WHITNEY" }, "j28", { ...mark, markJobs: [J28, twin, J33] })).toBe(false);
  });
});

describe("papersNamingJob — 85 Whitney before INV-081 went out", () => {
  const missing = doc({ id: "de0920b4", invoiceNumber: "8802-1107820", total: 187.64, jobNameRaw: "85 WHITNEY" });
  const docs: PaperDoc[] = [
    missing,
    // In the books already (a Record link or a bill carrying the number): never listed.
    doc({ invoiceNumber: "8802-1105614", total: 376.86, jobNameRaw: "85 WHITNEY PLACE", closed: true, billCount: 1 }),
    doc({ invoiceNumber: "8802-1107695", total: 1062.18, jobNameRaw: "85 WHITNEY", jobId: "j28", billCount: 1 }),
    // Filed on another job by a person: that job's, not this one's.
    doc({ invoiceNumber: "8802-1107001", total: 55, jobNameRaw: "85 WHITNEY", jobId: "j33" }),
    // A credit memo is money coming back, never a missing bill.
    doc({ invoiceNumber: "8802-1107002", kind: "credit_memo", total: -20, jobNameRaw: "85 WHITNEY" }),
    // A purchase a credit memo took straight back: nothing on it was kept.
    doc({ invoiceNumber: "8802-1107230", total: 225.47, jobNameRaw: "85 WHITNEY" }),
    doc({ invoiceNumber: "8802-1107337", kind: "credit_memo", total: -225.47, jobNameRaw: "85 WHITNEY" }),
    // Another job's paper.
    doc({ invoiceNumber: "8802-1107003", total: 80, jobNameRaw: "5659 RHODESIA" }),
  ];

  it("lists 8802-1107820 $187.64 and nothing else", () => {
    const out = papersNamingJob("j28", docs, mark);
    expect(out.map((d) => [d.invoiceNumber, d.total])).toEqual([["8802-1107820", 187.64]]);
  });

  it("lists a paper filed on the job that has no bill, and the credit-memo pairing stays inside one account", () => {
    const filed = doc({ invoiceNumber: "8802-1107900", total: 42.1, jobId: "j28", invoiceDate: "2026-09-20" });
    // The same -$225.47 on ANOTHER supplier's account takes nothing back off CED's purchase.
    const otherAccount = docs.map((d) => (d.invoiceNumber === "8802-1107337" ? { ...d, accountId: "other" } : d));
    const out = papersNamingJob("j28", [...otherAccount, filed], mark);
    // Newest first, then the bigger money.
    expect(out.map((d) => d.invoiceNumber)).toEqual(["8802-1107900", "8802-1107230", "8802-1107820"]);
  });
});

describe("onNeedsYouIds — Open It On Bills lands where the paper is", () => {
  it("is the Needs You cards' own rule: the books line, a reversed purchase and a $0.00 paper are on no card", () => {
    const card = doc({ jobNameRaw: "85 WHITNEY", invoiceDate: "2026-09-16", total: 187.64 });
    const older = doc({ jobNameRaw: "85 WHITNEY", invoiceDate: "2026-05-01", total: 50 });
    const returned = doc({ jobNameRaw: "TTP106", invoiceDate: "2026-09-03", total: 225.47 });
    const memo = doc({ kind: "credit_memo", jobNameRaw: "TTP106", invoiceDate: "2026-09-04", total: -225.47 });
    const zero = doc({ jobNameRaw: "85 WHITNEY", invoiceDate: "2026-09-10", total: 0 });
    const ids = onNeedsYouIds([card, older, returned, memo, zero], "2026-06-08");
    expect(ids.has(card.id)).toBe(true);
    expect(ids.has(older.id)).toBe(false);
    expect(ids.has(returned.id)).toBe(false);
    expect(ids.has(zero.id)).toBe(false);
  });

  it("pairs a credit memo only inside its own account", () => {
    const bought = doc({ jobNameRaw: "85 WHITNEY", total: 80 });
    const otherMemo = doc({ accountId: "other", kind: "credit_memo", total: -80 });
    expect(onNeedsYouIds([bought, otherMemo], null).has(bought.id)).toBe(true);
  });
});
