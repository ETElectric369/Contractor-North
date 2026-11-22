import { describe, it, expect } from "vitest";
import { billLinesWhat, paperSummary, readersForPaper, type PaperBillFacts, type PaperReaderFacts, type PaperSummary } from "./paper-summary";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHAT A PAPER IS, AND WHAT IT CAME TO (cn-v1174, the owner on the Costs tab: "receipts and papers
 * need to show a summary and total amount for identification pls"). ONE rule: the bill wins; the
 * receipt reader's record next; else nothing (never a guess, never $0).
 */
const more = (n: number) => `+${n} more`;

const bill = (over: Partial<PaperBillFacts> = {}): PaperBillFacts => ({
  amount: 412.5,
  bill_line_items: [{ description: "12/2 wire, 250 ft" }, { description: "Single-pole breaker" }],
  ...over,
});
const reader = (over: Partial<PaperReaderFacts> = {}): PaperReaderFacts => ({
  vendor: "Northline Supply",
  title: "Panel parts",
  summary: "Breakers and wire for the Larkspur job",
  amount: 88.1,
  ...over,
});

const CASES: { name: string; bill?: PaperBillFacts | null; readers?: PaperReaderFacts[] | null; want: PaperSummary }[] = [
  {
    name: "on a bill: the bill's lines and amount, the reader's record ignored (the bill wins)",
    bill: bill(),
    readers: [reader()],
    want: { what: "12/2 wire, 250 ft, Single-pole breaker", total: 412.5, from: "bill" },
  },
  {
    name: "a bill with more lines than are named says +N more",
    bill: bill({ bill_line_items: [{ description: "Wire" }, { description: "Box" }, { description: "Clamp" }, { description: "Tape" }] }),
    want: { what: "Wire, Box +2 more", total: 412.5, from: "bill" },
  },
  {
    name: "a bill with no line words: its amount alone, no invented line",
    bill: bill({ bill_line_items: [{ description: "  " }, { description: null }] }),
    readers: [reader()],
    want: { what: null, total: 412.5, from: "bill" },
  },
  {
    name: "a zero bill is shown as recorded",
    bill: bill({ amount: 0 }),
    want: { what: "12/2 wire, 250 ft, Single-pole breaker", total: 0, from: "bill" },
  },
  {
    name: "a credit (negative) is shown as recorded",
    bill: bill({ amount: "-35.20" }),
    want: { what: "12/2 wire, 250 ft, Single-pole breaker", total: -35.2, from: "bill" },
  },
  {
    name: "no bill: the reader's vendor and title, and its amount",
    readers: [reader()],
    want: { what: "Northline Supply · Panel parts", total: 88.1, from: "reader" },
  },
  {
    name: "no title: the reader's summary instead",
    readers: [reader({ title: null })],
    want: { what: "Northline Supply · Breakers and wire for the Larkspur job", total: 88.1, from: "reader" },
  },
  {
    name: "a reader record with no amount shows no figure (never $0)",
    readers: [reader({ amount: null })],
    want: { what: "Northline Supply · Panel parts", total: null, from: "reader" },
  },
  {
    name: "the first reader record that says anything is the one",
    readers: [reader({ vendor: null, title: null, summary: null, amount: null }), reader({ vendor: "Catbird Lumber", title: null, summary: null, amount: 12 })],
    want: { what: "Catbird Lumber", total: 12, from: "reader" },
  },
  {
    name: "nobody read it: nothing, and no figure",
    readers: [],
    want: { what: null, total: null, from: "none" },
  },
  {
    name: "a reader record that says nothing is nothing",
    readers: [reader({ vendor: "", title: " ", summary: null, amount: "" })],
    want: { what: null, total: null, from: "none" },
  },
];

describe("paperSummary: the one rule, as a table", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(paperSummary({ bill: c.bill ?? null, readers: c.readers ?? null, more })).toEqual(c.want);
    });
  }

  it("long text is never cut in the data (the row clamps it in CSS)", () => {
    const long = "A".repeat(400);
    expect(paperSummary({ readers: [reader({ title: long })], more }).what).toBe(`Northline Supply · ${long}`);
  });

  it("the bill's lines skip repeats and blanks, in order, and the words for +N come from the caller", () => {
    expect(billLinesWhat([{ description: "Wire" }, { description: "wire" }, { description: "" }, { description: "Box" }, { description: "Clamp" }], (n) => `+${n} más`)).toBe(
      "Wire, Box +1 más",
    );
    expect(billLinesWhat([], more)).toBeNull();
  });
});

describe("which of a paper's records is shown (skeptic, cn-v1174: several records, one arbitrary)", () => {
  const paper = { id: "d1", file_url: "org/job/1.jpg" };
  const rec = (id: string, over: Record<string, unknown>) => ({ id, document_id: null, file_url: null, created_at: null, ...over }) as {
    id: string; document_id: string | null; file_url: string | null; created_at: string | null; vendor?: string; amount?: number;
  };

  it("an exact document match wins over a file match, even an older one", () => {
    const ties = [
      rec("byFile-new", { file_url: "org/job/1.jpg", created_at: "2026-11-20T10:00:00Z" }),
      rec("exact-old", { document_id: "d1", created_at: "2026-11-01T10:00:00Z" }),
    ];
    expect(readersForPaper(paper, ties).map((r) => r.id)).toEqual(["exact-old", "byFile-new"]);
  });

  it("among equals the newest wins; a record with no stamp goes last", () => {
    const ties = [
      rec("a", { document_id: "d1", created_at: "2026-11-02T10:00:00Z" }),
      rec("none", { document_id: "d1" }),
      rec("b", { document_id: "d1", created_at: "2026-11-19T10:00:00Z" }),
    ];
    expect(readersForPaper(paper, ties).map((r) => r.id)).toEqual(["b", "a", "none"]);
  });

  it("a record naming another paper, or the same file under another paper's id, is not this paper's", () => {
    const ties = [
      rec("other", { document_id: "d2", file_url: "org/job/1.jpg" }),
      rec("elsewhere", { file_url: "org/job/2.jpg" }),
    ];
    expect(readersForPaper(paper, ties)).toEqual([]);
    expect(readersForPaper({ id: "d1", file_url: null }, [rec("x", { file_url: null })])).toEqual([]);
  });

  it("paperSummary then shows the winner's record", () => {
    const ties = [
      { ...rec("old", { document_id: "d1", created_at: "2026-11-01T10:00:00Z" }), vendor: "Northline Supply", amount: 10 },
      { ...rec("new", { document_id: "d1", created_at: "2026-11-19T10:00:00Z" }), vendor: "Northline Supply", amount: 42 },
    ];
    expect(paperSummary({ readers: readersForPaper(paper, ties), more }).total).toBe(42);
  });

  it("the job page reads the records newest first and matches through the one function", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).toContain('petty_cash_id, file_url, title, summary, vendor, amount, item_date, doc_number, created_at")');
    expect(page).toContain('.order("created_at", { ascending: false })\n      .limit(2000),');
    expect(page).toContain("const readers = readersForPaper({ id: String(d.id), file_url: d.file_url }, (paperTies ?? []) as any[]);");
  });
});
