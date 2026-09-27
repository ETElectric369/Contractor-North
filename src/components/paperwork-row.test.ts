import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PAPER CARD (0295; W1-31: the tray card on the Supplier Bills card grammar). Nothing on it
 * files by itself; every paper says what was read; the first answer is what the paper itself picks
 * (or a guess, marked so); a kind this update cannot file says so instead of offering a door; a
 * number already on the books offers Tie Them, and then every other answer records a different
 * purchase.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("@/app/(app)/organize/actions", () => ({
  archiveItem: vi.fn(),
  deleteOrganizedItem: vi.fn(),
  fileItem: vi.fn(),
  keepAsNote: vi.fn(),
  makeTaskFromPaper: vi.fn(),
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

import { PaperworkRow, differentPurchaseOf, paperMenuRows, pickJobOf, type PaperRowItem } from "./paperwork-row";
import { RETURN_NEEDS_LINES } from "@/lib/paperwork";

const JOBS = [
  { id: "job-046", job_number: "J-046", name: "Jason Waldow", status: "in_progress" },
  { id: "job-011", job_number: "J-011", name: "13897 Herringbone", status: "complete" },
];
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
type Extra = { shopStock?: boolean; initialAnswer?: "photo" | "else" | null };
const render = (item: Partial<PaperRowItem>, matches: any[] = [], extra: Extra = {}) =>
  renderToStaticMarkup(createElement(PaperworkRow, { item: { ...base, ...item }, jobs: JOBS, matches, onFiled: () => {}, ...extra }));

const words = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
/** Every button's words, in order. */
const buttons = (html: string) => Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)).map((m) => words(m[1]));
/** The card's answers: every button but the ⋯ and Open Paper. */
const answers = (html: string) => buttons(html).filter((b) => b && b !== "Open Paper");
const tagOf = (html: string, label: string) =>
  Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)).find((m) => words(m[2]) === label)?.[1] ?? "";
/** A shut button: the attribute, never the `disabled:` classes every button carries. */
const SHUT = /\sdisabled=""/;

describe("the cost card: the Supplier Bills grammar", () => {
  it("a read receipt with NO job markings: its headline, its grey line, no Ready To File badge, and the card asks", () => {
    const html = render({});
    expect(words(html)).toContain("Home Depot · $84.12 · No Job Name On It");
    expect(words(html)).toContain("Receipt (Paid)");
    expect(html).not.toContain("Ready To File");
    expect(html).toMatch(/>Where does this go\?<\/p>/);
    // No first answer: nothing to pick for anyone, so Pick A Job leads.
    expect(answers(html)).toEqual(["Pick A Job", "Shop Stock", "Business Cost"]);
    expect(html).not.toContain("selected");
    // The retired buttons are gone.
    expect(html).not.toContain(">File It<");
    expect(html).not.toContain("File It Anyway");
  });

  it("the paper names the job: Put It On J-046 first, primary, with why under it, then Another Job", () => {
    const html = render({ doc_number: "8802-1108330", item_date: "2026-09-20", proposal: { jobId: "job-046", jobFrom: "address", jobHint: "518 CRATER LAKE RD" } });
    expect(words(html)).toContain("Home Depot · $84.12 · It Says 518 CRATER LAKE RD");
    expect(words(html)).toContain("#8802-1108330 · Sep 20, 2026 · Receipt (Paid)");
    expect(answers(html)).toEqual(["Put It On J-046", "Another Job", "Shop Stock", "Business Cost"]);
    expect(tagOf(html, "Put It On J-046")).not.toMatch(SHUT);
    expect(tagOf(html, "Put It On J-046")).toContain("glass-ink"); // the primary button
    expect(html).toContain("Job picked from the address on the receipt: 518 CRATER LAKE RD");
    expect(html).not.toMatch(/>Where does this go\?<\/p>/);
    expect(html).not.toContain("Guess");
  });

  it("a MODEL'S GUESS is the first answer too, but marked Guess, with 'Not read off the paper' under it", () => {
    for (const proposal of [{ guessJobId: "job-046", why: "The store is near the job." }, { jobId: "job-046", jobHint: "518 CRATER LAKE" }]) {
      const html = render({ proposal });
      expect(answers(html)).toEqual(["Put It On J-046 Guess", "Another Job", "Shop Stock", "Business Cost"]);
      expect(html).toContain("Not read off the paper");
      expect(html).not.toContain("Job picked from");
      expect(html).not.toContain("selected");
    }
  });

  it("a bucket a model liked is the first answer as Business Cost · Fuel, marked Guess", () => {
    const html = render({ proposal: { bucket: "Fuel", bucketFrom: "ai", why: "A pump receipt." } });
    expect(answers(html)[0]).toBe("Business Cost · Fuel Guess");
    expect(answers(html)).toContain("Pick A Job");
    expect(html).toContain("Not read off the paper: A pump receipt.");
  });

  it("a paper that names two jobs says so above the answers and picks neither", () => {
    // What rematchPaper leaves on a paper that names two jobs: no job, the conflict said.
    const conflict = "The paper points to more than one job (the address and the PO number), so no job was picked.";
    const html = render({ proposal: { jobId: null, jobFrom: null, jobConflict: conflict } });
    expect(html).toContain("The paper points to more than one job");
    expect(html.indexOf("The paper points to more than one job")).toBeLessThan(html.indexOf("Pick A Job"));
    expect(answers(html)).toEqual(["Pick A Job", "Shop Stock", "Business Cost"]);
    // A model's guess beside it is still only a guess, and says so.
    const guessed = render({ proposal: { jobId: null, jobFrom: null, guessJobId: "job-046", jobConflict: conflict } });
    expect(answers(guessed)[0]).toBe("Put It On J-046 Guess");
    expect(guessed).toContain("The paper points to more than one job");
  });

  it("a number already on the books: Tie Them, and one line saying every other answer is a different purchase", () => {
    const matches = [{ kind: "bill", billId: "bill-1", sentence: "Already on the books: CED #8802-1108330, $653.25, on J-046 Jason Waldow." }];
    const html = render({ doc_number: "8802-1108330" }, matches);
    expect(html).toContain("Already on the books: CED #8802-1108330");
    expect(answers(html)).toEqual(["Same Purchase: Tie Them", "Pick A Job", "Shop Stock", "Business Cost"]);
    expect(html).toContain("Any other button below records it as a different purchase.");
    expect(html).not.toContain("Different Purchase: File It Anyway");
    // Every answer then carries the flag. A maybe (another spelling) alone does not: the server takes
    // it as a warning, and only without the flag does it link a supplier document and name the maybe.
    expect(differentPurchaseOf("ready", matches as any)).toBe(true);
    expect(differentPurchaseOf("ready", [{ kind: "maybe_bill", billId: "b", sentence: "Maybe…" }] as any)).toBe(false);
    expect(differentPurchaseOf("ready", [{ kind: "supplier_invoice", supplierInvoiceId: "si", invoiceNumber: "1", sentence: "x" }] as any)).toBe(false);
    expect(differentPurchaseOf("needs_total", matches as any)).toBe(false);
  });

  it("a maybe beside a supplier document no bill covers: no flag, so filing still links the document, and the box says what the answers do", () => {
    const matches = [
      { kind: "maybe_bill", billId: "bill-9", sentence: "Maybe already on the books: C.E.D. Reno #8802110, $120.00. It carries this number under another spelling." },
      {
        kind: "supplier_invoice",
        supplierInvoiceId: "si-1",
        invoiceNumber: "8802110",
        sentence: "On the supplier documents list with no bill yet: 8802110, $120.00. Filing it makes the bill and links it to that document.",
      },
    ];
    expect(differentPurchaseOf("ready", matches as any)).toBe(false);
    const html = render({ doc_type: "bill", vendor: "CED", doc_number: "8802110", proposal: { jobId: "job-046", jobFrom: "po" } }, matches);
    expect(html).toContain("Same Purchase: Tie Them");
    expect(html).toContain("Filing it makes the bill and links it to that document.");
    expect(html).not.toContain("Any other button below records it as a different purchase.");
    expect(html).toContain("If it isn&#x27;t the same purchase, any other button below files it, and its bill notes the other spelling.");
    expect(answers(html)[1]).toBe("Put It On J-046");
  });

  it("every answer that files sends the flag (missing it recreates the duplicate-bill refusal)", () => {
    const SRC = readFileSync(join(process.cwd(), "src/components/paperwork-row.tsx"), "utf8");
    expect(SRC).toContain("const differentPurchase = differentPurchaseOf(r.state, matches);");
    expect(SRC).toContain('{ type: "overhead", category: d.category }, { differentPurchase })');
    expect(SRC).toContain("setShelfSheet({ differentPurchase })");
    expect(SRC).toContain("{ differentPurchase: shelfSheet.differentPurchase }");
  });

  it("a supplier document no bill covers: no Tie, the first answer stays Put It On J-046, and the card says filing links it", () => {
    const html = render({ doc_type: "bill", vendor: "CED", doc_number: "8802-1108330", proposal: { jobId: "job-046", jobFrom: "po" } }, [
      {
        kind: "supplier_invoice",
        supplierInvoiceId: "si-1",
        invoiceNumber: "8802-1108330",
        sentence: "On the supplier documents list with no bill yet: 8802-1108330, $653.25. Filing it makes the bill and links it to that document.",
      },
    ]);
    expect(html).not.toContain("Same Purchase: Tie Them");
    expect(answers(html)[0]).toBe("Put It On J-046");
    expect(html).toContain("Filing it makes the bill and links it to that document.");
  });

  it("the answers point at the company's own buckets and the Closest / Every Job picker, never a select on the card", () => {
    const html = render({});
    expect(html).not.toMatch(/<select/);
    expect(tagOf(html, "Pick A Job")).toContain('aria-expanded="false"');
    expect(tagOf(html, "Business Cost")).toContain('aria-expanded="false"');
    // Jobs as the buttons say them: the number first, a finished one known by its status.
    expect(pickJobOf(JOBS[1])).toEqual({ id: "job-011", label: "J-011", name: "13897 Herringbone", status: "complete" });
    expect(pickJobOf({ id: "x", job_number: "", name: "Smith Panel" })).toMatchObject({ label: "Smith Panel" });
  });
});

describe("Paper A (audit v994): PO TOOLS, the reader's bucket, and PO STOCK", () => {
  const TOOLS_TICKET: Partial<PaperRowItem> = {
    doc_type: "bill",
    vendor: "Consolidated Electrical Dist.",
    amount: 44.44,
    payment: "on_account",
    doc_number: "8802-SO-257558",
    proposal: { po: "TOOLS", bucket: "Tools & Supplies", jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR TOOLS" },
  };

  it("PO TOOLS the tray has matched: Business Cost · Tools & Supplies first (the paper's own), with why", () => {
    const html = render({
      ...TOOLS_TICKET,
      proposal: { ...(TOOLS_TICKET.proposal as object), companyUse: { bucket: "Tools & Supplies", from: "po", words: "TOOLS" } },
      on_paper: "PO TOOLS",
    });
    expect(words(html)).toContain("Consolidated Electrical Dist. · $44.44 · It Says TOOLS");
    expect(words(html)).toContain("Bill (Still Owed)");
    expect(answers(html)[0]).toBe("Business Cost · Tools & Supplies");
    expect(html).toContain("Business cost picked from the PO on the bill: TOOLS");
    expect(html).not.toMatch(/>Where does this go\?<\/p>/);
  });

  it("a reader's bucket is 'The reader's guess', never 'Not read off the paper', and the PO is in the headline", () => {
    const html = render({ ...TOOLS_TICKET, on_paper: "PO TOOLS" });
    expect(words(html)).toContain("It Says PO TOOLS");
    expect(answers(html)[0]).toBe("Business Cost · Tools & Supplies Guess");
    expect(html).toContain("The reader&#x27;s guess, from the paper (PO TOOLS).");
    expect(html).not.toContain("Not read off the paper");
  });

  it("AI Suggest's bucket keeps 'Not read off the paper', with its reason", () => {
    const html = render({ ...TOOLS_TICKET, proposal: { bucket: "Tools & Supplies", bucketFrom: "ai", why: "A tester is a tool." } });
    expect(html).toContain("Not read off the paper: A tester is a tool.");
  });

  it("PO STOCK with no stock mark picks nothing, and says what the paper says", () => {
    const html = render({ ...TOOLS_TICKET, proposal: { po: "STOCK", companyUse: { bucket: null, from: "po", words: "STOCK" } }, on_paper: "PO STOCK" });
    expect(html).toMatch(/>Where does this go\?<\/p>/);
    expect(words(html)).toContain("It Says PO STOCK");
    expect(answers(html)).toEqual(["Pick A Job", "Shop Stock", "Business Cost"]);
  });

  it("a hint that was only the company's own name says nothing: the server's null is an answer", () => {
    const html = render({ ...TOOLS_TICKET, proposal: { jobHint: "ERIK TAYLOR" }, on_paper: null });
    expect(words(html)).toContain("No Job Name On It");
    expect(html).not.toContain("ERIK TAYLOR");
  });

  // ── The Shop Stock switch (0352) ──────────────────────────────────────────────────────────
  const SHELF_TICKET: Partial<PaperRowItem> = {
    ...TOOLS_TICKET,
    proposal: { po: "STOCK", companyUse: { bucket: null, from: "po", words: "STOCK", shelf: true } },
    on_paper: "PO STOCK",
    line_items: [{ description: "NMB 12/2 W/GND (250 ft Coil)", quantity: 1, unit_price: 44.44, amount: 44.44 }],
  };

  it("Shop Stock on (or the switch not passed): today's card, and a STOCK paper's first answer is Record To Stock", () => {
    for (const item of [{}, SHELF_TICKET]) expect(render(item, [], { shopStock: true })).toBe(render(item));
    const html = render(SHELF_TICKET);
    expect(answers(html)).toEqual(["Record To Stock", "Pick A Job", "Business Cost"]);
    expect(html).toContain("Shop Stock picked from the PO on the bill: STOCK");
  });

  it("Shop Stock off: no stock door anywhere, and a STOCK paper picks nothing but its words still show", () => {
    const html = render({}, [], { shopStock: false });
    expect(answers(html)).toEqual(["Pick A Job", "Business Cost"]);
    expect(html).not.toContain("Shop Stock");
    const marked = render(SHELF_TICKET, [], { shopStock: false });
    expect(answers(marked)).toEqual(["Pick A Job", "Business Cost"]);
    expect(marked).not.toContain("Record To Stock");
    expect(marked).toMatch(/>Where does this go\?<\/p>/);
    expect(words(marked)).toContain("It Says STOCK");
  });
});

describe("the one door a paper the reader couldn't finish needs", () => {
  it("unread paper: Not Read Yet, and Read Now; no answers", () => {
    const html = render({ doc_type: null, kind: "job_document", vendor: null, amount: null, payment: null });
    expect(html).toContain("Not Read Yet");
    expect(answers(html)).toEqual(["Read Now"]);
    expect(words(html)).toContain("IMG_0412.jpg");
  });

  it("too big to read: Fix Details: Put The Total In", () => {
    const html = render({ doc_type: null, kind: "job_document", vendor: null, amount: null, payment: null, proposal: { tooBig: true } });
    expect(html).toContain("Too Big To Read");
    expect(answers(html)).toEqual(["Fix Details: Put The Total In"]);
  });

  it("a cost with no total: Needs A Total, and its answers wait for the total", () => {
    const html = render({ amount: null });
    expect(html).toContain("Needs A Total");
    expect(answers(html)).toEqual(["Fix Details: Put The Total In"]);
    expect(words(html)).toContain("Home Depot · No Total Read");
    expect(html).toContain("No total was read. Put the total in with Fix Details, then answer where it goes.");
  });
});

describe("the other kinds of paper, the same grammar", () => {
  it("a statement is named honestly, with no answers at all: its doors are on the ⋯", () => {
    const html = render({ doc_type: "statement", kind: "job_document" });
    expect(html).toContain("A statement, but its list of open papers couldn&#x27;t be read.");
    expect(html).toContain("Snap Or Note");
    expect(answers(html)).toEqual([]);
    expect(html).toContain('aria-label="Actions"');
    expect(paperMenuRows("later", true)).toEqual(["Fix Details", "Read Again", "Keep It In Files", "Delete"]);
  });

  it("supplier documents keep one button, Add To Supplier Documents; Keep It In Files is on the ⋯", () => {
    const html = render({
      doc_type: "supplier_documents",
      kind: "job_document",
      proposal: { ced: { numbers: ["8802-1101363"], total: 162.45, kinds: ["invoice"], text: "x", name: "a.pdf" } },
    });
    expect(answers(html)).toEqual(["Add To Supplier Documents"]);
    expect(html).toContain("Supplier document, 8802-1101363, $162.45");
    expect(paperMenuRows("supplier_documents", true)).toEqual(["Keep It In Files"]);
  });

  it("a supplier document in the same PDF that didn't add up is said on the card", () => {
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

  const PICTURE: Partial<PaperRowItem> = {
    kind: "job_document",
    doc_type: "not_a_cost",
    category: "Photo",
    vendor: null,
    amount: null,
    payment: null,
    title: "Panel, 200A main",
    proposal: { picture: true, guessJobId: "job-046" },
  };

  it("a plain PICTURE asks What is this? first: Job Photo, Bill Or Receipt, Something Else, and no cost doors", () => {
    const html = render(PICTURE);
    expect(html).toContain("Picture, Panel, 200A main");
    expect(html).toContain("What is this?");
    expect(answers(html)).toEqual(["Job Photo", "Bill Or Receipt", "Something Else"]);
    expect(html).not.toContain("Business Cost");
  });

  it("after Job Photo: Put Photo On J-046 (a guess, marked) and Another Job", () => {
    const html = render(PICTURE, [], { initialAnswer: "photo" });
    expect(answers(html)).toEqual(["Put Photo On J-046 Guess", "Another Job", "Change Answer"]);
    const none = render({ ...PICTURE, proposal: { picture: true } }, [], { initialAnswer: "photo" });
    expect(none).toContain("Which job is this photo for?");
    expect(answers(none)).toEqual(["Pick A Job", "Change Answer"]);
  });

  it("not a cost: Put It On J-046, Another Job, Keep It In Files, never the old Where Does It Go? select; a Reminder chip", () => {
    const html = render({
      kind: "job_document",
      doc_type: "not_a_cost",
      vendor: null,
      amount: null,
      payment: null,
      title: "Permit 2026-114",
      proposal: { guessJobId: "job-046", suggestTask: { title: "Call the inspector", category: "office" } },
    });
    expect(answers(html)).toEqual(["Put It On J-046 Guess", "Another Job", "Keep It In Files", "Add A Reminder: Call the inspector"]);
    expect(html).not.toMatch(/<select/);
    expect(html).not.toContain("Where Does It Go?");
    expect(html).not.toContain("Make Task");
    expect(html).not.toContain("AI Suggest");
    // Keep It In Files is on the card, so the ⋯ doesn't carry it again.
    expect(paperMenuRows("keep", true, ["Keep It In Files"])).toEqual(["Fix Details", "Read Again", "Set Aside"]);
  });

  it("after Something Else: the not-a-cost answers, with Change Answer", () => {
    const html = render(PICTURE, [], { initialAnswer: "else" });
    expect(answers(html)).toEqual(["Put It On J-046 Guess", "Another Job", "Keep It In Files", "Change Answer"]);
  });
});

describe("Open Paper, and the ⋯", () => {
  it("Open Paper is the first row when there is a file or lines, closed until he taps it; a mismatch is said while it's closed", () => {
    const lined = { signedUrl: "https://signed.example/r.jpg", line_items: [{ description: "Wire nuts", quantity: 1, unit_price: 50, amount: 50 }] };
    const html = render(lined);
    expect(tagOf(html, "Open Paper")).toContain('aria-expanded="false"');
    expect(html.indexOf("Open Paper")).toBeLessThan(html.indexOf("Pick A Job"));
    expect(html).toContain("Its lines don&#x27;t add up to the total read. Open Paper shows both.");
    expect(render({})).not.toContain("Open Paper");
  });

  it("the ⋯ rows: Fix Details, Read Again, Keep It In Files, Set Aside, Delete, each only where it applies", () => {
    expect(paperMenuRows("ready", true)).toEqual(["Fix Details", "Read Again", "Set Aside"]);
    expect(paperMenuRows("ready", false)).toEqual(["Fix Details", "Set Aside"]);
    expect(paperMenuRows("not_read", true)).toEqual(["Fix Details", "Keep It In Files", "Set Aside"]);
    expect(paperMenuRows("needs_total", true)).toEqual(["Read Again", "Set Aside"]);
    expect(paperMenuRows("too_big", true)).toEqual(["Keep It In Files", "Set Aside"]);
    expect(paperMenuRows("picture", true)).toEqual(["Fix Details", "Read Again", "Keep It In Files", "Set Aside"]);
    // Delete only for paper this update can't file, and last.
    expect(paperMenuRows("later", false).at(-1)).toBe("Delete");
    for (const s of ["ready", "keep", "picture", "supplier_documents", "not_read"] as const) expect(paperMenuRows(s, true)).not.toContain("Delete");
    // Never Read Again on supplier documents: the reader would overwrite what the PDF's own text said.
    expect(paperMenuRows("supplier_documents", true)).not.toContain("Read Again");
  });

  it("the ⋯ is the section menu, labelled Actions, with the card's rows as its children and Delete confirm-guarded", () => {
    const SRC = readFileSync(join(process.cwd(), "src/components/paperwork-row.tsx"), "utf8");
    expect(SRC).toContain("<SectionActionsMenu tree={CARD_MENU}>");
    expect(SRC).toContain('const CARD_MENU = { center: { label: "Actions", icon: "more" }, nodes: [] };');
    expect(SRC).toMatch(/if \(confirm\(`Delete this \$\{describePaper\(item\)\}\? The file goes too\.`\)\)/);
    expect(render({})).toMatch(/<button[^>]*aria-label="Actions"/);
  });
});

describe("the law on every card", () => {
  it("every control is a 44px target", () => {
    for (const item of [{ proposal: { guessJobId: "job-046" } }, { amount: null }, { doc_type: "statement", kind: "job_document" }]) {
      const html = render(item as Partial<PaperRowItem>);
      for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toMatch(/\bh-11\b|\bmin-h-11\b/);
    }
  });

  it("a return with no lines on a job is refused in words, and the Read Again it names is right there (DB4)", () => {
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
    expect(tagOf(html, "Put It On J-046")).toMatch(SHUT);
    expect(tagOf(html, "Put It On J-046")).toContain(`title="${RETURN_NEEDS_LINES.replace(/'/g, "&#x27;")}"`);
    expect(tagOf(html, "Another Job")).toMatch(SHUT);
    expect(buttons(html)).toContain("Read Again");
    // A business cost is the company's own book: not held to it.
    expect(tagOf(html, "Business Cost")).not.toMatch(SHUT);
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
    expect(buttons(lined)).not.toContain("Read Again");
    expect(tagOf(lined, "Put It On J-046")).not.toMatch(SHUT);
  });

  it("a paper whose bill was deleted says why it is back, naming doors that exist", () => {
    const html = render({ proposal: { billDeleted: { at: "2026-09-25T00:00:00Z", by: null } } });
    expect(html).toContain("Its bill was deleted from Bills.");
    expect(html).not.toMatch(/File It again/);
  });
});
