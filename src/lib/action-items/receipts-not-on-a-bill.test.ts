import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECEIPT_CATEGORIES,
  RECEIPTS_READ_CAP,
  postgrestIn,
  receiptRowJob,
  receiptRowTitle,
  receiptsNotOnABill,
  tieReadFilters,
  type ReceiptDoc,
} from "./receipts-not-on-a-bill";
import type { PaperTie } from "@/lib/job-photos";

/**
 * RECEIPTS NOT ON A BILL: a receipt or bill on a job that nothing accounts for comes to Needs You,
 * by lib/job-photos' own rule (sortJobPapers.loose), never a second copy of it.
 */
let seq = 0;
const doc = (o: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  id: `d${++seq}`,
  name: `IMG_${seq}.jpg`,
  category: "Receipt",
  file_url: `org/job-1/${seq}.jpg`,
  job_id: "job-1",
  uploaded_by: "tech-1",
  created_at: "2026-09-27T17:00:00Z",
  jobs: { job_number: "J-011", name: "Honeysuckle" },
  ...o,
});
const tie = (o: Partial<PaperTie>): PaperTie => ({ document_id: null, bill_id: null, file_url: null, ...o });
const loose = (docs: ReceiptDoc[], ties: PaperTie[] | null) => receiptsNotOnABill(docs, ties)?.map((d) => d.id) ?? null;

describe("which receipts are on no bill", () => {
  it("a tech's unread photo from Snap Or Note shows: a Receipt on the job, no tie at all", () => {
    const photo = doc();
    expect(loose([photo], [])).toEqual([photo.id]);
  });

  it("a receipt tied to a bill doesn't (by its document, or by its file when the tie names no document)", () => {
    const byDoc = doc();
    const byFile = doc();
    expect(loose([byDoc, byFile], [tie({ document_id: byDoc.id, bill_id: "b1" }), tie({ file_url: byFile.file_url, tied_bill_id: "b2" })])).toEqual([]);
  });

  it("a receipt tied to a supplier's document, or to petty cash, doesn't: it is on the books", () => {
    const supplier = doc();
    const petty = doc();
    expect(loose([supplier, petty], [tie({ document_id: supplier.id, tied_supplier_invoice_id: "si-1" }), tie({ document_id: petty.id, petty_cash_id: "pc-1" })])).toEqual([]);
  });

  it("a tie that accounts for nothing (a reader's row with no bill yet) leaves it on no bill", () => {
    const read = doc();
    expect(loose([read], [tie({ document_id: read.id, kind: "receipt" })])).toEqual([read.id]);
  });

  it("an Invoice never does (nothing reads one into a bill), nor a Photo, nor a paper on no job", () => {
    expect(loose([doc({ category: "Invoice" }), doc({ category: "Photo" }), doc({ job_id: null })], [])).toEqual([]);
    expect(RECEIPT_CATEGORIES).toEqual(["Receipt", "Bill"]);
  });

  it("a failed tie read claims nothing: null, never 'every receipt is loose'", () => {
    expect(receiptsNotOnABill([doc(), doc()], null)).toBeNull();
  });

  it("one paper, one row: a paper still waiting in the tray (a needs-review tie) is the tray's row, not a second one here", () => {
    const inTray = doc();
    const byFile = doc();
    const loose2 = doc();
    const ties = [
      { ...tie({ document_id: inTray.id, kind: "receipt" }), status: "needs_review" },
      { ...tie({ file_url: byFile.file_url, kind: "receipt" }), status: "needs_review" },
      { ...tie({ document_id: loose2.id, kind: "receipt" }), status: "filed" },
    ];
    expect(receiptsNotOnABill([inTray, byFile, loose2], ties)?.map((d) => d.id)).toEqual([loose2.id]);
  });
});

describe("the row's words", () => {
  it("what it is, who snapped it and the day; no amount (nothing has read it)", () => {
    expect(receiptRowTitle(doc({ created_at: "2026-09-27T17:00:00Z" }), "Brian Smith", "America/Los_Angeles")).toBe("Receipt from Brian · Sep 27");
    expect(receiptRowTitle(doc({ category: "Bill", created_at: "2026-09-27T17:00:00Z" }), null, "America/Los_Angeles")).toBe("Bill · Sep 27");
    expect(receiptRowTitle(doc(), "Brian", "America/Los_Angeles")).not.toMatch(/\$/);
  });

  it("the job leads with its name, the number second", () => {
    expect(receiptRowJob(doc())).toBe("Honeysuckle · J-011");
    expect(receiptRowJob(doc({ jobs: { job_number: "J-011", name: null } }))).toBe("J-011");
  });
});

describe("the tie read", () => {
  it("names each paper by id and by file, quoted, in chunks", () => {
    const docs = Array.from({ length: 130 }, (_, i) => doc({ id: `d-${i}`, file_url: `org/j/${i},x.jpg` }));
    const f = tieReadFilters(docs, 60);
    expect(f).toHaveLength(3);
    expect(f[0]).toContain('document_id.in.("d-0",');
    expect(f[0]).toContain('file_url.in.("org/j/0,x.jpg",');
    expect(postgrestIn(['a"b'])).toBe('("a\\"b")');
  });

  it("the build reads it once, capped with an exact count, and hands the rule the ties", () => {
    const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    expect(query).toContain(".in(\"category\", [...RECEIPT_CATEGORIES])");
    expect(query).toContain(".limit(RECEIPTS_READ_CAP)");
    expect(query).toContain("receiptsNotOnABill(");
    expect(query).toContain("Receipts · Couldn't Check");
    expect(RECEIPTS_READ_CAP).toBe(200);
  });
});
