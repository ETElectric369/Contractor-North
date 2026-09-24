import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ROW ON SCREEN (0295). Nothing on it files by itself; every paper says what was read; a kind
 * this update cannot file says so instead of offering a door; a number already on the books offers
 * Tie Them and swaps File It for Different Purchase: File It Anyway.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/app/(app)/organize/actions", () => ({
  aiReviewItem: vi.fn(),
  archiveItem: vi.fn(),
  deleteOrganizedItem: vi.fn(),
  fileItem: vi.fn(),
  readPaperworkItem: vi.fn(),
  tiePaperwork: vi.fn(),
  undoPaperwork: vi.fn(),
}));
vi.mock("@/app/(app)/organize/paperwork-actions", () => ({
  addSupplierDocuments: vi.fn(),
  keepPaperwork: vi.fn(),
  updatePaperwork: vi.fn(),
}));

import { PaperworkRow, type PaperRowItem } from "./paperwork-row";

const JOBS = [{ id: "job-046", job_number: "J-046", name: "Jason Waldow" }];
const base: PaperRowItem = {
  id: "p1",
  kind: "receipt",
  status: "needs_review",
  doc_type: "receipt",
  vendor: "Home Depot",
  amount: 84.12,
  payment: "paid_at_purchase",
  title: "IMG_0412.jpg",
  created_at: "2026-09-24T12:00:00Z",
  signedUrl: null,
};
const render = (item: Partial<PaperRowItem>, matches: any[] = []) =>
  renderToStaticMarkup(createElement(PaperworkRow, { item: { ...base, ...item }, jobs: JOBS, matches, onFiled: () => {} }));

describe("PaperworkRow", () => {
  it("a read receipt: one line, Ready To File, a picker with nothing picked, and File It shut until a place is picked", () => {
    const html = render({});
    expect(html).toContain("Receipt, Home Depot, $84.12, paid at the counter");
    expect(html).toContain("Ready To File");
    expect(html).toContain("Where Does It Go?");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Pick where it goes first/);
    // The six buckets are offered for a cost.
    for (const b of ["Gas &amp; Truck", "Tools &amp; Supplies", "Phone &amp; Office", "Insurance &amp; Licenses", "Fees", "Other"]) expect(html).toContain(b);
  });

  it("the reader's job is PICKED and marked Suggested, and the row says nothing is filed until File It", () => {
    const html = render({ proposal: { jobId: "job-046", jobHint: "518 CRATER LAKE" } });
    expect(html).toMatch(/<option value="job:job-046" selected="">Jason Waldow \(Suggested\)<\/option>/);
    expect(html).toContain("nothing is filed until you press File It");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>.*?File It<\/button>/);
  });

  it("a statement is named honestly, with no File It at all", () => {
    const html = render({ doc_type: "statement", kind: "job_document" });
    expect(html).toContain("Not filed: this kind of paper goes in a later update.");
    expect(html).not.toContain(">File It<");
    expect(html).not.toContain("File It</button>");
    expect(html).toContain("Keep It In Files");
  });

  it("unread paper offers Read Now, not File It", () => {
    const html = render({ doc_type: null, kind: "job_document", vendor: null, amount: null, payment: null });
    expect(html).toContain("Not Read Yet");
    expect(html).toContain("Read Now");
    expect(html).not.toContain("File It</button>");
  });

  it("a number already on the books: Tie Them, and File It becomes Different Purchase: File It Anyway", () => {
    const html = render({ doc_number: "8802-1108330" }, [
      { kind: "bill", billId: "bill-1", sentence: "Already on the books: CED #8802-1108330, $653.25, on J-046 Jason Waldow." },
    ]);
    expect(html).toContain("Already on the books: CED #8802-1108330");
    expect(html).toContain("Same Purchase: Tie Them");
    expect(html).toContain("Different Purchase: File It Anyway");
  });

  it("CED documents found in a PDF go on the CED list", () => {
    const html = render({
      doc_type: "supplier_documents",
      kind: "job_document",
      proposal: { ced: { numbers: ["8802-1101363"], total: 162.45, kinds: ["invoice"], text: "x", name: "a.pdf" } },
    });
    expect(html).toContain("Add To CED Documents");
    expect(html).toContain("CED document, 8802-1101363, $162.45");
  });

  it("every control is a 44px target", () => {
    const html = render({});
    for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toMatch(/h-11/);
    expect(html).toMatch(/<select[^>]*class="[^"]*h-11/);
  });
});
