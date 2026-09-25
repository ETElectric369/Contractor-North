import { describe, expect, it } from "vitest";
import {
  companyUseWord,
  destinationValue,
  fileRefusal,
  paperPickOf,
  parseDestination,
  pickedBecause,
  pickProvenance,
  placeFromMarks,
  rematchPaper,
  shelfRowsOf,
  suggestedDestination,
  type MarkJob,
  type PaperItem,
} from "./paperwork";
import { cleanLines } from "./paper-lines";
import { SHELF_NEEDS_LINES, SHELF_NO_RETURNS } from "./shelf-plan";

/**
 * THE TRAY'S SHOP STOCK DESTINATION (Shop Stock, Phase 2). A CED ticket with STOCK written in its
 * PO box shows up pointed at Shop Stock, with the reason: "Shelf picked from the PO on the bill:
 * STOCK". It is a suggestion: a person can switch it to a job, and can send any ticket to the
 * shelf. Only the PO box and the job-name box are read, the WHOLE box, so "IN STOCK" and
 * "STOCKTON" never trigger it. A ticket with no lines can't go to the shelf yet, and says why.
 */
const J011: MarkJob = { id: "j11", job_number: "J-011", name: "13897 Herringbone", address: "13897 Herringbone Way", customerNames: ["Andrew Cohen"] };
const JOBS = [J011];
const SELF = ["ET Electric", "Erik Taylor"];
const LINES = [
  { description: "RED/YELLOW CONN", quantity: 500, unit_price: 0.1697, amount: 84.85, category: "Materials" },
  { description: "PLSTC TAPE", quantity: 2, unit_price: 10.05, amount: 20.1, category: "Materials" },
  { description: "Sales Tax", quantity: 1, unit_price: 9.45, amount: 9.45, category: "Tax" },
];
const stockPaper = (proposal: Record<string, unknown>, over: Partial<PaperItem> = {}): PaperItem => ({
  id: "stock-1",
  kind: "receipt",
  status: "needs_review",
  doc_type: "bill",
  category: "Bill",
  title: "CED — $114.40",
  vendor: "Consolidated Electrical Dist.",
  amount: "114.40",
  doc_number: "8802-1103061",
  line_items: LINES,
  proposal,
  ...over,
});

describe("the destination's value", () => {
  it("round-trips as \"stock\"", () => {
    expect(destinationValue({ type: "stock" })).toBe("stock");
    expect(parseDestination("stock")).toEqual({ type: "stock" });
  });
});

describe("which words name the shelf: the WHOLE PO or job-name box, never the hint", () => {
  it.each(["STOCK", "Stock", "shop stock", "SHOP  STOCK.", "INVENTORY"])("%s names the shelf", (word) => {
    expect(companyUseWord(word)?.shelf).toBe(true);
  });
  it.each(["IN STOCK", "STOCKTON", "STOCK 13897 HERRINGBONE", "RESTOCK", "STOCK ROOM"])("%s does not", (word) => {
    expect(companyUseWord(word)?.shelf ?? false).toBe(false);
  });
  it("STOCK in the hint alone picks nothing", () => {
    const row = rematchPaper(stockPaper({ po: null, jobHint: "STOCK", jobId: null, jobFrom: null }), JOBS, [], SELF);
    expect(suggestedDestination(row, ["j11"])).toBe("");
  });
});

describe("PO STOCK is suggested to the shelf, with the because-line", () => {
  it("picks Shop Stock and says the words that picked it", () => {
    const row = rematchPaper(stockPaper({ po: "STOCK", jobId: null, jobFrom: null }), JOBS, [], SELF);
    expect(suggestedDestination(row, ["j11"])).toBe("stock");
    expect(paperPickOf(row)).toBe("stock");
    expect(pickedBecause(row)).toBe("Shelf picked from the PO on the bill: STOCK");
  });

  it("STOCK plus a job named on the same paper is two answers: nothing is picked, and the row says so", () => {
    const place = placeFromMarks({ po: "STOCK", address: "13897 HERRINGBONE" }, JOBS, [], SELF);
    expect(place.job.kind).toBe("conflict");
    const row = rematchPaper(stockPaper({ po: "STOCK", marks: { po: "STOCK", address: "13897 HERRINGBONE" }, jobId: null, jobFrom: null }), JOBS, [], SELF);
    expect(suggestedDestination(row, ["j11"])).toBe("");
    expect((row.proposal as { jobConflict?: string }).jobConflict).toContain('the PO "STOCK"');
  });

  it("a supplier's fee is never stock", () => {
    const place = placeFromMarks({ po: "STOCK" }, JOBS, [], SELF, { feeShaped: true });
    expect(place.companyUse?.shelf).toBeUndefined();
  });

  it("a return is never suggested to the shelf", () => {
    const row = rematchPaper(stockPaper({ po: "STOCK", jobId: null, jobFrom: null }, { amount: "-20.00" }), JOBS, [], SELF);
    expect(suggestedDestination(row, ["j11"])).toBe("");
  });

  it("a person filing it where the paper said is 'paper'; filing it to a job instead is theirs and the note says so", () => {
    const row = rematchPaper(stockPaper({ po: "STOCK", jobId: null, jobFrom: null }), JOBS, [], SELF);
    expect(pickProvenance(row, "stock").filed.picked).toBe("paper");
    const onJob = pickProvenance(row, "job:j11");
    expect(onJob.filed.picked).toBe("person");
    expect(onJob.note).toBe("A person picked this over what the paper names (Shelf picked from the PO on the bill: STOCK).");
  });
});

describe("the gate: what can go on the shelf", () => {
  it("a ticket with lines is ready", () => {
    expect(fileRefusal(stockPaper({ po: "STOCK" }), { type: "stock" })).toBeNull();
  });
  it("a lineless ticket refuses with the plan's sentence", () => {
    expect(fileRefusal(stockPaper({ po: "STOCK" }, { line_items: [] }), { type: "stock" })).toBe(SHELF_NEEDS_LINES);
  });
  it("a return refuses", () => {
    expect(fileRefusal(stockPaper({}, { amount: "-20.00", line_items: [{ description: "RETURN", amount: -20 }] }), { type: "stock" })).toBe(SHELF_NO_RETURNS);
  });
  it("not a receipt or a bill refuses; a filed paper refuses", () => {
    expect(fileRefusal(stockPaper({}, { doc_type: "not_a_cost", kind: "job_document" }), { type: "stock" })).toContain("Only a receipt or a bill");
    expect(fileRefusal(stockPaper({}, { status: "filed", bill_id: "b" }), { type: "stock" })).toContain("already filed");
  });
});

describe("shelfRowsOf: the lines in exactly the order the bill will hold them", () => {
  it("is cleanLines, pointed with the total, indexed", () => {
    const rows = shelfRowsOf(stockPaper({}));
    expect(rows.map((r) => [r.index, r.description, r.amount])).toEqual(cleanLines(LINES).map((l, i) => [i, l.description, l.amount]));
  });
  it("a blank line the bill would drop is dropped here too, so the indexes still line up", () => {
    const rows = shelfRowsOf(stockPaper({}, { line_items: [{ description: "" , amount: 1 }, ...LINES] }));
    expect(rows[0].description).toBe("RED/YELLOW CONN");
    expect(rows).toHaveLength(3);
  });
});
