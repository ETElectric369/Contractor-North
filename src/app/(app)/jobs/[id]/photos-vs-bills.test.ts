import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * JOB PHOTOS AND BILLS, KEPT SEPARATE (Erik, 2026-09-27: "photos should have a distinction between
 * bills and job photos and maybe even keep them separate").
 *
 * The Photos tab shows the job's photos; each receipt opens from its bill, on the Costs tab and on
 * the bill's row in /bills; a receipt no bill holds is listed in the Costs tab's Receipts & Papers
 * and says so; and a tech's Photos tab shows what it showed before.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/jobs/j1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/app/(app)/jobs/actions", () => ({
  createBill: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  updateDocument: vi.fn(),
  setBillStatus: vi.fn(),
  deleteBill: vi.fn(),
  linkReceiptToBill: vi.fn(),
}));
vi.mock("@/app/(app)/organize/actions", () => ({ billJobReceipt: vi.fn() }));
vi.mock("@/components/snap-or-note", () => ({ openSnapOrNote: vi.fn() }));
vi.mock("@/app/(app)/jobs/portal-share-actions", () => ({ reshowPhoto: vi.fn(), setPhotoShared: vi.fn() }));
vi.mock("./upload-job-photos", () => ({ uploadJobPhotos: vi.fn() }));
vi.mock("@/lib/receipt-capture", () => ({ captureReceipt: vi.fn(), prettyBytes: () => "1 KB", readReceiptDocument: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("@/app/(app)/purchasing/new-po-button", () => ({ NewPoButton: () => null }));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn() }));
vi.mock("@/app/(app)/bills/receipt-billing-card", () => ({ ReceiptLines: () => null }));

import { JobPhotos } from "./job-photos";
import { JobBills } from "./job-bills";
import { JobDocuments } from "./job-documents";
import { JobCostCapture, capturePaper, notACostSentence, NOT_A_COST_PAPERS } from "./job-cost-capture";
import { captureReceipt, readReceiptDocument } from "@/lib/receipt-capture";
import { BillsReceipts } from "../../bills/bills-receipts";
import { billPapers, sortJobPapers, type PaperTie } from "@/lib/job-photos";
import { documentsForViewer } from "@/lib/tech-documents";

// React hoists a <link rel="preload"> per image to the top of the markup: not part of any screen.
const r = (c: any, p: any) => renderToStaticMarkup(createElement(c, p)).replace(/<link [^>]*\/>/g, "");
/** An <a> carrying both: its href and its 44px class, whatever order they render in. */
const link = (href: string, words: string) =>
  new RegExp(`<a(?=[^>]*href="${href.replace(/[?/]/g, "\\$&")}")(?=[^>]*min-h-11)[^>]*>${words}</a>`);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
/** Every <button>, its attributes and the words on it. */
const buttons = (html: string) =>
  Array.from(html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)).map((m) => ({ attrs: m[1], words: text(m[2]).trim() }));

const doc = (id: string, category: string | null, ext = "jpg") => ({
  id,
  name: `${id}.${ext}`,
  category,
  file_url: `org1/j1/${id}.${ext}`,
  size_bytes: 1000,
  created_at: "2026-09-20T17:00:00Z",
  uploaded_by: "u1",
  signedUrl: `https://x.test/org1/j1/${id}.${ext}?token=t`,
});
const DOCS = [doc("panel", "Photo"), doc("ced-ticket", "Receipt"), doc("loose-receipt", "Receipt"), doc("plan-pic", "Plan"), doc("phone-pic", null)];
const BILLS = [
  { id: "b-ced", supplier: "CED", bill_number: "8802-1106969", amount: 301.81, status: "unpaid", bill_date: "2026-09-04" },
  { id: "b-typed", supplier: "OSH", bill_number: null, amount: 16.28, status: "paid", bill_date: "2026-09-18" },
];
const TIES: PaperTie[] = [{ id: "t1", kind: "receipt", document_id: "ced-ticket", bill_id: "b-ced", file_url: "org1/j1/ced-ticket.jpg" }];
const sorted = sortJobPapers(DOCS, TIES, BILLS.map((b) => b.id));
const papers = billPapers(sorted.byBill, [], new Map());

describe("the Photos tab: the job's photos, not its receipts", () => {
  const office = r(JobPhotos, { orgId: "org1", jobId: "j1", docs: sorted.photos, pictures: sorted.pictures, costsNote: sorted.moneyPictures > 0, viewerId: "u1", viewerIsStaff: true, sharedIds: [] });

  it("the grid holds the photos and the unfiled phone picture; no receipt is on the tab", () => {
    expect(office).toContain("org1/j1/panel.jpg");
    expect(office).toContain("org1/j1/phone-pic.jpg");
    expect(office).not.toContain("ced-ticket");
    expect(office).not.toContain("loose-receipt");
  });

  it("a plan picture folds under the grid, and a plan gets no Show Customer (only a Photo does)", () => {
    const fold = office.slice(office.indexOf("Plans &amp; Other Papers"));
    expect(fold).toContain("org1/j1/plan-pic.jpg");
    expect(fold).not.toContain("Show Customer");
    expect(office.slice(0, office.indexOf("Plans &amp; Other Papers"))).toContain("Show Customer");
  });

  it("says where the receipts went, with a 44px door to the Costs tab", () => {
    expect(text(office)).toContain("Receipts and bills are kept with their bills on the Costs tab.");
    expect(office).toMatch(link("/jobs/j1?tab=costs", "Open Costs"));
  });

  it("a tech sees what he saw before, and is never pointed at the office's Costs tab", () => {
    const mine = documentsForViewer(DOCS, false);
    const techSort = sortJobPapers(mine, [], []);
    const tech = r(JobPhotos, { orgId: "org1", jobId: "j1", docs: techSort.photos, pictures: techSort.pictures, costsNote: false, viewerId: "u2", viewerIsStaff: false });
    // Before: every allow-listed picture, in one grid. Now: the same pictures, the plan in its fold.
    for (const d of mine) expect(tech).toContain(`org1/j1/${d.id}.jpg`);
    expect(tech).not.toContain("ced-ticket");
    expect(tech).not.toContain("tab=costs");
    expect(tech).not.toContain("Show Customer");
  });
});

describe("the Costs tab: a bill opens its own receipt", () => {
  const html = r(JobBills, { jobId: "j1", bills: BILLS, pos: [], papers });
  const rows = html.split(/<li[ >]/).slice(1);
  const ced = rows.find((x) => x.includes("CED"))!;
  const typed = rows.find((x) => x.includes("OSH"))!;

  it("the CED bill's row has a 44px Receipt door wearing the picture itself", () => {
    const door = ced.match(/<button[^>]*aria-label="Open the receipt: ced-ticket.jpg"[^>]*>([\s\S]*?)<\/button>/);
    expect(door).not.toBeNull();
    expect(door![0]).toMatch(/\bh-11\b/);
    expect(door![1]).toContain('src="https://x.test/org1/j1/ced-ticket.jpg?token=t"');
    expect(text(door![1]).trim()).toBe("Receipt");
  });

  it("a bill typed in with no paper draws no door", () => {
    expect(typed).not.toContain("Open the");
  });

  it("a paper whose link couldn't be made says so instead of a dead tap", () => {
    const html2 = r(JobBills, { jobId: "j1", bills: BILLS, pos: [], papers: { "b-ced": [{ ...papers["b-ced"][0], url: null }] } });
    expect(text(html2)).toContain("The receipt couldn't load just now. Reload to try again.");
    expect(html2).not.toContain("Open the receipt");
  });
});

describe("the Costs tab: Receipts & Papers", () => {
  const props = {
    orgId: "org1",
    jobId: "j1",
    docs: DOCS,
    photoTabIds: Array.from(sorted.photoTabIds),
    billOf: { "ced-ticket": "the CED bill #8802-1106969" },
    looseIds: (sorted.loose ?? []).map((d) => d.id),
  };
  const html = r(JobDocuments, props);
  const rows = html.split(/<li[ >]/).slice(1);
  const row = (id: string) => rows.find((x) => x.includes(`${id}.jpg`))!;

  it("a receipt on no bill is counted on the fold's line, holds the fold open, and says so on its row", () => {
    expect(html).toMatch(/^<details[^>]*open=""/);
    expect(text(html)).toContain("Receipts & Papers · 1 Not On A Bill Yet");
    expect(text(row("loose-receipt"))).toContain("Not on a bill yet.");
    expect(text(row("loose-receipt"))).toContain("Record As Cost");
  });

  it("a receipt that made a bill says which, and offers no second Record As Cost", () => {
    expect(text(row("ced-ticket"))).toContain("On the CED bill #8802-1106969.");
    expect(text(row("ced-ticket"))).not.toContain("Record As Cost");
    expect(text(row("ced-ticket"))).not.toContain("Not on a bill yet");
  });

  it("what the Photos tab holds is folded last, still here for the pencil, with the door to Photos", () => {
    const at = html.indexOf("Photos And Plans On The Photos Tab");
    expect(at).toBeGreaterThan(html.indexOf("loose-receipt.jpg"));
    const tail = html.slice(at);
    for (const id of ["panel", "plan-pic", "phone-pic"]) expect(tail).toContain(`${id}.jpg`);
    expect(tail).not.toContain("ced-ticket.jpg");
    expect(tail).toMatch(link("/jobs/j1?tab=photos", "Open Photos"));
    expect(html.slice(0, at)).not.toContain("panel.jpg");
  });

  it("an Invoice on no bill carries no flag it has no button for, and doesn't hold the fold open", () => {
    const inv = { ...doc("supplier-inv", "Invoice", "pdf") };
    const s2 = sortJobPapers([inv], [], BILLS.map((b) => b.id));
    const html2 = r(JobDocuments, { orgId: "org1", jobId: "j1", docs: [inv], photoTabIds: [], billOf: {}, looseIds: (s2.loose ?? []).map((d) => d.id) });
    expect(html2).not.toMatch(/^<details[^>]*open=""/);
    expect(text(html2)).not.toContain("Not On A Bill");
    expect(text(html2)).not.toContain("Not on a bill yet");
    expect(text(html2)).toContain("supplier-inv.pdf");
  });

  it("nothing on no bill: the fold starts closed and its line counts nothing", () => {
    const closed = r(JobDocuments, { ...props, looseIds: [] });
    expect(closed).not.toMatch(/^<details[^>]*open=""/);
    expect(text(closed)).not.toContain("Not On A Bill");
  });

  it("the links couldn't be read: no paper is called loose, Record As Cost stays on every receipt, and it says so", () => {
    const lost = r(JobDocuments, { ...props, billOf: {}, looseIds: null, tieNote: "Couldn't check which papers made which bill just now. Reload to try again." });
    // The bills draw no Receipt door then, so the sentence saying why is never folded out of sight.
    expect(lost).toMatch(/^<details[^>]*open=""/);
    expect(text(lost)).not.toContain("Not On A Bill");
    expect(text(lost)).toContain("Couldn't check which papers made which bill just now.");
    const lostRows = lost.split(/<li[ >]/).slice(1);
    for (const id of ["ced-ticket", "loose-receipt"]) expect(text(lostRows.find((x) => x.includes(`${id}.jpg`))!)).toContain("Record As Cost");
  });
});

/**
 * ONE WAY TO ADD A COST (W1-23). The Costs tab's header is one primary Snap The Bill and a 44px ⋯,
 * More Ways To Add A Cost: Upload (many at once, its own input) and Type It In (the one typed
 * sheet). Receipts & Papers is the job's filed list, with no uploader of its own.
 */
describe("the Costs tab: one way to add a cost", () => {
  const html = r(JobCostCapture, { orgId: "org1", jobId: "j1", billsTotal: 318.09, nortOn: true });

  it("Snap The Bill is the one primary door, and the job's total is no longer its header", () => {
    const snap = buttons(html).filter((b) => b.words === "Snap The Bill");
    expect(snap).toHaveLength(1);
    expect(snap[0].attrs).toMatch(/\bh-11\b/);
    expect(text(html)).not.toContain("Costs ·");
    expect(text(html)).not.toContain("$318.09");
  });

  it("the camera input takes one shot (never multiple: the iOS rule); Upload's own input takes many", () => {
    const inputs = Array.from(html.matchAll(/<input[^>]*type="file"[^>]*>/g)).map((m) => m[0]);
    const camera = inputs.filter((i) => i.includes('capture="environment"'));
    expect(camera).toHaveLength(1);
    expect(camera[0]).not.toContain("multiple");
    const library = inputs.filter((i) => !i.includes("capture="));
    expect(library).toHaveLength(1);
    expect(library[0]).toContain("multiple");
    expect(library[0]).toContain("application/pdf");
  });

  it("the ⋯ is a 44px button named More Ways To Add A Cost, holding Upload and Type It In", () => {
    const more = buttons(html).find((b) => /aria-label="More Ways To Add A Cost"/.test(b.attrs))!;
    expect(more).toBeDefined();
    expect(more.attrs).toMatch(/\bh-11 w-11\b/);
    const rows = buttons(html).map((b) => b.words);
    expect(rows).toContain("Upload");
    expect(rows).toContain("Type It In");
    expect(rows).toContain("File A Paper (Not A Cost)");
    // Its rows stay mounted while it is shut (hidden), so the sheet Type It In opens never unmounts.
    expect(html).toMatch(/<div hidden=""[^>]*>[\s\S]*Upload[\s\S]*Type It In/);
    // No other add door on the header: no Add Cost, no Add Bill.
    expect(rows).not.toContain("Add Cost");
    expect(rows).not.toContain("Add Bill");
  });

  it("a paper that isn't money, dropped through Upload, is filed and says so (the pipeline's filed outcome)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-cost-capture.tsx"), "utf8");
    // Every outcome but "lost" filed the paper and its line is said as the pipeline (or the
    // not-a-cost door) wrote it.
    expect(src).toContain('if (out.kind !== "lost") touched = true;');
    expect(src).toContain("say(p.id, p.name, sentence, out.tone,");
    // The not-a-cost pick rides the library input only: the camera is always a cost.
    expect(src).toContain("const as = e.target === fileRef.current ? pickAs.current : null;");
    // The camera hint names the other two doors.
    expect(src).toContain("Tap ⋯ for Upload (your photos and PDFs) or Type It In");
  });

  it("a plan, permit or other paper is filed as that and never reaches the receipt reader", async () => {
    const capture = vi.mocked(captureReceipt);
    const read = vi.mocked(readReceiptDocument);
    const file = new File(["%PDF"], "panel-plan.pdf", { type: "application/pdf" });
    expect(NOT_A_COST_PAPERS.map((k) => k.label)).toEqual(["Plan", "Permit", "Other Paper"]);
    for (const { category } of NOT_A_COST_PAPERS) {
      capture.mockReset();
      read.mockReset();
      capture.mockResolvedValueOnce({ kind: "filed", docId: "d1", tone: "ok", why: "not_asked", sentence: "Filed on the job." });
      const { out, sentence } = await capturePaper({ orgId: "org1", jobId: "j1", file, category, nortOn: true });
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ category, read: false }));
      expect(read).not.toHaveBeenCalled();
      expect(out.kind).toBe("filed");
      expect(sentence).toBe(notACostSentence(category));
      expect(sentence).toContain("It isn't a cost, so it wasn't read.");
      // Nort names the same door.
      expect((await import("@/lib/nort-product-map")).NORT_PRODUCT_MAP).toContain("File A Paper (Not A Cost), which files a plan, permit or other paper on the job");
      expect(sentence).not.toMatch(/cost manually|Record As Cost/);
    }
    expect(notACostSentence("Plan")).toBe("Filed on the job as a Plan. It isn't a cost, so it wasn't read.");
    // Upload and Snap The Bill stay costs: filed as a Receipt (no category) and read.
    capture.mockReset();
    capture.mockResolvedValueOnce({ kind: "billed", docId: "d2", tone: "ok", sentence: "Bill created.", vendor: null, amount: 1, lineCount: 1, warning: null });
    await capturePaper({ orgId: "org1", jobId: "j1", file, nortOn: true });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ category: undefined, read: true }));
  });

  it("Receipts & Papers has no uploader: no category picker, no Upload File, no Take Photo", () => {
    const docs = r(JobDocuments, { orgId: "org1", jobId: "j1", docs: DOCS, photoTabIds: Array.from(sorted.photoTabIds), looseIds: [] });
    const words = buttons(docs).map((b) => b.words);
    for (const gone of ["Upload File", "Take Photo"]) expect(words).not.toContain(gone);
    expect(docs).not.toMatch(/<select/);
    expect(docs).not.toContain('type="file"');
  });

  it("empty, it points at Snap The Bill; with the portal off it adds where a plan goes", () => {
    const office = r(JobDocuments, { orgId: "org1", jobId: "j1", docs: [], plansDoor: true, looseIds: [] });
    expect(text(office)).toContain("No receipts yet. Use Snap The Bill above.");
    expect(text(office)).not.toContain("File A Paper (Not A Cost)");
    // The plans door keeps its gate (office, Customer Portal on), a 44px link.
    const plans = office.match(/<a[^>]*href="\/jobs\/j1\?tab=customer&amp;plans=add"[^>]*>([\s\S]*?)<\/a>/);
    expect(plans).not.toBeNull();
    expect(plans![0]).toContain("min-h-11");
    expect(text(plans![1]).trim()).toBe("Plan Or Drawing? Add It On The Customer Page");
    const portalOff = r(JobDocuments, { orgId: "org1", jobId: "j1", docs: [], plansDoor: false, looseIds: [] });
    // Never through Upload: that files a plan as a Receipt and reads it (review of W1-23).
    expect(text(portalOff)).toContain("No receipts yet. Use Snap The Bill above. A plan, permit or other paper? Tap ⋯ and File A Paper (Not A Cost).");
    expect(text(portalOff)).not.toContain("Use Upload");
    expect(portalOff).not.toContain("Add It On The Customer Page");
  });
});

describe("/bills, All Bills: the bill's row opens its receipt too", () => {
  it("the same door, beside the bill's own doors", () => {
    const html = r(BillsReceipts, {
      orgId: "org1",
      jobs: [],
      lists: [],
      pos: [],
      docs: [],
      bills: BILLS.map((b) => ({ ...b, job_id: "j1", category: "Receipt", papers: papers[b.id] ?? null })),
    });
    const rows = html.split('<details id="bill-').slice(1);
    const ced = rows.find((x) => x.startsWith("b-ced"))!;
    expect(ced).toMatch(/<button[^>]*\bh-11\b[^>]*aria-label="Open the receipt: ced-ticket.jpg"/);
    expect(rows.find((x) => x.startsWith("b-typed"))).not.toContain("Open the receipt");
  });

  it("a folded row downloads nothing: the face is lazy, and React hoists no preload for it", () => {
    const raw = renderToStaticMarkup(
      createElement(BillsReceipts, {
        orgId: "org1",
        jobs: [],
        lists: [],
        pos: [],
        docs: [],
        bills: BILLS.map((b) => ({ ...b, job_id: "j1", category: "Receipt", papers: papers[b.id] ?? null })),
      }),
    );
    expect(raw).not.toMatch(/<link[^>]*rel="preload"[^>]*ced-ticket/);
    const face = raw.match(/<img[^>]*ced-ticket\.jpg[^>]*>/);
    expect(face).not.toBeNull();
    expect(face![0]).toContain('loading="lazy"');
  });
});
