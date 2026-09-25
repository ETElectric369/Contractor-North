import { describe, expect, it } from "vitest";
import {
  bucketIsReaders,
  companyUseWord,
  findSameNumber,
  guessOf,
  onPaperWords,
  paperPickOf,
  pickedBecause,
  pickProvenance,
  placeFromMarks,
  rematchPaper,
  suggestedDestination,
  type MarkJob,
  type PaperItem,
} from "./paperwork";
import { indexSupplierAliases } from "./supplier-identity";

/**
 * "TOOLS" IN THE PO BOX (Erik, 2026-09-24). ET's live row 5b670ec2, Paper A: a CED sales-order
 * ticket, $44.44, 8802-SO-257558, PO "TOOLS", hint "JOB NAME AND ADDRESS ERIK TAYLOR TOOLS". It
 * came in asking "Where does this go?", with the reader's bucket labelled "Not read off the paper".
 * The PO picks the Tools & Supplies business cost exactly the way "13897 HERRINGBONE" picks J-011.
 */
const J011: MarkJob = { id: "j11", job_number: "J-011", name: "13897 Herringbone", address: "13897 Herringbone Way", customerNames: ["Andrew Cohen"] };
const J046: MarkJob = { id: "j46", job_number: "J-046", name: "Jason Waldow", address: "518 Crater Lake Rd", customerNames: ["Jason Waldow"] };
const JOBS = [J011, J046];
const SELF = ["ET Electric", "Erik Taylor", "Brian Taylor", "Jimmy Santoliva"];

const paperA = (proposal: Record<string, unknown>, over: Partial<PaperItem> = {}): PaperItem => ({
  id: "5b670ec2",
  kind: "receipt",
  status: "needs_review",
  doc_type: "bill",
  category: "Bill",
  title: "Consolidated Electrical Dist. — $44.44",
  vendor: "Consolidated Electrical Dist.",
  amount: "44.44",
  doc_number: "8802-SO-257558",
  proposal,
  ...over,
});
/** Exactly as it is stored today (read at cn-v993: no marks, the reader's bucket, no `why`). */
const LIVE_A = {
  po: "TOOLS",
  jobId: null,
  bucket: "Tools & Supplies",
  jobFrom: null,
  jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR TOOLS",
  guessJobId: null,
  jobConflict: null,
};

describe("companyUseWord: the whole box, exactly", () => {
  it.each([
    ["TOOLS", "Tools & Supplies"],
    ["Tool", "Tools & Supplies"],
    ["SHOP TOOLS", "Tools & Supplies"],
    ["TRUCK", "Gas & Truck"],
    ["TRUCK #2", "Gas & Truck"],
    ["#2 TRUCK", "Gas & Truck"],
    ["VAN 1", "Gas & Truck"],
    ["OFFICE", "Phone & Office"],
  ])("%s picks %s", (word, bucket) => {
    expect(companyUseWord(word)).toEqual({ bucket, words: word });
  });

  it.each(["STOCK", "SHOP STOCK", "INVENTORY"])("%s names the shop shelf and picks no bucket (Shop Stock, Phase 2)", (word) => {
    expect(companyUseWord(word)).toEqual({ bucket: null, words: word, shelf: true });
  });

  it.each(["TOOLS FOR HERRINGBONE", "SHOP", "ERIK TAYLOR", "ET ELECTRIC", "WILL CALL", "13897 HERRINGBONE", "", null])("%s is not a company word", (word) => {
    expect(companyUseWord(word as string | null)).toBeNull();
  });
});

describe("placeFromMarks: a job mark beats a company word; a paper naming both picks nothing", () => {
  it("PO TOOLS picks Tools & Supplies, from the PO", () => {
    expect(placeFromMarks({ po: "TOOLS", hint: "JOB NAME AND ADDRESS ERIK TAYLOR TOOLS" }, JOBS, [], SELF)).toEqual({
      job: { kind: "none" },
      companyUse: { bucket: "Tools & Supplies", from: "po", words: "TOOLS" },
    });
  });

  it("a job named Tools is that job: the job mark beats the word", () => {
    const toolsJob: MarkJob = { id: "jt", job_number: "J-099", name: "Tools", address: null, customerNames: [] };
    const r = placeFromMarks({ po: "TOOLS" }, [...JOBS, toolsJob], [], SELF);
    expect(r.job).toMatchObject({ kind: "one", jobId: "jt" });
    expect(r.companyUse).toBeNull();
  });

  it("PO TOOLS and a street in the hint names both, says so, and picks nothing", () => {
    const r = placeFromMarks({ po: "TOOLS", hint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE" }, JOBS, [], SELF);
    expect(r.job.kind).toBe("conflict");
    expect(r.job.kind === "conflict" && r.job.sentence).toBe(
      'The paper names a job (the address "13897 HERRINGBONE") and the company\'s own use (the PO "TOOLS"), so nothing was picked.',
    );
  });

  it("the company's own names alone pick nothing (they are on every ticket)", () => {
    expect(placeFromMarks({ po: "ERIK TAYLOR", customer: "ERIK TAYLOR" }, JOBS, [], SELF)).toEqual({ job: { kind: "none" }, companyUse: null });
  });

  it("a fee-shaped paper is never given a bucket by a word", () => {
    expect(placeFromMarks({ po: "OFFICE" }, JOBS, [], SELF, { feeShaped: true }).companyUse).toEqual({ bucket: null, from: "po", words: "OFFICE" });
  });
});

describe("Paper A in the tray, replayed from its stored row", () => {
  const shown = rematchPaper(paperA(LIVE_A), JOBS, [], SELF);

  it("picks Tools & Supplies from the PO, and says why in the words on the paper", () => {
    expect(suggestedDestination(shown, ["j11", "j46"])).toBe("cost:Tools & Supplies");
    expect(pickedBecause(shown)).toBe("Business cost picked from the PO on the bill: TOOLS");
    expect(paperPickOf(shown)).toBe("cost:Tools & Supplies");
  });

  it("the reader's own bucket is the same answer, so no second chip", () => {
    expect(guessOf(shown, ["j11", "j46"])).toBeNull();
  });

  it("a paper filed, set aside, or read as not a cost is left alone", () => {
    expect(rematchPaper(paperA(LIVE_A, { status: "filed" }), JOBS, [], SELF)).toEqual(paperA(LIVE_A, { status: "filed" }));
    const permit = rematchPaper(paperA(LIVE_A, { doc_type: "not_a_cost", kind: "job_document" }), JOBS, [], SELF);
    expect(suggestedDestination(permit, ["j11"])).toBe("");
  });

  it("STOCK suggests the shelf, and says the words that picked it (Shop Stock, Phase 2)", () => {
    const stock = rematchPaper(paperA({ ...LIVE_A, po: "STOCK", bucket: null }), JOBS, [], SELF);
    expect(suggestedDestination(stock, ["j11"])).toBe("stock");
    expect(pickedBecause(stock)).toMatch(/^Shelf picked from the PO on the (bill|receipt|invoice): STOCK$/);
    expect(onPaperWords({ ...LIVE_A, po: "STOCK" }, SELF)).toBe("PO STOCK");
  });
});

describe("a stored company word is placed again on every load, like any other row", () => {
  const STOCK_USE = { bucket: null, from: "po", words: "STOCK", shelf: true };
  const TOOLS_USE = { bucket: "Tools & Supplies", from: "po", words: "TOOLS" };

  it("the same answer returns the row untouched", () => {
    const row = paperA({ ...LIVE_A, companyUse: TOOLS_USE });
    expect(rematchPaper(row, JOBS, [], SELF)).toBe(row);
  });

  it("PO STOCK read before its job existed shows the conflict a read today would find", () => {
    // Read when J-011 did not exist yet: the hint's street matched nothing, so only STOCK was kept.
    const row = paperA({ ...LIVE_A, po: "STOCK", bucket: null, jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE", companyUse: STOCK_USE });
    expect(rematchPaper(row, [], [], SELF)).toBe(row);
    const now = rematchPaper(row, JOBS, [], SELF);
    expect(now.proposal).toMatchObject({ companyUse: STOCK_USE, jobId: null });
    expect((now.proposal as { jobConflict?: string }).jobConflict).toContain('the PO "STOCK"');
    expect(suggestedDestination(now, ["j11"])).toBe("");
  });

  it("PO TOOLS stops picking the bucket once the address names a job too: a person decides", () => {
    const row = paperA({ ...LIVE_A, jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE", companyUse: TOOLS_USE });
    const now = rematchPaper(row, JOBS, [], SELF);
    expect(suggestedDestination(now, ["j11"])).toBe("");
    expect(paperPickOf(now)).toBe("");
  });

  it("a job the owner later named after the word takes the row, and the stored word is cleared", () => {
    const toolsJob: MarkJob = { id: "jt", job_number: "J-099", name: "Tools", address: null, customerNames: [] };
    const now = rematchPaper(paperA({ ...LIVE_A, companyUse: TOOLS_USE }), [...JOBS, toolsJob], [], SELF);
    expect(now.proposal).toMatchObject({ jobId: "jt", jobFrom: "po", companyUse: null });
    expect(paperPickOf(now)).toBe("job:jt");
  });
});

describe("the reader's guess is the reader's, and says so", () => {
  it("a bucket with no `why` is the reader's; AI Suggest's always carries one", () => {
    expect(bucketIsReaders({ bucket: "Tools & Supplies" })).toBe(true);
    expect(bucketIsReaders({ bucket: "Tools & Supplies", why: null })).toBe(false);
    expect(bucketIsReaders({ bucket: "Tools & Supplies", bucketFrom: "reader", why: "x" })).toBe(true);
    expect(bucketIsReaders({ bucket: "Tools & Supplies", bucketFrom: "ai" })).toBe(false);
  });

  it("the paper's own words, with the company's names taken out of the hint", () => {
    expect(onPaperWords({ po: "TOOLS", jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR TOOLS" }, SELF)).toBe("PO TOOLS");
    expect(onPaperWords({ jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR SHOP" }, SELF)).toBe("JOB NAME AND ADDRESS SHOP");
    expect(onPaperWords({}, SELF)).toBeNull();
  });
});

describe("pickProvenance: who decided where the paper went (Paper B, audit v994 tray F1)", () => {
  // ET's live row 12962a84, read 24 minutes before the PO-street rule shipped: no pick stored.
  const paperB = rematchPaper(
    {
      id: "12962a84",
      kind: "receipt",
      status: "needs_review",
      doc_type: "bill",
      category: "Bill",
      vendor: "Consolidated Electrical Dist.",
      amount: "323.71",
      doc_number: "8802-SO-257555",
      proposal: { po: "13897 HERRINGBONE", jobId: null, jobFrom: null, bucket: null, guessJobId: null, jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE" },
    },
    JOBS,
    [],
    SELF,
  );

  it("filed on J-011: the PAPER picked it, and the note carries the because-line", () => {
    expect(pickProvenance(paperB, "job:j11")).toEqual({
      filed: {
        picked: "paper",
        paperPick: "job:j11",
        because: "Job picked from the PO on the bill: 13897 HERRINGBONE",
        jobFrom: "po",
        jobHint: "13897 HERRINGBONE",
      },
      note: "Job picked from the PO on the bill: 13897 HERRINGBONE.",
    });
  });

  it("filed somewhere else: a PERSON overrode the paper, and the note says so in so many words", () => {
    const r = pickProvenance(paperB, "job:j46");
    expect(r.filed.picked).toBe("person");
    expect(r.note).toBe("A person picked this over what the paper names (Job picked from the PO on the bill: 13897 HERRINGBONE).");
  });

  it("a model's guess tapped is a guess, never the paper", () => {
    const guessed = { ...paperB, proposal: { guessJobId: "j46", why: "near the store" } } as PaperItem;
    expect(pickProvenance(guessed, "job:j46").filed.picked).toBe("guess");
    const reader = rematchPaper(paperA({ ...LIVE_A, po: null, jobHint: null }), JOBS, [], SELF);
    const r = pickProvenance(reader, "cost:Tools & Supplies");
    expect(r.filed.picked).toBe("guess");
    expect(r.note).toBe("A person picked the reader's guess; it was not read off the paper.");
  });

  it("Paper A filed as Tools & Supplies: the PO picked it", () => {
    const r = pickProvenance(rematchPaper(paperA(LIVE_A), JOBS, [], SELF), "cost:Tools & Supplies");
    expect(r.filed.picked).toBe("paper");
    expect(r.note).toBe("Business cost picked from the PO on the bill: TOOLS.");
  });
});

describe("findSameNumber reads the bill the supplier's door wrote", () => {
  const aliases = indexSupplierAliases([{ alias: "CED", supplier_account_id: "acct-ced" }]);
  it("a bill Record It As A Bill wrote (supplier_invoice_number) is on the books; a set-aside copy is not", () => {
    const recorded = {
      id: "rec-1",
      supplier: "CED Truckee",
      bill_number: null,
      supplier_invoice_number: "8802-1109000",
      supplier_account_id: "acct-ced",
      amount: 400,
      bill_date: "2026-09-12",
      job_id: "job-046",
      jobs: { job_number: "J-046", name: "Jason Waldow" },
    };
    const paper: PaperItem = { id: "p", kind: "receipt", status: "needs_review", doc_type: "bill", vendor: "CED", amount: 400, doc_number: "8802-1109000" };
    expect(findSameNumber(paper, { bills: [recorded] }, aliases)).toEqual([expect.objectContaining({ kind: "bill", billId: "rec-1" })]);
    expect(findSameNumber(paper, { bills: [{ ...recorded, superseded_by_bill_id: "keeper" }] }, aliases)).toEqual([]);
  });
});
