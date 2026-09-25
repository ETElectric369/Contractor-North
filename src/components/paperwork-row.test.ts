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
  readAsCost: vi.fn(),
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
  it("a read receipt with NO job markings: nothing picked, it asks where it goes, a job and the buckets side by side, File It shut", () => {
    const html = render({});
    expect(html).toContain("Receipt, Home Depot, $84.12, paid at the counter");
    expect(html).toContain("Ready To File");
    expect(html).toMatch(/>Where does this go\?<\/p>/);
    // Both choices, side by side, neither picked.
    expect(html).toMatch(/<select[^>]*aria-label="A Job"/);
    expect(html).toMatch(/<select[^>]*aria-label="Or A Business Cost"/);
    expect(html).toContain("A Job…");
    expect(html).toContain("Or A Business Cost…");
    expect(html).not.toMatch(/<option value="[^"]+" selected=""/);
    expect(html).not.toContain("Job picked from");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Pick where it goes first/);
    // The six buckets are offered for a cost.
    for (const b of ["Gas &amp; Truck", "Tools &amp; Supplies", "Phone &amp; Office", "Insurance &amp; Licenses", "Fees", "Other"]) expect(html).toContain(b);
  });

  it("a bill whose PAPER names the job comes in with it picked, and says why in a few words; File It is open", () => {
    const html = render({ proposal: { jobId: "job-046", jobFrom: "address", jobHint: "518 CRATER LAKE RD" } });
    expect(html).toMatch(/<option value="job-046" selected="">Jason Waldow \(On The Paper\)<\/option>/);
    expect(html).toContain("Job picked from the address on the receipt");
    expect(html).toContain("nothing is filed until you press the button");
    expect(html).not.toMatch(/>Where does this go\?<\/p>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>.*?File It<\/button>/);
  });

  it("a MODEL'S GUESS at the job never pre-selects: it is a chip labelled a guess, and the row still asks", () => {
    for (const proposal of [{ guessJobId: "job-046", why: "The store is near the job." }, { jobId: "job-046", jobHint: "518 CRATER LAKE" }]) {
      const html = render({ proposal });
      expect(html).not.toMatch(/<option value="[^"]+" selected=""/);
      expect(html).toMatch(/>Where does this go\?<\/p>/);
      expect(html).toMatch(/A Guess: (<!-- -->)?Jason Waldow/);
      expect(html).toContain("(Tap To Pick)");
      expect(html).toContain("Not read off the paper");
      expect(html).not.toContain("Job picked from");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Pick where it goes first/);
    }
  });

  it("a paper that names two jobs says so and picks neither", () => {
    const html = render({
      proposal: { jobId: "job-046", jobFrom: "address", jobConflict: "The paper points to more than one job (the address and the PO number), so no job was picked." },
    });
    expect(html).toContain("The paper points to more than one job");
    expect(html).not.toMatch(/<option value="[^"]+" selected=""/);
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

  it("a CED document no bill covers: no Tie, and the button says it links the two", () => {
    const html = render({ doc_type: "bill", vendor: "CED", doc_number: "8802-1108330", proposal: { jobId: "job-046" } }, [
      {
        kind: "supplier_invoice",
        supplierInvoiceId: "si-1",
        invoiceNumber: "8802-1108330",
        sentence: "On the CED documents list with no bill yet: 8802-1108330, $653.25. File It makes the bill and links it to that document.",
      },
    ]);
    expect(html).not.toContain("Same Purchase: Tie Them");
    expect(html).not.toContain("Different Purchase");
    expect(html).toContain("File It And Link To CED 8802-1108330");
    expect(html).toContain("On the CED documents list with no bill yet");
  });

  it("a bucket a model liked is a guess too: offered, never picked", () => {
    const html = render({ proposal: { bucket: "Gas & Truck" } });
    expect(html).not.toMatch(/<option value="[^"]+" selected=""/);
    expect(html).toMatch(/A Guess: (<!-- -->)?Business Cost, Gas &amp; Truck/);
    expect(html).toMatch(/>Where does this go\?<\/p>/);
  });

  it("a plain PICTURE asks What is this? first: Job Photo, Bill Or Receipt, Something Else, and no cost controls", () => {
    const html = render({
      kind: "job_document",
      doc_type: "not_a_cost",
      category: "Photo",
      vendor: null,
      amount: null,
      payment: null,
      title: "Panel, 200A main",
      proposal: { picture: true },
    });
    expect(html).toContain("Picture, Panel, 200A main");
    expect(html).toContain("What is this?");
    expect(html).toContain("Job Photo");
    expect(html).toContain("Bill Or Receipt");
    expect(html).toContain("Something Else");
    expect(html).not.toContain("File It");
    expect(html).not.toContain("Or A Business Cost");
    expect(html).not.toContain("Keep It In Files");
  });

  it("a CED document in the same PDF that didn't add up is said on the row", () => {
    const html = render({
      doc_type: "supplier_documents",
      kind: "job_document",
      proposal: {
        ced: {
          numbers: ["8802-1101363"],
          total: 162.45,
          kinds: ["invoice"],
          text: "x",
          name: "a.pdf",
          refused: [{ number: "8802-1101999", error: "8802-1101999: the lines don't add up to TOTAL DUE" }],
        },
      },
    });
    expect(html).toContain("Won&#x27;t be added: 8802-1101999: the lines don&#x27;t add up to TOTAL DUE.");
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

  // ── Paper A (audit v994): PO "TOOLS", the reader's bucket, read before marks were kept ──────
  const TOOLS_TICKET: Partial<PaperRowItem> = {
    doc_type: "bill",
    vendor: "Consolidated Electrical Dist.",
    amount: 44.44,
    payment: "on_account",
    doc_number: "8802-SO-257558",
    proposal: { po: "TOOLS", bucket: "Tools & Supplies", jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR TOOLS" },
  };

  it("PO TOOLS the tray has matched: Tools & Supplies is picked, and says it came off the PO", () => {
    const html = render({
      ...TOOLS_TICKET,
      proposal: { ...(TOOLS_TICKET.proposal as object), companyUse: { bucket: "Tools & Supplies", from: "po", words: "TOOLS" } },
      on_paper: "PO TOOLS",
    });
    expect(html).toMatch(/<option value="cost:Tools &amp; Supplies" selected="">Tools &amp; Supplies(<!-- -->)? \(On The Paper\)<\/option>/);
    expect(html).toContain("Business cost picked from the PO on the bill: TOOLS");
    // The picked line already says the words; nothing repeats them.
    expect(html).not.toContain("On the paper:");
    expect(html).not.toMatch(/>Where does this go\?<\/p>/);
  });

  it("a reader's bucket is 'The reader's guess', never 'Not read off the paper', and the PO is shown", () => {
    const html = render({ ...TOOLS_TICKET, on_paper: "PO TOOLS" });
    expect(html).toMatch(/>Where does this go\?<\/p>/);
    expect(html).toContain("On the paper: PO TOOLS");
    expect(html).toMatch(/A Guess: (<!-- -->)?Business Cost, Tools &amp; Supplies/);
    expect(html).toContain("The reader&#x27;s guess, from the paper (PO TOOLS).");
    expect(html).not.toContain("Not read off the paper");
  });

  it("AI Suggest's bucket keeps 'Not read off the paper', with its reason", () => {
    const html = render({ ...TOOLS_TICKET, proposal: { bucket: "Tools & Supplies", bucketFrom: "ai", why: "A tester is a tool." } });
    expect(html).toContain("Not read off the paper: A tester is a tool.");
  });

  it("PO STOCK picks nothing, and says what the paper says", () => {
    const html = render({ ...TOOLS_TICKET, proposal: { po: "STOCK", companyUse: { bucket: null, from: "po", words: "STOCK" } } });
    expect(html).toMatch(/>Where does this go\?<\/p>/);
    expect(html).toContain("On the paper: PO STOCK");
    expect(html).not.toMatch(/<option value="[^"]+" selected=""/);
  });

  it("a hint that was only the company's own name says nothing: the server's null is an answer", () => {
    const html = render({ ...TOOLS_TICKET, proposal: { jobHint: "ERIK TAYLOR" }, on_paper: null });
    expect(html).not.toContain("On the paper:");
    expect(html).not.toContain("ERIK TAYLOR");
  });

  it("every control is a 44px target", () => {
    const html = render({ proposal: { guessJobId: "job-046" } });
    for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toMatch(/h-11/);
    expect(html).toMatch(/<select[^>]*class="[^"]*h-11/);
  });

  it("a return with no lines on a job is refused in words, and the Read Again it names is there (DB4)", () => {
    const html = render({
      doc_type: "bill",
      vendor: "CED",
      amount: -51.58,
      payment: "on_account",
      line_items: null,
      file_url: "org-1/organize/ret.jpg",
      proposal: { jobId: "job-046", jobFrom: "address", jobHint: "13897 HERRINGBONE" },
    });
    expect(html).toContain("Press Read Again so its lines come with it");
    expect(html).toMatch(/Read Again<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="This is a return with no lines/);
    // The same paper WITH its lines has no Read Again and files.
    const lined = render({
      doc_type: "bill",
      vendor: "CED",
      amount: -51.58,
      payment: "on_account",
      line_items: [{ description: "H245ICAT 4 in LED Shallow IC HSG", quantity: -4, unit_price: -11.83, amount: -47.32 }],
      file_url: "org-1/organize/ret.jpg",
      proposal: { jobId: "job-046", jobFrom: "address", jobHint: "13897 HERRINGBONE" },
    });
    expect(lined).not.toContain("Read Again");
  });
});
