import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
}));
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
import { BillsReceipts } from "../../bills/bills-receipts";
import { billPapers, sortJobPapers, type PaperTie } from "@/lib/job-photos";
import { documentsForViewer } from "@/lib/tech-documents";

// React hoists a <link rel="preload"> per image to the top of the markup: not part of any screen.
const r = (c: any, p: any) => renderToStaticMarkup(createElement(c, p)).replace(/<link [^>]*\/>/g, "");
/** An <a> carrying both: its href and its 44px class, whatever order they render in. */
const link = (href: string, words: string) =>
  new RegExp(`<a(?=[^>]*href="${href.replace(/[?/]/g, "\\$&")}")(?=[^>]*min-h-11)[^>]*>${words}</a>`);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

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

  it("nothing on no bill: the fold starts closed and its line counts nothing", () => {
    const closed = r(JobDocuments, { ...props, looseIds: [] });
    expect(closed).not.toMatch(/^<details[^>]*open=""/);
    expect(text(closed)).not.toContain("Not On A Bill");
  });

  it("the links couldn't be read: no paper is called loose, Record As Cost stays on every receipt, and it says so", () => {
    const lost = r(JobDocuments, { ...props, billOf: {}, looseIds: null, tieNote: "Couldn't check which papers made which bill just now. Reload to try again." });
    expect(text(lost)).not.toContain("Not On A Bill");
    expect(text(lost)).toContain("Couldn't check which papers made which bill just now.");
    const lostRows = lost.split(/<li[ >]/).slice(1);
    for (const id of ["ced-ticket", "loose-receipt"]) expect(text(lostRows.find((x) => x.includes(`${id}.jpg`))!)).toContain("Record As Cost");
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
