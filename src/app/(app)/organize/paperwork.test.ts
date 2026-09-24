import { describe, it, expect, vi, beforeEach } from "vitest";
import { TIMBER_CREEK } from "@/test/ced-timber-creek";

/**
 * PAPER WAITS FOR A PERSON (Erik, 2026-09-24; 0295).
 *
 * "Organize photos wait for File It": a model read is a proposal. These pin every door that used
 * to file from a model read (the reader itself, AI Review & File) to writing a SUGGESTION and no
 * money, and the one door that does write money (fileItem, pressed by a person) to the checks the
 * weaker doors skipped: what kind of paper it is, whether it was read, whether the same purchase
 * is already on the books, the counter-preview flag, the printed number, and the org.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const ai = vi.hoisted(() => ({ parsed: {} as any, systems: [] as string[] }));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({
    messages: {
      create: async (args: { system?: string }) => {
        ai.systems.push(String(args?.system ?? ""));
        return { model: "test-model", content: [{ type: "text", text: "{}" }], usage: {} };
      },
    },
  }),
}));
vi.mock("@/lib/ai-json", () => ({ parseAiJson: async () => ai.parsed }));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: async () => {}, modelFor: () => "test-model" }));
vi.mock("@/lib/analytics/job-profitability", () => ({ listJobScopes: async () => [] }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));

import { aiReviewItem, analyzeAndFile, billJobReceipt, fileItem, tiePaperwork, undoPaperwork } from "./actions";
import { addPaperwork } from "./paperwork-actions";
import { importCedInvoices } from "@/app/(app)/bills/supplier-import-actions";

type Call = { table: string; verb: string; payload?: any; selected?: boolean; eqs: [string, unknown][] };

/** A scriptable PostgREST fake that also records every .eq(), so the org boundary can be seen. */
function fakeSupabase(script: Record<string, any[]>, calls: Call[]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    storage: {
      from: () => ({
        remove: async () => ({ data: null, error: null }),
        download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(16) }, error: null }),
      }),
    },
    from(table: string) {
      let verb = "select";
      const mine: Call = { table, verb, eqs: [] };
      let pushed = false;
      const push = () => {
        if (!pushed) {
          calls.push(mine);
          pushed = true;
        }
      };
      const chain: any = {
        insert(payload: any) { verb = "insert"; mine.verb = verb; mine.payload = payload; push(); return chain; },
        update(payload: any) { verb = "update"; mine.verb = verb; mine.payload = payload; push(); return chain; },
        delete() { verb = "delete"; mine.verb = verb; push(); return chain; },
        select() {
          if (verb === "select") push();
          else mine.selected = true;
          return chain;
        },
        eq(col: string, val: unknown) { mine.eqs.push([col, val]); return chain; },
        order() { return chain; },
        not() { return chain; },
        limit() { return chain; },
        neq() { return chain; },
        in() { return chain; },
        single: () => Promise.resolve(next(`${table}.${verb}`)),
        maybeSingle: () => Promise.resolve(next(`${table}.${verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

let calls: Call[];
beforeEach(() => {
  calls = [];
  ai.systems = [];
});
const did = (table: string, verb: string) => calls.find((c) => c.table === table && c.verb === verb);

const JOBS = { data: [{ id: "job-046", job_number: "J-046", name: "Jason Waldow", address: "518 Crater Lake", city: null, customers: { name: "Jason" } }], error: null };

describe("the reader proposes; it never files (Erik, 2026-09-24)", () => {
  it("a receipt the model matched to a job, with HIGH confidence, still waits: no bill, no document, the job is only a suggestion", async () => {
    ai.parsed = {
      paper_type: "bill",
      kind: "receipt",
      title: "CED — $467.87",
      vendor: "Contractors Electrical Distributors",
      amount: 467.87,
      date: "2026-09-15",
      document_number: "8802-1108330",
      line_items: [{ description: "HOM120", quantity: 1, unit_price: 467.87, amount: 467.87, category: "Materials" }],
      payment: "on_account",
      destination: "job",
      job_id: "job-046",
      job_hint: "518 CRATER LAKE",
      confidence: "high",
    };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-1" }, error: null }],
        "jobs.select": [JOBS],
        "organizations.select": [{ data: { settings: { trade_label: "general contractor" } }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-1" }], error: null }],
      },
      calls,
    );
    const res = await analyzeAndFile({ path: "org-1/organize/1-ced.jpg", name: "ced.jpg", mime: "image/jpeg", size: 1000, sha256: "a".repeat(64) });
    expect(res.ok).toBe(true);
    expect(res.item).toMatchObject({ status: "needs_review", destination: "none", job_id: null });
    expect(res.item?.suggestion?.jobLabel).toContain("J-046");
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("documents", "insert")).toBeUndefined();
    const update = did("organized_items", "update")!.payload;
    expect(update).toMatchObject({
      status: "needs_review",
      doc_type: "bill",
      doc_number: "8802-1108330",
      proposal: expect.objectContaining({ jobId: "job-046", jobHint: "518 CRATER LAKE" }),
    });
    expect(update.job_id).toBeUndefined();
    // The fingerprint rides on the row the moment the file is in.
    expect(did("organized_items", "insert")!.payload).toMatchObject({ content_sha256: "a".repeat(64), source: "organize", status: "needs_review" });
  });

  it("a receipt the model calls overhead is not a business cost until a person says so", async () => {
    ai.parsed = { paper_type: "receipt", kind: "receipt", vendor: "Chevron", amount: 61.2, payment: "paid_at_purchase", destination: "overhead", overhead_category: "Gas & Truck", confidence: "high" };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-2" }, error: null }],
        "jobs.select": [{ data: [], error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-2" }], error: null }],
      },
      calls,
    );
    const res = await analyzeAndFile({ path: "org-1/organize/2-gas.jpg", name: "gas.jpg", mime: "image/jpeg", size: 1000 });
    expect(res.item?.status).toBe("needs_review");
    expect(res.item?.suggestion?.bucket).toBe("Gas & Truck");
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("the prompt speaks in the org's trade, not 'electrical contractor'", async () => {
    ai.parsed = { paper_type: "not_a_cost", kind: "job_document", confidence: "high" };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-3" }, error: null }],
        "jobs.select": [{ data: [], error: null }],
        "organizations.select": [{ data: { settings: { trade_label: "deck builder" } }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-3" }], error: null }],
      },
      calls,
    );
    await analyzeAndFile({ path: "org-1/organize/3.pdf", name: "3.pdf", mime: "application/pdf", size: 1000 });
    expect(ai.systems[0]).toContain("You read paperwork for a deck builder.");
    expect(ai.systems[0]).not.toContain("electrical contractor");
  });

  it("the same file twice is refused by the database's unique index, said as 'already in'", async () => {
    state.client = fakeSupabase({ "organized_items.insert": [{ data: null, error: { code: "23505", message: "duplicate key" } }] }, calls);
    const res = await analyzeAndFile({ path: "org-1/organize/4.jpg", name: "4.jpg", mime: "image/jpeg", size: 10, sha256: "b".repeat(64) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already in");
  });
});

describe("AI Suggest suggests; the side door that filed from a model read is shut", () => {
  it("a job it likes is written as the suggestion, and nothing is filed", async () => {
    ai.parsed = { action: "file_job", job_id: "job-046", reason: "The address matches." };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { id: "oi-1", kind: "receipt", title: "CED", vendor: "CED", amount: 467.87, summary: null, org_id: "org-1", proposal: null }, error: null }],
        "jobs.select": [JOBS],
        "organized_items.update": [{ data: [{ id: "oi-1" }], error: null }],
      },
      calls,
    );
    const res = await aiReviewItem("oi-1");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^Suggested: J-046/);
    expect(res.message).toContain("press File It");
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("documents", "insert")).toBeUndefined();
    expect(did("organized_items", "update")!.payload).toEqual({ proposal: expect.objectContaining({ jobId: "job-046" }) });
  });
});

/** A read, unfiled paper: a CED bill with its number. */
const PAPER = {
  id: "oi-9",
  kind: "receipt",
  status: "needs_review",
  doc_type: "bill",
  doc_number: "8802-1108330",
  title: "CED — $653.25",
  vendor: "CED",
  amount: 653.25,
  item_date: "2026-09-17",
  category: "Bill",
  payment: "on_account",
  pricing_provisional: true,
  proposal: { jobId: "job-046" },
  job_id: null,
  document_id: null,
  bill_id: null,
  petty_cash_id: null,
  tied_bill_id: null,
  tied_supplier_invoice_id: null,
  file_url: "org-1/organize/ced.pdf",
  line_items: [{ description: "HOM120", quantity: 1, unit_price: 653.25, amount: 653.25, category: "Materials" }],
};
const BOOKED_BILL = {
  id: "bill-1",
  supplier: "CED",
  bill_number: "8802-1108330",
  supplier_account_id: null,
  amount: 653.25,
  bill_date: "2026-09-17",
  job_id: "job-046",
  jobs: { job_number: "J-046", name: "Jason Waldow" },
};
const books = (bills: any[] = [BOOKED_BILL]) => ({
  "bills.select": [{ data: bills, error: null }],
  "supplier_invoices.select": [{ data: [], error: null }],
  "supplier_aliases.select": [{ data: [], error: null }],
});

describe("File It: the one door, with every check the weaker doors skipped", () => {
  it("reads the paper inside this org only", async () => {
    state.client = fakeSupabase({ "organized_items.select": [{ data: null, error: null }] }, calls);
    await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(did("organized_items", "select")!.eqs).toContainEqual(["org_id", "org-1"]);
  });

  it("a statement is named, not filed as a bill", async () => {
    state.client = fakeSupabase({ "organized_items.select": [{ data: { ...PAPER, doc_type: "statement", kind: "job_document" }, error: null }] }, calls);
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res).toEqual({ ok: false, error: "Not filed: this kind of paper goes in a later update." });
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("an unread paper is not filed as a cost", async () => {
    state.client = fakeSupabase(
      { "organized_items.select": [{ data: { id: "oi-8", kind: "job_document", status: "needs_review", title: "IMG.jpg", proposal: null }, error: null }] },
      calls,
    );
    const res = await fileItem("oi-8", { type: "overhead", category: "Other" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/hasn't been read/);
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("the same number from the same supplier already on the books refuses, and says Tie Them", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: PAPER, error: null },
          { data: [], error: null }, // loadBooks: papers with numbers
        ],
        ...books(),
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Already on the books: CED #8802-1108330, $653.25");
    expect(res.error).toContain("Same Purchase: Tie Them");
    expect(res.error).toContain("Different Purchase: File It Anyway");
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("bills", "delete")).toBeUndefined();
  });

  it("Different Purchase: File It Anyway files it, with the number, the Bill category, the counter-preview flag and the account", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: PAPER, error: null }],
        "supplier_aliases.select": [{ data: [{ alias: "CED", supplier_account_id: "acct-ced" }], error: null }],
        "documents.insert": [{ data: { id: "doc-1" }, error: null }],
        "bills.insert": [{ data: { id: "bill-2" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "organized_items.update": [{ error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" }, { differentPurchase: true });
    expect(res).toEqual({ ok: true });
    const bill = did("bills", "insert")!.payload;
    expect(bill).toMatchObject({
      job_id: "job-046",
      category: "Bill",
      bill_number: "8802-1108330",
      pricing_provisional: true,
      supplier_account_id: "acct-ced",
      status: "unpaid",
    });
    expect(bill.notes).toContain("different purchase");
    expect(did("documents", "insert")!.payload.category).toBe("Bill");
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "filed", bill_id: "bill-2", proposal: expect.objectContaining({ filed: { how: "bill" } }) });
  });

  it("a cost whose bill did not save goes back to the tray, never 'Filed' over nothing", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, doc_number: null }, error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "documents.insert": [{ data: { id: "doc-1" }, error: null }],
        "bills.insert": [{ data: null, error: { message: "boom" } }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.update": [{ error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("back in the tray");
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", bill_id: null });
  });
});

describe("Tie and Undo", () => {
  it("Tie only to a record the number check actually found", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: PAPER, error: null },
          { data: [], error: null },
        ],
        ...books([{ ...BOOKED_BILL, bill_number: "999" }]),
      },
      calls,
    );
    const res = await tiePaperwork("oi-9", { billId: "bill-1" });
    expect(res.ok).toBe(false);
    expect(did("organized_items", "update")).toBeUndefined();
  });

  it("Tie files against the bill already there and writes NOTHING new", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: PAPER, error: null },
          { data: [], error: null },
        ],
        ...books(),
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await tiePaperwork("oi-9", { billId: "bill-1" });
    expect(res.ok).toBe(true);
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "filed", tied_bill_id: "bill-1" });
    expect(did("organized_items", "update")!.payload.bill_id).toBeUndefined();
  });

  it("Undo of a tie never deletes the bill it was tied to", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, status: "filed", tied_bill_id: "bill-1", proposal: { filed: { how: "tie" } } }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await undoPaperwork("oi-9");
    expect(res.ok).toBe(true);
    expect(did("bills", "delete")).toBeUndefined();
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", tied_bill_id: null });
  });

  it("Undo under a live claim refuses in a sentence, and nothing is undone", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, status: "filed", bill_id: "bill-2", document_id: "doc-1", job_id: "job-046" }, error: null }],
        "bills.delete": [
          {
            data: null,
            error: { code: "P0001", message: "INV-069 already bills this receipt. Void that invoice, or take its materials lines off, then delete this receipt." },
          },
        ],
      },
      calls,
    );
    const res = await undoPaperwork("oi-9");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("INV-069 already bills this receipt. Void that invoice, or take its materials lines off, then press Undo again. Nothing was undone.");
    expect(did("documents", "delete")).toBeUndefined();
    expect(did("organized_items", "update")).toBeUndefined();
  });

  it("Undo of a filing takes its bill down and puts the paper back as it was read", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, status: "filed", bill_id: "bill-2", document_id: "doc-1", job_id: "job-046", category: "Gas & Truck" }, error: null }],
        "bills.delete": [{ data: [{ id: "bill-2" }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await undoPaperwork("oi-9");
    expect(res.ok).toBe(true);
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", bill_id: null, document_id: null, category: "Bill" });
  });
});

describe("billJobReceipt (Snap the Bill, Record as Cost) no longer drops what the paper says", () => {
  it("carries the counter-preview flag and the printed number onto the bill", async () => {
    ai.parsed = {
      vendor: "CED Sunnyvale",
      amount: 100,
      date: "2026-09-15",
      document_number: "T-123",
      pricing_provisional: true,
      line_items: [{ description: "HOM120 *****", quantity: 1, unit_price: 100, amount: 100 }],
      payment: "on_account",
      confidence: "high",
    };
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: { id: "doc-7", name: "t.jpg", file_url: "org-1/x/t.jpg", size_bytes: 10, job_id: "job-1" }, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "organizations.select": [{ data: { settings: { trade_label: "" } }, error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bills.insert": [{ data: { id: "bill-9" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli" }], error: null }],
        "organized_items.insert": [{ data: [{ id: "oi" }], error: null }],
      },
      calls,
    );
    const res = await billJobReceipt("doc-7");
    expect(res.ok).toBe(true);
    expect(did("bills", "insert")!.payload).toMatchObject({ pricing_provisional: true, bill_number: "T-123" });
    expect(ai.systems[0]).toContain("for a contractor");
    expect(ai.systems[0]).not.toContain("electrical contractor");
  });
});

describe("Drop Paperwork: the row a file becomes", () => {
  const input = { path: "org-1/organize/1-a.pdf", name: "a.pdf", mime: "application/pdf", size: 100, sha256: "c".repeat(64) };

  it("a file outside this org's organize folder is refused before anything is written", async () => {
    state.client = fakeSupabase({}, calls);
    const res = await addPaperwork({ ...input, path: "org-2/organize/1-a.pdf" });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a HEIC this device could not convert is refused by name", async () => {
    state.client = fakeSupabase({}, calls);
    const res = await addPaperwork({ ...input, name: "IMG_1.HEIC", mime: "image/heic" });
    expect(res.error).toBe("IMG_1.HEIC is a HEIC photo this device couldn't convert. Save it as JPEG and drop it again.");
  });

  it("the same FILE already in adds nothing and says where it is", async () => {
    state.client = fakeSupabase(
      { "organized_items.select": [{ data: [{ id: "oi-1", status: "filed", created_at: "2026-09-20T12:00:00Z", bill_id: "b", jobs: { job_number: "J-046", name: "Waldow" } }], error: null }] },
      calls,
    );
    const res = await addPaperwork(input);
    expect(res.ok).toBe(false);
    expect(res.already).toMatch(/^Already In: filed .* on J-046 Waldow\.$/);
    expect(did("organized_items", "insert")).toBeUndefined();
    expect(did("organized_items", "select")!.eqs).toContainEqual(["org_id", "org-1"]);
  });

  it("a CED PDF's own text makes CED documents, with no model read at all", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: [], error: null }],
        "organized_items.insert": [{ data: { id: "oi-5" }, error: null }],
      },
      calls,
    );
    const res = await addPaperwork({ ...input, pdfText: TIMBER_CREEK });
    expect(res).toMatchObject({ ok: true, id: "oi-5", needsRead: false });
    const row = did("organized_items", "insert")!.payload;
    expect(row).toMatchObject({ doc_type: "supplier_documents", doc_number: "8802-1101363", amount: 162.45, source: "bills_drop", status: "needs_review" });
    expect(row.proposal.ced.numbers).toEqual(["8802-1101363"]);
    expect(ai.systems).toHaveLength(0);
  });

  it("any other PDF becomes a row that still needs reading", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: [], error: null }],
        "organized_items.insert": [{ data: { id: "oi-6" }, error: null }],
      },
      calls,
    );
    const res = await addPaperwork({ ...input, pdfText: "Home Depot receipt 84.12" });
    expect(res).toMatchObject({ ok: true, needsRead: true });
    expect(did("organized_items", "insert")!.payload.doc_type).toBeNull();
  });
});

describe("importCedInvoices knows a PDF by its content, never its name", () => {
  it("a file NAMED .pdf whose text was read out of it lands", async () => {
    state.client = fakeSupabase(
      {
        "supplier_accounts.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [], error: null }],
        "supplier_invoices.insert": [{ data: [{ id: "si-1", invoice_number: "8802-1101363" }], error: null }],
        "supplier_invoice_lines.insert": [{ data: [{ id: "l1" }, { id: "l2" }, { id: "l3" }, { id: "l4" }, { id: "l5" }], error: null }],
      },
      calls,
    );
    const res = await importCedInvoices({ files: [{ name: "invoice_8802-1101363.pdf", text: TIMBER_CREEK }] });
    expect(res.ok).toBe(true);
    expect(res.refused).toEqual([]);
    expect(res.landed.map((d) => d.invoiceNumber)).toEqual(["8802-1101363"]);
  });

  it("raw PDF bytes are refused whatever the file is called, with the way forward", async () => {
    state.client = fakeSupabase({}, calls);
    const res = await importCedInvoices({ files: [{ name: "statement.txt", text: "%PDF-1.7\n1 0 obj << >>" }] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("statement.txt reached here as raw PDF bytes");
    expect(res.error).toContain("Choose CED PDFs");
  });
});
