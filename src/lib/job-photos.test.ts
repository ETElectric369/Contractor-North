import { describe, it, expect } from "vitest";
import { billPapers, isImageDoc, papersOffThisJob, sortJobPapers, type JobPaperRow, type PaperTie } from "./job-photos";
import { documentsForViewer } from "./tech-documents";

/**
 * PHOTOS ARE NOT BILLS (Erik, 2026-09-27: "photos should have a distinction between bills and job
 * photos and maybe even keep them separate"). The Photos tab took every image on the job; ET had 40
 * Photo and 40 Receipt documents on its jobs, all in one grid. Every picture now has one home.
 */

const doc = (id: string, category: string | null, file = `org/job/${id}.jpg`, name = `${id}.jpg`): JobPaperRow & { created_at: string } => ({
  id,
  name,
  category,
  file_url: file,
  signedUrl: `https://x.test/${file}?token=t`,
  created_at: "2026-09-20T17:00:00Z",
});

// A J-002-shaped job: panel photos, receipts the reader made bills of, a receipt on no bill, a PDF
// receipt, a CED invoice picture, a plan picture, an uncategorized phone picture, and one Organize read.
const DOCS = [
  doc("photo-panel", "Photo"),
  doc("photo-trench", "Photo"),
  doc("rcpt-ced", "Receipt"),
  doc("rcpt-hd", "Receipt"),
  doc("rcpt-loose", "Receipt", "org/job/image.jpg", "image.jpg"),
  doc("rcpt-pdf", "Receipt", "org/job/QOT1013147.pdf", "QOT1013147.pdf"),
  doc("inv-ced", "Invoice"),
  doc("plan-pic", "Plan"),
  doc("raw-pic", null),
  doc("raw-read", null),
];
const BILLS = ["bill-ced", "bill-hd", "bill-pdf", "bill-inv"];
const TIES: PaperTie[] = [
  { id: "t1", kind: "receipt", document_id: "rcpt-ced", bill_id: "bill-ced", file_url: "org/job/rcpt-ced.jpg" },
  { id: "t2", kind: "receipt", document_id: "rcpt-hd", bill_id: "bill-hd", file_url: "org/job/rcpt-hd.jpg" },
  { id: "t3", kind: "receipt", document_id: "rcpt-pdf", bill_id: "bill-pdf", file_url: "org/job/QOT1013147.pdf" },
  // Same Purchase: Tie Them writes tied_bill_id, not bill_id.
  { id: "t4", kind: "receipt", document_id: "inv-ced", bill_id: null, tied_bill_id: "bill-inv", file_url: "org/job/inv-ced.jpg" },
  // Organize read an unfiled picture as paper and filed it with no bill.
  { id: "t5", kind: "receipt", document_id: "raw-read", bill_id: null, file_url: "org/job/raw-read.jpg" },
];
const ids = (ds: { id: string }[] | null) => (ds ?? []).map((d) => d.id);

describe("the Photos grid holds the job's photos, never its receipts", () => {
  const s = sortJobPapers(DOCS, TIES, BILLS);

  it("keeps what was filed as a Photo, and an unfiled picture no paper reader touched", () => {
    expect(ids(s.photos)).toEqual(["photo-panel", "photo-trench", "raw-pic"]);
  });

  it("never a Receipt, a Bill or an Invoice, tied to a bill or not", () => {
    for (const id of ["rcpt-ced", "rcpt-hd", "rcpt-loose", "inv-ced"]) expect(ids(s.photos)).not.toContain(id);
    expect(ids(s.pictures)).not.toContain("rcpt-loose");
  });

  it("an unfiled picture a paper reader handled is paperwork, not a photo", () => {
    expect(ids(s.photos)).not.toContain("raw-read");
    expect(ids(s.pictures)).not.toContain("raw-read");
  });

  it("a plan picture folds under the grid instead of leaving the tab", () => {
    expect(ids(s.pictures)).toEqual(["plan-pic"]);
    expect(s.photoTabIds).toEqual(new Set(["photo-panel", "photo-trench", "raw-pic", "plan-pic"]));
  });

  it("counts the pictures that went to the Costs tab, so the Photos tab can say where", () => {
    // rcpt-ced, rcpt-hd, rcpt-loose, inv-ced, raw-read (the PDF is not a picture)
    expect(s.moneyPictures).toBe(5);
  });

  it("a Photo tied to a bill is still a photo (a person said so), and still opens from its bill", () => {
    const t = sortJobPapers([doc("p", "Photo")], [{ document_id: "p", bill_id: "bill-ced", file_url: "org/job/p.jpg" }], BILLS);
    expect(ids(t.photos)).toEqual(["p"]);
    expect(ids(t.byBill["bill-ced"])).toEqual(["p"]);
  });

  it("a plan tied to money goes with the money", () => {
    const t = sortJobPapers([doc("pl", "Plan")], [{ document_id: "pl", bill_id: null, petty_cash_id: "pc1", file_url: "org/job/pl.jpg" }], BILLS);
    expect(ids(t.pictures)).toEqual([]);
    expect(t.moneyPictures).toBe(1);
  });

  it("a category nobody allowed yet is not guessed into the grid", () => {
    const t = sortJobPapers([doc("x", "Estimate")], [], BILLS);
    expect(ids(t.photos)).toEqual([]);
    expect(ids(t.pictures)).toEqual([]);
  });
});

describe("each bill's own paper", () => {
  const s = sortJobPapers(DOCS, TIES, BILLS);

  it("the reader's link and Tie Them's link both put the paper on its bill, pictures and PDFs alike", () => {
    expect(ids(s.byBill["bill-ced"])).toEqual(["rcpt-ced"]);
    expect(ids(s.byBill["bill-hd"])).toEqual(["rcpt-hd"]);
    expect(ids(s.byBill["bill-pdf"])).toEqual(["rcpt-pdf"]);
    expect(ids(s.byBill["bill-inv"])).toEqual(["inv-ced"]);
  });

  it("a receipt, bill or invoice on the books through nothing is loose; one on a bill anywhere is not", () => {
    expect(ids(s.loose)).toEqual(["rcpt-loose"]);
    // Tied to a bill on ANOTHER job (moved there): not on this job's bill list, and not loose either.
    const moved = sortJobPapers([doc("r", "Receipt")], [{ document_id: "r", bill_id: "bill-elsewhere", file_url: "org/job/r.jpg" }], BILLS);
    expect(moved.byBill).toEqual({});
    expect(ids(moved.loose)).toEqual([]);
    // Petty cash or a supplier's document holds it: on the books, not loose.
    const petty = sortJobPapers([doc("r", "Receipt")], [{ document_id: "r", bill_id: null, petty_cash_id: "pc", file_url: null }], BILLS);
    expect(ids(petty.loose)).toEqual([]);
  });

  it("a lost links read claims nothing: no paper is loose, a Receipt is still never a photo", () => {
    const lost = sortJobPapers(DOCS, null, BILLS);
    expect(lost.loose).toBeNull();
    expect(lost.byBill).toEqual({});
    expect(ids(lost.photos)).toEqual(["photo-panel", "photo-trench", "raw-pic", "raw-read"]);
  });

  it("builds one door per file: its picture, a PDF as a PDF, the word from its category", () => {
    const urls = new Map<string, string>();
    const papers = billPapers(s.byBill, [], urls);
    expect(papers["bill-ced"]).toEqual([
      { id: "rcpt-ced", name: "rcpt-ced.jpg", url: "https://x.test/org/job/rcpt-ced.jpg?token=t", kind: "image", label: "Receipt" },
    ]);
    expect(papers["bill-pdf"][0]).toMatchObject({ kind: "pdf", label: "Receipt" });
    expect(papers["bill-inv"][0]).toMatchObject({ kind: "image", label: "Invoice" });
    expect(papers["bill-none"]).toBeUndefined();
  });

  it("a bill moved here keeps its receipt on the old job: its link's own file is signed and opens", () => {
    const ties: PaperTie[] = [{ id: "t9", kind: "receipt", document_id: "old-doc", bill_id: "bill-moved", file_url: "org/old-job/r.jpg" }];
    const off = papersOffThisJob(ties, DOCS, [...BILLS, "bill-moved"]);
    expect(off.map((t) => t.id)).toEqual(["t9"]);
    const papers = billPapers({}, off, new Map([["org/old-job/r.jpg", "https://x.test/r"]]), () => "OSH");
    expect(papers["bill-moved"]).toEqual([{ id: "t9", name: "OSH", url: "https://x.test/r", kind: "image", label: "Receipt" }]);
    // A paper that IS on this job is never signed twice.
    expect(papersOffThisJob(TIES, DOCS, BILLS)).toEqual([]);
  });

  it("the same file linked twice to one bill is one door", () => {
    const ties: PaperTie[] = [
      { id: "a", document_id: null, bill_id: "b1", file_url: "org/organize/x.jpg" },
      { id: "b", document_id: null, bill_id: "b1", file_url: "org/organize/x.jpg" },
    ];
    expect(billPapers({}, ties, new Map())["b1"]).toHaveLength(1);
  });
});

describe("a tech's Photos tab shows what it showed before", () => {
  it("his papers are the allow-list and he is handed no links: every picture he saw stays on the tab", () => {
    const tech = documentsForViewer(DOCS, false);
    const before = tech.filter((d) => /\.(jpe?g|png|webp|gif|heic)($|\?)/i.test(d.signedUrl ?? d.name ?? ""));
    const s = sortJobPapers(tech, [], []);
    expect([...ids(s.photos), ...ids(s.pictures)].sort()).toEqual(ids(before).sort());
    // And no receipt was ever his to see.
    expect(ids(tech).some((id) => id.startsWith("rcpt") || id.startsWith("inv"))).toBe(false);
    expect(s.moneyPictures).toBe(0);
  });
});

describe("what counts as a picture", () => {
  it("reads the signed URL, then the stored path, then the name", () => {
    expect(isImageDoc({ name: "Home Depot — $47.44", file_url: "o/j/1.jpg", signedUrl: null })).toBe(true);
    expect(isImageDoc({ name: "x", file_url: "o/j/1.pdf", signedUrl: "https://x/o/j/1.pdf?token=a" })).toBe(false);
    expect(isImageDoc({ name: "IMG_1.HEIC", file_url: null, signedUrl: null })).toBe(true);
  });
});
