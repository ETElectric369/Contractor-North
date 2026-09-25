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
// The real importer, wrapped so one test can say what a re-import landed.
vi.mock("@/app/(app)/bills/supplier-import-actions", async (orig) => {
  const real = await orig<typeof import("@/app/(app)/bills/supplier-import-actions")>();
  return { ...real, importCedInvoices: vi.fn(real.importCedInvoices) };
});

import { aiReviewItem, analyzeAndFile, billJobReceipt, deleteOrganizedItem, fileItem, keepAsNote, makeTaskFromPaper, readAsCost, tiePaperwork, unarchiveItem, undoPaperwork } from "./actions";
import { addPaperwork, addSupplierDocuments, updatePaperwork } from "./paperwork-actions";
import { insertItemizedBill } from "./paperwork-core";
import { RETURN_ON_JOB_NEEDS_LINES } from "@/lib/paperwork";
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
        remove: async (paths: string[]) => {
          storageLog.removed.push(...paths);
          return { data: null, error: null };
        },
        copy: async (from: string, to: string) => {
          storageLog.copied.push([from, to]);
          return storageLog.copyError ? { data: null, error: storageLog.copyError } : { data: { path: to }, error: null };
        },
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
        or() { return chain; },
        is() { return chain; },
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

/** What the fake storage was asked to copy and remove (PR4: a job photo's copy in the job folder). */
const storageLog = { copied: [] as [string, string][], removed: [] as string[], copyError: null as unknown };

let calls: Call[];
beforeEach(() => {
  calls = [];
  ai.systems = [];
  storageLog.copied = [];
  storageLog.removed = [];
  storageLog.copyError = null;
});
const did = (table: string, verb: string) => calls.find((c) => c.table === table && c.verb === verb);
const lastDid = (table: string, verb: string) => [...calls].reverse().find((c) => c.table === table && c.verb === verb);
const all = (table: string, verb: string) => calls.filter((c) => c.table === table && c.verb === verb);

const JOBS = { data: [{ id: "job-046", job_number: "J-046", name: "Jason Waldow", address: "518 Crater Lake Rd", city: null, customers: { name: "Jason" } }], error: null };

describe("the reader proposes; it never files (Erik, 2026-09-24)", () => {
  it("a bill whose PAPER names the job (its address) comes in with that job picked, says why, and still waits: no bill, no document", async () => {
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
      job_marks: { address: "518 CRATER LAKE RD" },
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
    expect(res.item?.suggestion).toMatchObject({ picked: true, because: "Job picked from the address on the bill: 518 CRATER LAKE RD" });
    expect(res.item?.suggestion?.jobLabel).toContain("J-046");
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("documents", "insert")).toBeUndefined();
    const update = did("organized_items", "update")!.payload;
    expect(update).toMatchObject({
      status: "needs_review",
      doc_type: "bill",
      doc_number: "8802-1108330",
      proposal: expect.objectContaining({ jobId: "job-046", jobFrom: "address", jobHint: "518 CRATER LAKE RD", guessJobId: null }),
    });
    // The matcher ran over this org's open jobs, filtered by org.
    expect(did("jobs", "select")!.eqs).toContainEqual(["org_id", "org-1"]);
    expect(update.job_id).toBeUndefined();
    // The fingerprint rides on the row the moment the file is in.
    expect(did("organized_items", "insert")!.payload).toMatchObject({ content_sha256: "a".repeat(64), source: "organize", status: "needs_review" });
  });

  it("a bill with NO job markings picks nothing, and a job_id the model makes up is never picked", async () => {
    ai.parsed = {
      paper_type: "bill",
      kind: "receipt",
      vendor: "CED",
      amount: 120.5,
      payment: "on_account",
      destination: "job",
      job_marks: { address: null, job_name: null, job_number: null, customer: null },
      job_id: "job-046",
      confidence: "high",
    };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-5" }, error: null }],
        "jobs.select": [JOBS],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-5" }], error: null }],
      },
      calls,
    );
    const res = await analyzeAndFile({ path: "org-1/organize/5.jpg", name: "5.jpg", mime: "image/jpeg", size: 1000 });
    expect(res.ok).toBe(true);
    expect(res.item?.suggestion ?? null).toBeNull();
    const proposal = did("organized_items", "update")!.payload.proposal;
    expect(proposal).toMatchObject({ jobId: null, jobFrom: null, guessJobId: null });
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("the reader is never shown the jobs, so what it copies into job_marks can only come off the paper", async () => {
    ai.parsed = { paper_type: "receipt", kind: "receipt", vendor: "Home Depot", amount: 12, confidence: "high" };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-8" }, error: null }],
        "jobs.select": [JOBS],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-8" }], error: null }],
      },
      calls,
    );
    await analyzeAndFile({ path: "org-1/organize/8.jpg", name: "8.jpg", mime: "image/jpeg", size: 1000 });
    expect(ai.systems[0]).not.toContain("job-046");
    expect(ai.systems[0]).not.toContain("Jason");
    expect(ai.systems[0]).not.toContain("Crater Lake");
    expect(ai.systems[0]).not.toContain('"job_id"');
  });

  it("a picture of handwriting is still a picture: it is not kept as a note, it waits and asks what it is", async () => {
    for (const amount of [null, 40]) {
      calls.length = 0;
      ai.parsed = { paper_type: "photo", kind: "note", title: "Panel schedule", category: "Photo", amount, confidence: "high" };
      state.client = fakeSupabase(
        {
          "organized_items.insert": [{ data: { id: "oi-9" }, error: null }],
          "jobs.select": [JOBS],
          "organizations.select": [{ data: { settings: {} }, error: null }],
          "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }],
        },
        calls,
      );
      const res = await analyzeAndFile({ path: "org-1/organize/9.jpg", name: "9.jpg", mime: "image/jpeg", size: 1000 });
      expect(res.item).toMatchObject({ status: "needs_review", destination: "none", picture: true, kind: "job_document" });
      expect(did("organized_items", "update")!.payload).toMatchObject({
        kind: "job_document",
        status: "needs_review",
        doc_type: "not_a_cost",
        category: "Photo",
        proposal: expect.objectContaining({ picture: true }),
      });
    }
  });

  it("a PO number printed on the paper finds the job through this org's own purchase order", async () => {
    ai.parsed = { paper_type: "receipt", kind: "receipt", vendor: "Home Depot", amount: 40, payment: "paid_at_purchase", po_number: "PO-0012", confidence: "high" };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-6" }, error: null }],
        "jobs.select": [JOBS],
        "purchase_orders.select": [{ data: [{ po_number: "PO-0012", job_id: "job-046" }], error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-6" }], error: null }],
      },
      calls,
    );
    const res = await analyzeAndFile({ path: "org-1/organize/6.jpg", name: "6.jpg", mime: "image/jpeg", size: 1000 });
    expect(res.item?.suggestion).toMatchObject({ picked: true, because: "Job picked from the PO on the receipt: PO-0012" });
    expect(did("purchase_orders", "select")!.eqs).toContainEqual(["org_id", "org-1"]);
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("a plain picture is read as a picture: not a cost, and the row will ask what it is", async () => {
    ai.parsed = { paper_type: "photo", kind: "job_document", title: "Panel, 200A main", category: "Photo", confidence: "high" };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-7" }, error: null }],
        "jobs.select": [JOBS],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-7" }], error: null }],
      },
      calls,
    );
    const res = await analyzeAndFile({ path: "org-1/organize/7.jpg", name: "7.jpg", mime: "image/jpeg", size: 1000 });
    expect(res.item?.picture).toBe(true);
    const update = did("organized_items", "update")!.payload;
    expect(update).toMatchObject({ doc_type: "not_a_cost", category: "Photo", status: "needs_review", proposal: expect.objectContaining({ picture: true }) });
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("documents", "insert")).toBeUndefined();
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

  it("a PO box holding the job's street picks it, the owner's name beside it is ignored, and the marks are kept on the row", async () => {
    ai.parsed = {
      paper_type: "bill",
      kind: "receipt",
      vendor: "Consolidated Electrical Dist.",
      amount: 323.71,
      document_number: "8802-SO-257555",
      po_number: "13897 HERRINGBONE",
      payment: "on_account",
      job_marks: { address: null, job_name: null, job_number: null, customer: "ERIK TAYLOR" },
      job_hint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE",
      confidence: "high",
    };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-h" }, error: null }],
        "jobs.select": [
          {
            data: [
              { id: "job-011", job_number: "J-011", name: "13897 Herringbone", address: "13897 Herringbone Way", customers: { name: "Andrew Cohen" } },
              { id: "job-099", job_number: "J-099", name: "Shop", address: null, customers: { name: "Erik Taylor" } },
            ],
            error: null,
          },
        ],
        "profiles.select": [{ data: [{ full_name: "Erik Taylor", organizations: { name: "ET Electric" } }], error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-h" }], error: null }],
      },
      calls,
    );
    const res = await analyzeAndFile({ path: "org-1/organize/h.jpg", name: "h.jpg", mime: "image/jpeg", size: 1000 });
    expect(res.item?.suggestion).toMatchObject({ picked: true, because: "Job picked from the PO on the bill: 13897 HERRINGBONE" });
    const proposal = did("organized_items", "update")!.payload.proposal;
    expect(proposal).toMatchObject({
      jobId: "job-011",
      jobFrom: "po",
      jobConflict: null,
      marks: { po: "13897 HERRINGBONE", customer: "ERIK TAYLOR", hint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE" },
    });
    expect(did("profiles", "select")!.eqs).toContainEqual(["org_id", "org-1"]);
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
    expect(res.message).toMatch(/^A guess: J-046/);
    expect(res.message).toContain("press File It");
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("documents", "insert")).toBeUndefined();
    // A GUESS, never the pick: guessJobId, and no jobId/jobFrom the picker would start on.
    const proposal = did("organized_items", "update")!.payload.proposal;
    expect(proposal).toMatchObject({ guessJobId: "job-046" });
    expect(proposal.jobId).toBeUndefined();
    expect(proposal.jobFrom).toBeUndefined();
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
        "organized_items.update": [
          { data: [{ id: "oi-9" }], error: null }, // the claim
          { data: [{ id: "oi-9" }], error: null }, // where it went
        ],
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
    expect(lastDid("organized_items", "update")!.payload).toMatchObject({ status: "filed", bill_id: "bill-2", proposal: expect.objectContaining({ filed: { how: "bill" } }) });
    expect(lastDid("organized_items", "update")!.eqs).toContainEqual(["org_id", "org-1"]);
  });

  it("a cost whose bill did not save goes back to the tray, never 'Filed' over nothing", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, doc_number: null }, error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "documents.insert": [{ data: { id: "doc-1" }, error: null }],
        "bills.insert": [{ data: null, error: { message: "boom" } }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-9" }], error: null },
          { data: [{ id: "oi-9" }], error: null },
        ],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("back in the tray");
    expect(lastDid("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", bill_id: null });
  });

  it("two presses at once: the second finds the paper already claimed and writes NOTHING", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, doc_number: null }, error: null }],
        // The claim is conditional on needs_review; the other press already moved it.
        "organized_items.update": [{ data: [], error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Someone else is filing this paper");
    const claim = did("organized_items", "update")!;
    expect(claim.payload).toEqual({ status: "filed" });
    expect(claim.eqs).toContainEqual(["status", "needs_review"]);
    expect(claim.eqs).toContainEqual(["org_id", "org-1"]);
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("documents", "insert")).toBeUndefined();
  });

  it("the claim comes first: a bill is never inserted before the paper is this press's", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, doc_number: null }, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-9" }], error: null },
          { data: [{ id: "oi-9" }], error: null },
        ],
        "supplier_aliases.select": [{ data: [], error: null }],
        "documents.insert": [{ data: { id: "doc-1" }, error: null }],
        "bills.insert": [{ data: { id: "bill-2" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res).toEqual({ ok: true });
    const order = calls.map((c) => `${c.table}.${c.verb}`);
    expect(order.indexOf("organized_items.update")).toBeLessThan(order.indexOf("bills.insert"));
  });
});

/**
 * A SUPPLIER RETURN FILED THROUGH ORGANIZE KEEPS ITS LINES (audit v994, DB4). The reader dropped a
 * credit memo's lines, Fix Details → Bill kept the negative total, and File It wrote a lineless
 * -$51.58 bill on Herringbone that the importer credited in full at markup: $64.48 back to Andrew
 * for four housings he was never charged for.
 */
describe("a supplier return through Organize: its lines come with it, or it does not go on a job", () => {
  const readInto = () =>
    fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-ret" }, error: null }],
        "jobs.select": [JOBS],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-ret" }], error: null }],
      },
      calls,
    );

  it("the reader keeps a credit memo's lines, and its total and lines read as money coming back", async () => {
    // Read as printed: a positive credit total and positive lines.
    ai.parsed = {
      paper_type: "credit_memo",
      kind: "job_document",
      title: "CED credit",
      vendor: "Consolidated Electrical Dist.",
      amount: 51.58,
      line_items: [
        { description: "H245ICAT 4 in LED Shallow IC HSG", quantity: 4, unit_price: 11.83, amount: 47.32, category: "Electrical" },
        { description: "Sales Tax", quantity: 1, unit_price: 4.26, amount: 4.26, category: "Tax" },
      ],
      confidence: "high",
    };
    state.client = readInto();
    const res = await analyzeAndFile({ path: "org-1/organize/ret.jpg", name: "ret.jpg", mime: "image/jpeg", size: 1000 });
    expect(res.ok).toBe(true);
    const row = did("organized_items", "update")!.payload;
    expect(row.doc_type).toBe("credit_memo");
    expect(row.amount).toBe(-51.58);
    expect(row.line_items.map((l: any) => [l.description, l.unit_price, l.amount])).toEqual([
      ["H245ICAT 4 in LED Shallow IC HSG", -11.83, -47.32],
      ["Sales Tax", -4.26, -4.26],
    ]);
    // It still waits: a credit memo is "a later update", and nothing was written as money.
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("lines the reader already signed as a credit are kept exactly as read", async () => {
    ai.parsed = {
      paper_type: "credit_memo",
      vendor: "CED",
      amount: -51.58,
      line_items: [
        { description: "H245ICAT 4 in LED Shallow IC HSG", quantity: -4, unit_price: -11.83, amount: -47.32, category: "Electrical" },
        { description: "Restocking fee", quantity: 1, unit_price: 5, amount: 5, category: "Electrical" },
      ],
    };
    state.client = readInto();
    await analyzeAndFile({ path: "org-1/organize/ret2.jpg", name: "ret2.jpg", mime: "image/jpeg", size: 1000 });
    const row = did("organized_items", "update")!.payload;
    expect(row.line_items.map((l: any) => l.amount)).toEqual([-47.32, 5]);
  });

  it("tells the reader a credit memo's lines come with it and its total is negative", async () => {
    ai.parsed = { paper_type: "receipt", kind: "receipt", vendor: "Home Depot", amount: 12 };
    state.client = readInto();
    await analyzeAndFile({ path: "org-1/organize/9.jpg", name: "9.jpg", mime: "image/jpeg", size: 1000 });
    expect(ai.systems[0]).toContain("receipts, bills and credit memos ONLY");
    expect(ai.systems[0]).toContain("the total is NEGATIVE");
  });

  it("File It refuses a return with no lines on a job, before anything is claimed or written", async () => {
    const lineless = { ...PAPER, doc_number: null, vendor: "Consolidated Electrical Dist.", amount: -51.58, pricing_provisional: false, line_items: null };
    state.client = fakeSupabase({ "organized_items.select": [{ data: lineless, error: null }] }, calls);
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Read Again so its lines come with it");
    expect(did("organized_items", "update")).toBeUndefined();
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("a return WITH its lines files on the job as a negative bill carrying every line", async () => {
    const lined = {
      ...PAPER,
      doc_number: null,
      vendor: "Consolidated Electrical Dist.",
      amount: -51.58,
      pricing_provisional: false,
      line_items: [
        { description: "H245ICAT 4 in LED Shallow IC HSG", quantity: -4, unit_price: -11.83, amount: -47.32, category: "Electrical" },
        { description: "Sales Tax", quantity: 1, unit_price: -4.26, amount: -4.26, category: "Tax" },
      ],
    };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: lined, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-9" }], error: null },
          { data: [{ id: "oi-9" }], error: null },
        ],
        "supplier_aliases.select": [{ data: [], error: null }],
        "documents.insert": [{ data: { id: "doc-1" }, error: null }],
        "bills.insert": [{ data: { id: "bill-ret" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }, { id: "bli-2" }], error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res).toEqual({ ok: true });
    expect(did("bills", "insert")!.payload.amount).toBe(-51.58);
    const lines = did("bill_line_items", "insert")!.payload as any[];
    expect(lines.map((l) => [l.description, l.amount])).toEqual([
      ["H245ICAT 4 in LED Shallow IC HSG", -47.32],
      ["Sales Tax", -4.26],
    ]);
  });

  /** Filed to J-046 with whatever lines the row holds; the bill and its lines are what it wrote. */
  const fileWith = async (row: Record<string, unknown>) => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, doc_number: null, vendor: "Consolidated Electrical Dist.", pricing_provisional: false, ...row }, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-9" }], error: null },
          { data: [{ id: "oi-9" }], error: null },
        ],
        "supplier_aliases.select": [{ data: [], error: null }],
        "documents.insert": [{ data: { id: "doc-1" }, error: null }],
        "bills.insert": [{ data: { id: "bill-x" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }, { id: "bli-2" }], error: null }],
      },
      calls,
    );
    return fileItem("oi-9", { type: "job", jobId: "job-046" });
  };
  const POSITIVE = [
    { description: "H245ICAT 4 in LED Shallow IC HSG", quantity: 4, unit_price: 11.83, amount: 47.32, category: "Electrical" },
    { description: "Sales Tax", quantity: 1, unit_price: 4.26, amount: 4.26, category: "Tax" },
  ];
  const NEGATIVE = POSITIVE.map((l) => ({ ...l, unit_price: -l.unit_price, amount: -l.amount }));

  it("a bill a person typed negative over positive lines files with its lines negative, so the cap can read them", async () => {
    const res = await fileWith({ doc_type: "bill", amount: -51.58, line_items: POSITIVE });
    expect(res).toEqual({ ok: true });
    expect(did("bills", "insert")!.payload.amount).toBe(-51.58);
    expect((did("bill_line_items", "insert")!.payload as any[]).map((l) => [l.description, l.quantity, l.unit_price, l.amount])).toEqual([
      ["H245ICAT 4 in LED Shallow IC HSG", 4, -11.83, -47.32],
      ["Sales Tax", 1, -4.26, -4.26],
    ]);
  });

  it("a credit memo a person called a charge files as a positive bill with positive lines, never credits under a lump", async () => {
    const res = await fileWith({ doc_type: "bill", amount: 51.58, line_items: NEGATIVE });
    expect(res).toEqual({ ok: true });
    expect(did("bills", "insert")!.payload.amount).toBe(51.58);
    expect((did("bill_line_items", "insert")!.payload as any[]).map((l) => [l.unit_price, l.amount])).toEqual([
      [11.83, 47.32],
      [4.26, 4.26],
    ]);
  });

  it("the write itself refuses a return with no lines on a job, whichever door calls it", async () => {
    state.client = fakeSupabase({}, calls);
    const bill = { job_id: "job-046", supplier: "CED", amount: -51.58, bill_date: null, category: "Bill", notes: "", created_by: "user-1" };
    expect(await insertItemizedBill(state.client, bill, [])).toBeNull();
    expect(did("bills", "insert")).toBeUndefined();
    // The company's own book (no job) is not held to it.
    state.client = fakeSupabase({ "bills.insert": [{ data: { id: "bill-oh" }, error: null }] }, calls);
    expect(await insertItemizedBill(state.client, { ...bill, job_id: null }, [])).toBe("bill-oh");
  });

  it("Snap the Bill refuses a return read with no legible lines, and writes nothing", async () => {
    ai.parsed = { vendor: "CED", amount: -51.58, date: "2026-09-15", line_items: [], payment: "on_account", confidence: "high" };
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: { id: "doc-7", name: "r.jpg", file_url: "org-1/x/r.jpg", size_bytes: 10, job_id: "job-1" }, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
      },
      calls,
    );
    const res = await billJobReceipt("doc-7");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(RETURN_ON_JOB_NEEDS_LINES);
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("organized_items", "insert")).toBeUndefined();
  });

  it("Snap the Bill writes a return read with positive lines as a negative bill with negative lines", async () => {
    ai.parsed = { vendor: "CED", amount: -51.58, date: "2026-09-15", line_items: POSITIVE, payment: "on_account", confidence: "high" };
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: { id: "doc-7", name: "r.jpg", file_url: "org-1/x/r.jpg", size_bytes: 10, job_id: "job-1" }, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bills.insert": [{ data: { id: "bill-9" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli" }], error: null }],
        "organized_items.insert": [{ data: [{ id: "oi" }], error: null }],
      },
      calls,
    );
    const res = await billJobReceipt("doc-7");
    expect(res.ok).toBe(true);
    expect((did("bill_line_items", "insert")!.payload as any[]).map((l) => l.amount)).toEqual([-47.32, -4.26]);
  });

  describe("Fix Details: a credit memo switched to a bill keeps its sign", () => {
    const MEMO = { id: "oi-ret", status: "needs_review", kind: "job_document", doc_type: "credit_memo", amount: -51.58, line_items: [] };
    const fields = (amount: number) => ({ doc_type: "bill", vendor: "CED", amount, item_date: null, doc_number: null, payment: "on_account" });

    it("a POSITIVE total asks whether it is a charge, and saves nothing", async () => {
      state.client = fakeSupabase({ "organized_items.select": [{ data: MEMO, error: null }] }, calls);
      const res = await updatePaperwork("oi-ret", fields(51.58));
      expect(res.ok).toBe(false);
      expect(res.askCharge).toBe(true);
      expect(res.error).toContain("-51.58");
      expect(res.error).toContain("It Is A Charge");
      expect(did("organized_items", "update")).toBeUndefined();
    });

    it("the negative total a return is saves as a bill", async () => {
      state.client = fakeSupabase(
        { "organized_items.select": [{ data: MEMO, error: null }], "organized_items.update": [{ data: [{ id: "oi-ret" }], error: null }] },
        calls,
      );
      const res = await updatePaperwork("oi-ret", fields(-51.58));
      expect(res.ok).toBe(true);
      expect(did("organized_items", "update")!.payload).toMatchObject({ doc_type: "bill", amount: -51.58, kind: "receipt" });
    });

    it("a person who says It Is A Charge is believed: a misread bill saves positive", async () => {
      state.client = fakeSupabase(
        { "organized_items.select": [{ data: MEMO, error: null }], "organized_items.update": [{ data: [{ id: "oi-ret" }], error: null }] },
        calls,
      );
      const res = await updatePaperwork("oi-ret", fields(51.58), { creditIsACharge: true });
      expect(res.ok).toBe(true);
      expect(did("organized_items", "update")!.payload).toMatchObject({ doc_type: "bill", amount: 51.58 });
    });

    it("It Is A Charge turns the credit memo's negative lines positive in the same save", async () => {
      state.client = fakeSupabase(
        {
          "organized_items.select": [{ data: { ...MEMO, line_items: NEGATIVE }, error: null }],
          "organized_items.update": [{ data: [{ id: "oi-ret" }], error: null }],
        },
        calls,
      );
      const res = await updatePaperwork("oi-ret", fields(51.58), { creditIsACharge: true });
      expect(res.ok).toBe(true);
      const patch = did("organized_items", "update")!.payload;
      expect(patch.amount).toBe(51.58);
      expect(patch.line_items.map((l: any) => [l.description, l.quantity, l.unit_price, l.amount])).toEqual([
        ["H245ICAT 4 in LED Shallow IC HSG", 4, 11.83, 47.32],
        ["Sales Tax", 1, 4.26, 4.26],
      ]);
    });

    it("a bill a person types negative has its positive lines turned negative in the same save", async () => {
      state.client = fakeSupabase(
        {
          "organized_items.select": [{ data: { ...MEMO, doc_type: "bill", kind: "receipt", amount: 51.58, line_items: POSITIVE }, error: null }],
          "organized_items.update": [{ data: [{ id: "oi-ret" }], error: null }],
        },
        calls,
      );
      const res = await updatePaperwork("oi-ret", fields(-51.58));
      expect(res.ok).toBe(true);
      expect(did("organized_items", "update")!.payload.line_items.map((l: any) => l.amount)).toEqual([-47.32, -4.26]);
    });

    it("lines that already point with the total are not rewritten", async () => {
      state.client = fakeSupabase(
        {
          "organized_items.select": [{ data: { ...MEMO, line_items: NEGATIVE }, error: null }],
          "organized_items.update": [{ data: [{ id: "oi-ret" }], error: null }],
        },
        calls,
      );
      await updatePaperwork("oi-ret", fields(-51.58));
      expect(did("organized_items", "update")!.payload).not.toHaveProperty("line_items");
    });

    it("an ordinary bill's Fix Details is not asked anything", async () => {
      state.client = fakeSupabase(
        { "organized_items.select": [{ data: { ...MEMO, doc_type: "bill", kind: "receipt" }, error: null }], "organized_items.update": [{ data: [{ id: "oi-ret" }], error: null }] },
        calls,
      );
      const res = await updatePaperwork("oi-ret", fields(51.58));
      expect(res.ok).toBe(true);
    });
  });
});

/** A CED document on the list with this paper's number. */
const CED_DOC = { id: "si-1", invoice_number: "8802-1108330", supplier_account_id: null, total: 653.25, invoice_date: "2026-09-17" };

describe("a CED document with the same number: link it, don't make the person lie (J-046)", () => {
  it("a document NO bill covers does not refuse: File It makes the bill and links it to that document", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: PAPER, error: null },
          { data: [], error: null }, // loadBooks: papers with numbers
        ],
        "bills.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [CED_DOC], error: null }],
        "supplier_aliases.select": [
          { data: [], error: null }, // loadBooks
          { data: [], error: null }, // exactAccountFor
        ],
        "bill_supplier_invoices.select": [{ data: [], error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-9" }], error: null },
          { data: [{ id: "oi-9" }], error: null },
        ],
        "documents.insert": [{ data: { id: "doc-1" }, error: null }],
        "bills.insert": [{ data: { id: "bill-2" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "bill_supplier_invoices.insert": [{ data: [{ id: "link-1" }], error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res).toEqual({ ok: true, message: "Filed. Linked to CED 8802-1108330." });
    // The job the person picked is kept, and the cost is a real bill on it.
    expect(did("bills", "insert")!.payload).toMatchObject({ job_id: "job-046", amount: 653.25 });
    // No false "a person checked: a different purchase" note.
    expect(did("bills", "insert")!.payload.notes).not.toContain("different purchase");
    expect(did("bill_supplier_invoices", "insert")!.payload).toEqual({ org_id: "org-1", bill_id: "bill-2", supplier_invoice_id: "si-1" });
  });

  it("a document ANOTHER bill covers is that bill's purchase: File It refuses and names the tie", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: PAPER, error: null },
          { data: [], error: null },
        ],
        "bills.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [CED_DOC], error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bill_supplier_invoices.select": [
          { data: [{ supplier_invoice_id: "si-1", bill_id: "bill-7", bills: { id: "bill-7", job_id: "job-046", jobs: { job_number: "J-046", name: "Jason Waldow" } } }], error: null },
        ],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Already on the books: CED document 8802-1108330, $653.25, covered by a bill on J-046 Jason Waldow.");
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("organized_items", "update")).toBeUndefined();
  });

  it("Tie goes to the COVERING bill, and the paper lands on that bill's job", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: PAPER, error: null },
          { data: [], error: null },
        ],
        "bills.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [CED_DOC], error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bill_supplier_invoices.select": [{ data: [{ supplier_invoice_id: "si-1", bill_id: "bill-7", bills: { id: "bill-7", job_id: "job-046" } }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await tiePaperwork("oi-9", { billId: "bill-7" });
    expect(res.ok).toBe(true);
    const tie = did("organized_items", "update")!;
    expect(tie.payload).toMatchObject({ status: "filed", tied_bill_id: "bill-7", tied_supplier_invoice_id: null, job_id: "job-046" });
    expect(tie.eqs).toContainEqual(["status", "needs_review"]);
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("another bill covered the document between the check and the link: this bill comes down, the paper goes back", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: PAPER, error: null },
          { data: [], error: null },
        ],
        "bills.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [CED_DOC], error: null }],
        "supplier_aliases.select": [
          { data: [], error: null },
          { data: [], error: null },
        ],
        "bill_supplier_invoices.select": [{ data: [], error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-9" }], error: null },
          { data: [{ id: "oi-9" }], error: null },
        ],
        "documents.insert": [{ data: { id: "doc-1" }, error: null }],
        "bills.insert": [{ data: { id: "bill-2" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "bill_supplier_invoices.insert": [{ data: null, error: { code: "23505", message: "duplicate key" } }],
        "bills.delete": [{ data: [{ id: "bill-2" }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("CED 8802-1108330 was just covered by another bill");
    expect(did("bills", "delete")!.eqs).toContainEqual(["id", "bill-2"]);
    expect(lastDid("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", bill_id: null });
  });
});

describe("AI Suggest never takes money out of the tray", () => {
  const RECEIPT_ROW = { id: "oi-1", kind: "receipt", status: "needs_review", doc_type: "receipt", title: "Home Depot", vendor: "Home Depot", amount: 84.12, summary: "wire", org_id: "org-1", proposal: null };

  for (const action of ["task", "keep_note"] as const) {
    it(`"${action}" on a receipt with a total is a suggestion: no task, no status change`, async () => {
      ai.parsed = { action, task_title: "Return the wire", reason: "Looks like a return." };
      state.client = fakeSupabase(
        {
          "organized_items.select": [{ data: RECEIPT_ROW, error: null }],
          "jobs.select": [{ data: [], error: null }],
          "organizations.select": [{ data: { settings: {} }, error: null }],
        },
        calls,
      );
      const res = await aiReviewItem("oi-1");
      expect(res.ok).toBe(true);
      expect(res.message).toMatch(/^Suggested: /);
      expect(res.message).toContain("stays here until a person files it");
      expect(did("organized_items", "update")).toBeUndefined();
      expect(did("tasks", "insert")).toBeUndefined();
    });
  }

  // PR2, ERIK'S CALL (audit v994): "AI Suggest on a note or kept paper PROPOSES; a person taps to
  // confirm". It used to make the task and file the note itself.
  const NOTE = { id: "oi-2", kind: "note", status: "needs_review", title: "call the inspector about Herringbone", summary: "call the inspector about Herringbone", category: "Note", org_id: "org-1", proposal: null };

  it("keep_note on a note is a PROPOSAL kept on the row: nothing is filed, nothing leaves the tray", async () => {
    ai.parsed = { action: "keep_note", reason: "Reference." };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: NOTE, error: null }],
        "jobs.select": [{ data: [], error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-2" }], error: null }],
      },
      calls,
    );
    const res = await aiReviewItem("oi-2");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Tap Keep As Note on the row");
    const u = did("organized_items", "update")!;
    expect(u.payload.status).toBeUndefined();
    expect(u.payload.proposal).toMatchObject({ suggestKeep: true, suggestTask: null, why: "Reference." });
    expect(u.eqs).toContainEqual(["org_id", "org-1"]);
    expect(u.eqs).toContainEqual(["status", "needs_review"]);
    expect(u.selected).toBe(true);
  });

  it("task on a note is a PROPOSAL: no task is made until a person taps Make Task", async () => {
    ai.parsed = { action: "task", task_title: "Call the inspector", task_category: "office", reason: "Something to do." };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: NOTE, error: null }],
        "jobs.select": [{ data: [], error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-2" }], error: null }],
      },
      calls,
    );
    const res = await aiReviewItem("oi-2");
    expect(res.ok).toBe(true);
    expect(did("tasks", "insert")).toBeUndefined();
    expect(did("organized_items", "update")!.payload.proposal).toMatchObject({ suggestTask: { title: "Call the inspector", category: "office" } });
  });

  it("Make Task makes the task, files the note with the task's id, and Undo takes the task off and brings the note back", async () => {
    const proposed = { ...NOTE, proposal: { suggestTask: { title: "Call the inspector", category: "office" }, why: "Something to do." } };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: proposed, error: null }],
        "tasks.insert": [{ data: { id: "task-1" }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-2" }], error: null }],
      },
      calls,
    );
    const made = await makeTaskFromPaper("oi-2");
    expect(made.ok).toBe(true);
    expect(did("tasks", "insert")!.payload).toMatchObject({ title: "Call the inspector", category: "office", status: "open" });
    const filed = did("organized_items", "update")!;
    expect(filed.payload).toMatchObject({ status: "filed", category: "Task", proposal: { filed: { how: "task", taskId: "task-1", category: "Note" } } });
    expect(filed.eqs).toContainEqual(["status", "needs_review"]);

    calls = [];
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...proposed, status: "filed", category: "Task", proposal: filed.payload.proposal }, error: null }],
        "tasks.delete": [{ data: [{ id: "task-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-2" }], error: null }],
      },
      calls,
    );
    const undone = await undoPaperwork("oi-2");
    expect(undone.ok).toBe(true);
    expect(did("tasks", "delete")!.eqs).toContainEqual(["id", "task-1"]);
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", category: "Note", proposal: expect.objectContaining({ filed: null }) });
  });

  it("Make Task on a note filed meanwhile takes its own task back out: never a task and a waiting note both", async () => {
    const proposed = { ...NOTE, proposal: { suggestTask: { title: "Call the inspector", category: "office" } } };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: proposed, error: null }],
        "tasks.insert": [{ data: { id: "task-1" }, error: null }],
        "organized_items.update": [{ data: [], error: null }],
        "tasks.delete": [{ data: [{ id: "task-1" }], error: null }],
      },
      calls,
    );
    const made = await makeTaskFromPaper("oi-2");
    expect(made.ok).toBe(false);
    expect(did("tasks", "delete")).toBeDefined();
  });

  it("Keep As Note files it as a note, only while it is waiting, and a receipt is never kept as a note", async () => {
    state.client = fakeSupabase(
      { "organized_items.select": [{ data: { ...NOTE, proposal: { suggestKeep: true } }, error: null }], "organized_items.update": [{ data: [{ id: "oi-2" }], error: null }] },
      calls,
    );
    expect((await keepAsNote("oi-2")).ok).toBe(true);
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "filed", proposal: { filed: { how: "note" } } });

    calls = [];
    state.client = fakeSupabase({ "organized_items.select": [{ data: RECEIPT_ROW, error: null }] }, calls);
    const refused = await keepAsNote("oi-1");
    expect(refused.ok).toBe(false);
    expect(did("organized_items", "update")).toBeUndefined();
  });

  it("its prompt speaks in the org's trade", async () => {
    ai.parsed = { action: "unsure", reason: "Can't tell." };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: RECEIPT_ROW, error: null }],
        "jobs.select": [{ data: [], error: null }],
        "organizations.select": [{ data: { settings: { trade_label: "deck builder" } }, error: null }],
      },
      calls,
    );
    await aiReviewItem("oi-1");
    expect(ai.systems[0]).toContain("for a deck builder");
    expect(ai.systems[0]).not.toContain("electrical contractor");
  });
});

describe("AI Suggest on the 13897 HERRINGBONE ticket (Erik, 2026-09-24)", () => {
  // ET's live row 12962a84 as it is stored: read before the PO box counted as the job.
  const HERRINGBONE_ROW = {
    id: "oi-h",
    kind: "receipt",
    status: "needs_review",
    doc_type: "bill",
    category: "Bill",
    title: "Consolidated Electrical Dist. — $323.71",
    vendor: "Consolidated Electrical Dist.",
    amount: "323.71",
    doc_number: "8802-SO-257555",
    summary: "Sales order for electrical materials: 1P sensor switch, flexbox two gang, 20/20A circuit breakers.",
    line_items: [{ description: "Q21530CT", amount: 41.2 }],
    org_id: "org-1",
    proposal: {
      po: "13897 HERRINGBONE",
      jobId: null,
      bucket: null,
      jobFrom: null,
      jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE",
      guessJobId: null,
      jobConflict: null,
    },
  };
  const OPEN = {
    data: [
      { id: "job-011", job_number: "J-011", name: "13897 Herringbone", address: "13897 Herringbone Way", customers: { name: "Andrew Cohen" } },
      { id: "job-046", job_number: "J-046", name: "Jason Waldow", address: "518 Crater Lake Rd", customers: { name: "Jason Waldow" } },
    ],
    error: null,
  };

  it("the rules answer first: the PO names J-011, said plainly, with no model call and nothing written", async () => {
    state.client = fakeSupabase({ "organized_items.select": [{ data: HERRINGBONE_ROW, error: null }], "jobs.select": [OPEN] }, calls);
    const res = await aiReviewItem("oi-h");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("J-011 13897 Herringbone");
    expect(res.message).toContain("Job picked from the PO on the bill: 13897 HERRINGBONE");
    expect(ai.systems).toHaveLength(0);
    expect(did("organized_items", "update")).toBeUndefined();
  });

  it("when the rules can't settle it, the model is handed what the reader found and every open job", async () => {
    ai.parsed = { action: "file_job", job_id: "job-011", reason: "The PO box names Herringbone." };
    const unsettled = { ...HERRINGBONE_ROW, proposal: { ...HERRINGBONE_ROW.proposal, po: "HERRINGBONE", jobHint: "HERRINGBONE JOB" } };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: unsettled, error: null }],
        "jobs.select": [OPEN],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-h" }], error: null }],
      },
      calls,
    );
    const res = await aiReviewItem("oi-h");
    expect(ai.systems[0]).toContain("J-011 13897 Herringbone; address: 13897 Herringbone Way; customer: Andrew Cohen");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^A guess: J-011 13897 Herringbone/);
    expect(did("organized_items", "update")!.payload.proposal).toMatchObject({ guessJobId: "job-011" });
  });

  it("nothing to suggest is a plain note, not an error", async () => {
    ai.parsed = { action: "unsure", reason: "Materials receipt lacks a job reference to attribute it to a specific job." };
    const bare = { ...HERRINGBONE_ROW, proposal: { po: null, jobHint: null } };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: bare, error: null }],
        "jobs.select": [OPEN],
        "organizations.select": [{ data: { settings: {} }, error: null }],
      },
      calls,
    );
    const res = await aiReviewItem("oi-h");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^No suggestion\./);
    expect(did("organized_items", "update")).toBeUndefined();
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
        "organized_items.select": [
          { data: { ...PAPER, status: "filed", bill_id: "bill-2", document_id: "doc-1", job_id: "job-046" }, error: null },
          { data: [], error: null }, // papers tied to the bill
        ],
        "bills.select": [
          { data: { id: "bill-2", amount: 653.25, on_shelf: false, bill_line_items: [] }, error: null },
          { data: [], error: null }, // copies set aside against it
        ],
        "documents.select": [{ data: { id: "doc-1", created_at: "2026-09-25T10:00:00Z", file_url: "org-1/organize/ced.pdf" }, error: null }],
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
        "organized_items.select": [
          { data: { ...PAPER, status: "filed", bill_id: "bill-2", document_id: "doc-1", job_id: "job-046", category: "Gas & Truck" }, error: null },
          { data: [], error: null },
        ],
        "bills.select": [
          { data: { id: "bill-2", amount: 653.25, on_shelf: false, bill_line_items: [] }, error: null },
          { data: [], error: null },
        ],
        "documents.select": [{ data: { id: "doc-1", created_at: "2026-09-25T10:00:00Z", file_url: "org-1/organize/ced.pdf" }, error: null }],
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

describe("Undo, Delete and a deleted bill leave nothing wrong behind (audit v994, TD1-TD5)", () => {
  const FILED = { ...PAPER, status: "filed", bill_id: "bill-2", document_id: "doc-1", job_id: "job-046", created_at: "2026-09-20T10:00:00Z" };
  const OWN_DOC = { data: { id: "doc-1", created_at: "2026-09-20T10:05:00Z", file_url: "org-1/organize/ced.pdf" }, error: null };
  const bill = (lines: any[] = [], extra: Record<string, unknown> = {}) => ({
    data: { id: "bill-2", amount: 653.25, on_shelf: false, bill_line_items: lines, ...extra },
    error: null,
  });

  it("TD2: a copy set aside as this bill's duplicate refuses the Undo, names the copy, and nothing is deleted", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: FILED, error: null }, { data: [], error: null }],
        "bills.select": [
          bill(),
          { data: [{ id: "bill-copy", supplier: "Swigard's", amount: 95.27, bill_date: "2026-09-10", job_id: "job-044", jobs: { job_number: "J-044", name: "Dino" } }], error: null },
        ],
        "documents.select": [OWN_DOC],
      },
      calls,
    );
    const res = await undoPaperwork("oi-9");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("The copy on J-044 Dino (Swigard's, $95.27, 2026-09-10) was set aside as a duplicate of this bill");
    expect(res.error).toContain("Change Your Mind");
    expect(res.error).toContain("Nothing was undone.");
    expect(did("bills", "delete")).toBeUndefined();
    expect(did("documents", "delete")).toBeUndefined();
    expect(did("organized_items", "update")).toBeUndefined();
  });

  it("TD2: papers tied to the bill go back to the tray with it, named, instead of staying filed over nothing", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: FILED, error: null },
          { data: [{ id: "oi-tied", title: "CED counter copy", vendor: "CED", proposal: { po: "X", filed: { how: "tie" } } }], error: null },
        ],
        "bills.select": [bill(), { data: [], error: null }],
        "documents.select": [OWN_DOC],
        "bills.delete": [{ data: [{ id: "bill-2" }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-tied" }], error: null },
          { data: [{ id: "oi-9" }], error: null },
        ],
      },
      calls,
    );
    const res = await undoPaperwork("oi-9");
    expect(res.ok).toBe(true);
    expect(res.message).toContain('"CED counter copy" was tied to that bill and is back in the tray too.');
    const tiedWrite = all("organized_items", "update")[0];
    expect(tiedWrite.payload).toMatchObject({ status: "needs_review", tied_bill_id: null, job_id: null, proposal: { po: "X", filed: null } });
    expect(tiedWrite.eqs).toContainEqual(["org_id", "org-1"]);
    expect(tiedWrite.selected).toBe(true);
  });

  it("TD3: the choices made on the bill (a line switched off, a box part-used) ride back onto the paper, and File It carries them again", async () => {
    const lines = [
      { description: "Klein 11-in-1 driver", quantity: 1, unit_price: 24.97, amount: 24.97, category: "Tools", billable: false, billed_amount: null, is_stock: false, sort_order: 0 },
      { description: "Wire nuts, box of 500", quantity: 1, unit_price: 60, amount: 60, category: "Materials", billable: true, billed_amount: 7.2, is_stock: false, sort_order: 1 },
    ];
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: FILED, error: null }, { data: [], error: null }],
        "bills.select": [bill(lines, { amount: 84.97 }), { data: [], error: null }],
        "documents.select": [OWN_DOC],
        "bills.delete": [{ data: [{ id: "bill-2" }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await undoPaperwork("oi-9");
    expect(res.ok).toBe(true);
    const back = did("organized_items", "update")!.payload;
    expect(back.amount).toBe(84.97);
    expect(back.line_items).toEqual([
      expect.objectContaining({ description: "Klein 11-in-1 driver", billable: false }),
      expect.objectContaining({ description: "Wire nuts, box of 500", billable: true, billed_amount: 7.2 }),
    ]);
    expect(back.line_items[0].billed_amount).toBeUndefined();
    expect(res.message).toContain("The choices made on the bill (1 line switched off, 1 part-used) stay with it");

    // ...and filed again, the bill's lines carry them.
    calls = [];
    const again = { ...PAPER, amount: 84.97, line_items: back.line_items };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: again, error: null }],
        ...books([]),
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }, { data: [{ id: "oi-9" }], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-3" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "l1" }, { id: "l2" }], error: null }],
      },
      calls,
    );
    const filed = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(filed.ok).toBe(true);
    const written = did("bill_line_items", "insert")!.payload;
    expect(written[0]).toMatchObject({ billable: false });
    expect(written[0].billed_amount).toBeUndefined();
    expect(written[1]).toMatchObject({ billable: true, billed_amount: 7.2 });
  });

  it("TD3: a line with a roll on the shop shelf refuses the Undo, and points at Take It Off The Shelf", async () => {
    const lines = [{ description: "12/2 Romex, 250 ft", quantity: 1, unit_price: 180, amount: 180, category: "Materials", billable: true, billed_amount: 36, is_stock: true, sort_order: 0 }];
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: FILED, error: null }, { data: [], error: null }],
        "bills.select": [bill(lines), { data: [], error: null }],
        "documents.select": [OWN_DOC],
      },
      calls,
    );
    const res = await undoPaperwork("oi-9");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("(12/2 Romex, 250 ft) is on the shop shelf");
    expect(res.error).toContain("Take It Off The Shelf");
    expect(did("bills", "delete")).toBeUndefined();
  });

  it("TD1: Undo on a receipt recorded as a cost on the job page takes the bill down and NEVER the job's own receipt", async () => {
    const LINK = { ...FILED, source: "organize", created_at: "2026-09-20T10:00:00Z", file_url: "org-1/job-046/1780000000000-swigards.jpg" };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: LINK, error: null }, { data: [], error: null }],
        "bills.select": [bill(), { data: [], error: null }],
        // The job's own upload: older than the link row, so the filing never made it.
        "documents.select": [{ data: { id: "doc-1", created_at: "2026-09-18T08:00:00Z", file_url: LINK.file_url }, error: null }],
        "bills.delete": [{ data: [{ id: "bill-2" }], error: null }],
        "organized_items.delete": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await undoPaperwork("oi-9");
    expect(res.ok).toBe(true);
    expect(did("documents", "delete")).toBeUndefined();
    expect(did("organized_items", "update")).toBeUndefined();
    expect(did("organized_items", "delete")!.eqs).toContainEqual(["org_id", "org-1"]);
    expect(res.message).toContain("The receipt stays on the job; press Record as Cost there");
  });

  it("TD1: a link row written by Record as Cost says so (source 'job'), whatever its dates", async () => {
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: { id: "doc-9", name: "ced-467.jpg", file_url: "org-1/job-046/ced-467.jpg", size_bytes: 1000, job_id: "job-046" }, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "bills.insert": [{ data: { id: "bill-new" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "l1" }], error: null }],
        "organized_items.insert": [{ data: [{ id: "oi-new" }], error: null }],
      },
      calls,
    );
    ai.parsed = { vendor: "CED", amount: 12, line_items: [{ description: "Wire", amount: 12 }], confidence: "high" };
    const res = await billJobReceipt("doc-9");
    expect(res.ok).toBe(true);
    expect(did("organized_items", "insert")!.payload).toMatchObject({ source: "job", document_id: "doc-9" });
  });

  it("TD4: Delete takes off the CED documents the paper added, inside this org, and keeps the ones something points at", async () => {
    const CEDP = { ...PAPER, status: "filed", doc_type: "supplier_documents", proposal: { ced: { numbers: ["8802-1"], total: 1, kinds: ["invoice"], text: "x", name: "a.pdf" }, filed: { how: "supplier_documents", landed: ["8802-1", "8802-2"] } } };
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: CEDP, error: null },
          { data: [], error: null }, // papers tied to them
        ],
        "supplier_invoices.select": [{ data: [{ id: "si-1", invoice_number: "8802-1", job_id: null }, { id: "si-2", invoice_number: "8802-2", job_id: null }], error: null }],
        "bill_supplier_invoices.select": [{ data: [{ supplier_invoice_id: "si-2" }], error: null }],
        "supplier_invoices.delete": [{ data: [{ id: "si-1" }], error: null }],
        "organized_items.delete": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await deleteOrganizedItem("oi-9");
    expect(res.ok).toBe(true);
    expect(did("supplier_invoices", "delete")!.eqs).toContainEqual(["org_id", "org-1"]);
    expect(res.message).toContain("8802-2 stayed on the CED documents list");
    expect(did("organized_items", "select")!.eqs).toContainEqual(["org_id", "org-1"]);
  });
});

/** A read picture waiting in the tray: a panel photo, not paper. */
const PICTURE = {
  id: "oi-p",
  kind: "job_document",
  status: "needs_review",
  doc_type: "not_a_cost",
  title: "Panel, 200A main",
  category: "Photo",
  vendor: null,
  amount: null,
  doc_number: null,
  proposal: { picture: true },
  job_id: null,
  document_id: null,
  bill_id: null,
  petty_cash_id: null,
  tied_bill_id: null,
  tied_supplier_invoice_id: null,
  file_url: "org-1/organize/panel.jpg",
  line_items: null,
};

describe("a picture: What is this? (Erik, 2026-09-24)", () => {
  it("Job Photo files it on the job as a photo, the job page's own kind of row, and writes NO bill", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: PICTURE, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-p" }], error: null }, // the claim
          { data: [{ id: "oi-p" }], error: null }, // where it went
        ],
        "documents.insert": [{ data: { id: "doc-p" }, error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-p", { type: "photo", jobId: "job-046" });
    expect(res.ok).toBe(true);
    // IN THE JOB'S OWN FOLDER (audit v994, PR4): the tech on the job can see it and Show On Portal
    // takes it. The paper keeps its organize original for the tray.
    expect(storageLog.copied).toHaveLength(1);
    expect(storageLog.copied[0][0]).toBe("org-1/organize/panel.jpg");
    expect(storageLog.copied[0][1]).toMatch(/^org-1\/job-046\/\d+-panel\.jpg$/);
    expect(did("documents", "insert")!.payload).toMatchObject({ job_id: "job-046", category: "Photo", kind: "other", file_url: storageLog.copied[0][1] });
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("bill_line_items", "insert")).toBeUndefined();
    expect(lastDid("organized_items", "update")!.payload).toMatchObject({
      job_id: "job-046",
      document_id: "doc-p",
      bill_id: null,
      status: "filed",
      proposal: expect.objectContaining({ filed: { how: "photo" } }),
    });
  });

  it("a photo that didn't land on the job goes back to the tray, never 'Filed' over nothing", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: PICTURE, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-p" }], error: null },
          { data: [{ id: "oi-p" }], error: null },
        ],
        "documents.insert": [{ data: null, error: { message: "denied" } }],
      },
      calls,
    );
    const res = await fileItem("oi-p", { type: "photo", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/photo didn't save/);
    expect(lastDid("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", document_id: null });
    // The copy this press put in the job's folder comes back out with it.
    expect(storageLog.removed).toEqual([storageLog.copied[0][1]]);
  });

  it("a copy that won't land in the job's folder puts the picture back, with no document on the job", async () => {
    storageLog.copyError = { message: "denied" };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: PICTURE, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-p" }], error: null },
          { data: [{ id: "oi-p" }], error: null },
        ],
      },
      calls,
    );
    const res = await fileItem("oi-p", { type: "photo", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't be copied onto the job/);
    expect(did("documents", "insert")).toBeUndefined();
    expect(lastDid("organized_items", "update")!.payload).toMatchObject({ status: "needs_review" });
  });

  it("a bill or receipt can never be filed as a job photo: refused before anything is written", async () => {
    state.client = fakeSupabase({ "organized_items.select": [{ data: PAPER, error: null }] }, calls);
    const res = await fileItem("oi-9", { type: "photo", jobId: "job-046" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a picture/);
    expect(did("organized_items", "update")).toBeUndefined();
    expect(did("documents", "insert")).toBeUndefined();
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("Undo of a job photo takes the photo off the job and puts the picture back, still a picture", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: { ...PICTURE, status: "filed", job_id: "job-046", document_id: "doc-p", proposal: { picture: true, filed: { how: "photo" } } }, error: null },
        ],
        "documents.select": [{ data: { id: "doc-p", created_at: "2026-09-25T10:00:00Z", file_url: "org-1/job-046/1790000000000-panel.jpg" }, error: null }],
        "documents.delete": [{ data: [{ id: "doc-p" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-p" }], error: null }],
      },
      calls,
    );
    const res = await undoPaperwork("oi-p");
    expect(res.ok).toBe(true);
    expect(did("bills", "delete")).toBeUndefined();
    // The job-folder copy comes off with its row; the organize original stays for the tray.
    expect(storageLog.removed).toEqual(["org-1/job-046/1790000000000-panel.jpg"]);
    expect(did("organized_items", "update")!.payload).toMatchObject({
      status: "needs_review",
      document_id: null,
      job_id: null,
      category: "Photo",
      proposal: { picture: true, filed: null },
    });
  });

  it("Bill Or Receipt makes it a receipt first, then reads it for the total, even if the model still calls it a photo", async () => {
    ai.parsed = { paper_type: "photo", kind: "job_document", title: "Home Depot", vendor: "Home Depot", amount: 23.4, category: "Photo", confidence: "medium" };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PICTURE, title: "IMG_2231.jpg", file_url: "org-1/organize/panel.jpg" }, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-p" }], error: null }, // the answer
          { data: [{ id: "oi-p" }], error: null }, // the read
        ],
        "jobs.select": [JOBS],
        "organizations.select": [{ data: { settings: {} }, error: null }],
      },
      calls,
    );
    const res = await readAsCost("oi-p");
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Read as a bill or receipt. Pick where it goes, then press File It.");
    const [answer, read] = all("organized_items", "update").map((c) => c.payload);
    expect(answer).toMatchObject({ doc_type: "receipt", kind: "receipt", category: "Receipt", payment: "unknown" });
    expect(answer.proposal.picture).toBeUndefined();
    expect(read).toMatchObject({ doc_type: "receipt", kind: "receipt", category: "Receipt", amount: 23.4, status: "needs_review" });
    expect(read.proposal.picture).toBeUndefined();
    expect(did("organized_items", "select")!.eqs).toContainEqual(["org_id", "org-1"]);
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("Bill Or Receipt on a paper already filed changes nothing", async () => {
    state.client = fakeSupabase(
      { "organized_items.select": [{ data: { id: "oi-p", title: "x", file_url: "org-1/organize/p.jpg", status: "filed", proposal: null }, error: null }] },
      calls,
    );
    const res = await readAsCost("oi-p");
    expect(res.ok).toBe(false);
    expect(did("organized_items", "update")).toBeUndefined();
  });

  it("Bill Or Receipt is only the answer to What Is This?: a statement or a CED PDF is refused, and nothing is written", async () => {
    for (const row of [
      { ...PICTURE, doc_type: "statement", category: "Other", proposal: null },
      { ...PICTURE, doc_type: null, category: "Other", proposal: { ced: { name: "ced.pdf", text: "x" } } },
    ]) {
      calls.length = 0;
      state.client = fakeSupabase({ "organized_items.select": [{ data: row, error: null }] }, calls);
      const res = await readAsCost("oi-p");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Only a picture is asked what it is");
      expect(did("organized_items", "update")).toBeUndefined();
    }
  });

  it("AI Suggest on a picture points to a control that is there: Job Photo for a job guess, nothing to tap for a bucket", async () => {
    ai.parsed = { action: "file_job", job_id: "job-046", reason: "The panel label." };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PICTURE, org_id: "org-1" }, error: null }],
        "jobs.select": [JOBS],
        "organized_items.update": [{ data: [{ id: "oi-p" }], error: null }],
      },
      calls,
    );
    const job = await aiReviewItem("oi-p");
    expect(job.message).toContain("press Job Photo on the row");
    expect(job.message).not.toContain("Tap it on the row");

    calls.length = 0;
    ai.parsed = { action: "overhead", overhead_category: "Tools & Supplies", reason: "Looks like a tool." };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PICTURE, org_id: "org-1" }, error: null }],
        "jobs.select": [JOBS],
      },
      calls,
    );
    const bucket = await aiReviewItem("oi-p");
    expect(bucket.ok).toBe(true);
    expect(bucket.message).toContain("Nothing was picked");
    expect(bucket.message).toContain("press Bill Or Receipt");
    expect(bucket.message).not.toContain("Tap it");
    expect(did("organized_items", "update")).toBeUndefined();
  });

  it("AI Suggest does not answer What Is This? by moving a picture", async () => {
    ai.parsed = { action: "keep_note", reason: "Reference photo." };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PICTURE, org_id: "org-1" }, error: null }],
        "jobs.select": [JOBS],
      },
      calls,
    );
    const res = await aiReviewItem("oi-p");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Nothing was moved");
    expect(did("organized_items", "update")).toBeUndefined();
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

  it("PR3: the same CED PDF dropped on ORGANIZE is read from its own text too, and says which door it came in by", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: [], error: null }],
        "organized_items.insert": [{ data: { id: "oi-6" }, error: null }],
      },
      calls,
    );
    const res = await addPaperwork({ ...input, source: "organize", pdfText: TIMBER_CREEK });
    expect(res).toMatchObject({ ok: true, id: "oi-6", needsRead: false });
    expect(did("organized_items", "insert")!.payload).toMatchObject({ doc_type: "supplier_documents", source: "organize", amount: 162.45 });
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

describe("CED documents a paper added: Restore, Undo and a second Add", () => {
  const CED_PAPER = {
    ...PAPER,
    id: "oi-5",
    kind: "job_document",
    doc_type: "supplier_documents",
    status: "filed",
    proposal: { ced: { numbers: ["8802-1101363"], total: 162.45, kinds: ["invoice"], text: "x", name: "a.pdf" }, filed: { how: "supplier_documents", landed: ["8802-1101363"] } },
  };

  it("Restore in the archive undoes an Add To CED Documents filing (it writes no bill or document column)", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: CED_PAPER, error: null }, // unarchiveItem
          { data: CED_PAPER, error: null }, // undoPaperwork
          { data: [], error: null }, // papers tied to those documents
        ],
        "supplier_invoices.select": [{ data: [{ id: "si-9", invoice_number: "8802-1101363", job_id: null }], error: null }],
        "bill_supplier_invoices.select": [{ data: [], error: null }],
        "supplier_invoices.delete": [{ data: [{ id: "si-9" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-5" }], error: null }],
      },
      calls,
    );
    const res = await unarchiveItem("oi-5");
    expect(res.ok).toBe(true);
    expect(did("supplier_invoices", "delete")).toBeDefined();
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", proposal: expect.objectContaining({ filed: null }) });
  });

  it("Undo keeps, and names, a document another paper is tied to", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: CED_PAPER, error: null },
          { data: [{ tied_supplier_invoice_id: "si-9" }], error: null },
        ],
        "supplier_invoices.select": [{ data: [{ id: "si-9", invoice_number: "8802-1101363", job_id: null }], error: null }],
        "bill_supplier_invoices.select": [{ data: [], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-5" }], error: null }],
      },
      calls,
    );
    const res = await undoPaperwork("oi-5");
    expect(res.ok).toBe(true);
    expect(did("supplier_invoices", "delete")).toBeUndefined();
    expect(res.message).toContain("8802-1101363 stayed on the CED documents list");
    expect(all("organized_items", "select")[1].eqs).toContainEqual(["org_id", "org-1"]);
  });

  it("a second Add that lands nothing new keeps what the first Add landed, so Undo can still find it", async () => {
    vi.mocked(importCedInvoices).mockResolvedValueOnce({ ok: true, message: "Nothing new.", landed: [], refused: [] } as never);
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...CED_PAPER, status: "needs_review" }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-5" }], error: null }],
      },
      calls,
    );
    const res = await addSupplierDocuments("oi-5");
    expect(res.ok).toBe(true);
    const u = did("organized_items", "update")!;
    expect(u.payload.proposal.filed).toEqual({ how: "supplier_documents", landed: ["8802-1101363"] });
    expect(u.eqs).toContainEqual(["status", "needs_review"]);
  });
});

describe("a CED PDF with one document that doesn't add up says so", () => {
  it("the refused document rides on the proposal and in the drop line", async () => {
    const broken = TIMBER_CREEK.replace("8802-1101363", "8802-1101999").replace("TOTAL DUE 162.45", "TOTAL DUE 999.99");
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: [], error: null }],
        "organized_items.insert": [{ data: { id: "oi-7" }, error: null }],
      },
      calls,
    );
    const res = await addPaperwork({
      path: "org-1/organize/1-two.pdf",
      name: "two.pdf",
      mime: "application/pdf",
      size: 100,
      sha256: "d".repeat(64),
      pdfText: `${TIMBER_CREEK}\n${broken}`,
    });
    expect(res).toMatchObject({ ok: true, needsRead: false });
    const ced = did("organized_items", "insert")!.payload.proposal.ced;
    expect(ced.numbers).toEqual(["8802-1101363"]);
    expect(ced.refused).toEqual([expect.objectContaining({ number: "8802-1101999" })]);
    expect(res.line).toMatch(/^1 CED document found in it; 1 didn't add up and won't be added: 8802-1101999/);
  });
});

// ── audit v994: who decided, and one purchase is one bill ──────────────────────────────────────

describe("File It records who decided where the paper went (Paper B, 12962a84)", () => {
  // Read 24 minutes before the PO-street rule shipped: nothing stored says the PO picked J-011.
  const PAPER_B = {
    ...PAPER,
    id: "12962a84",
    doc_number: "8802-SO-257555",
    title: "Consolidated Electrical Dist. — $323.71",
    vendor: "Consolidated Electrical Dist.",
    amount: 323.71,
    pricing_provisional: false,
    line_items: null,
    proposal: { po: "13897 HERRINGBONE", jobId: null, jobFrom: null, bucket: null, guessJobId: null, jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE" },
  };
  const J011 = { id: "j11", job_number: "J-011", name: "13897 Herringbone", address: "13897 Herringbone Way", customers: { name: "Andrew Cohen" } };
  const script = () => ({
    "organized_items.select": [{ data: PAPER_B, error: null }, { data: [], error: null }],
    "bills.select": [{ data: [], error: null }],
    "supplier_invoices.select": [{ data: [], error: null }],
    "supplier_aliases.select": [{ data: [], error: null }, { data: [], error: null }],
    "bill_supplier_invoices.select": [{ data: [], error: null }],
    // The tray's exact match, run again on the server before the claim.
    "jobs.select": [{ data: [J011], error: null }],
    "purchase_orders.select": [{ data: [], error: null }],
    "profiles.select": [{ data: [{ full_name: "Erik Taylor", organizations: { name: "ET Electric" } }], error: null }],
    "organized_items.update": [
      { data: [{ id: "12962a84" }], error: null },
      { data: [{ id: "12962a84" }], error: null },
    ],
    "documents.insert": [{ data: { id: "doc-b" }, error: null }],
    "bills.insert": [{ data: { id: "bill-b" }, error: null }],
  });

  it("filed on the job the PO names: the note says why, and `filed` keeps it (never the reader's proposal)", async () => {
    state.client = fakeSupabase(script(), calls);
    const res = await fileItem("12962a84", { type: "job", jobId: "j11" });
    expect(res.ok).toBe(true);
    expect(did("bills", "insert")!.payload.notes).toBe(
      "Bill filed by a person from the tray: Consolidated Electrical Dist. — $323.71\nJob picked from the PO on the bill: 13897 HERRINGBONE.",
    );
    const proposal = lastDid("organized_items", "update")!.payload.proposal;
    expect(proposal.filed).toEqual({
      how: "bill",
      picked: "paper",
      paperPick: "job:j11",
      because: "Job picked from the PO on the bill: 13897 HERRINGBONE",
      jobFrom: "po",
      jobHint: "13897 HERRINGBONE",
    });
    // The reader's proposal is untouched: Undo clears `filed` and the paper is as it was read.
    expect(proposal.jobId).toBeNull();
    expect(proposal.jobFrom).toBeNull();
  });

  it("filed somewhere else: a person overrode the paper, and the bill says so", async () => {
    state.client = fakeSupabase(script(), calls);
    await fileItem("12962a84", { type: "job", jobId: "job-046" });
    expect(did("bills", "insert")!.payload.notes).toContain(
      "A person picked this over what the paper names (Job picked from the PO on the bill: 13897 HERRINGBONE).",
    );
    expect(lastDid("organized_items", "update")!.payload.proposal.filed.picked).toBe("person");
  });
});

describe("billJobReceipt asks 'already on the books?' like every other door (audit v994, DB1)", () => {
  const TRAY_BILL = {
    id: "e2380fc9",
    supplier: "Consolidated Electrical Dist.",
    bill_number: "8802-SO-257555",
    supplier_invoice_number: null,
    supplier_account_id: "acct-ced",
    superseded_by_bill_id: null,
    amount: 323.71,
    bill_date: "2026-09-24",
    job_id: "j11",
    jobs: { job_number: "J-011", name: "13897 Herringbone" },
  };
  const snapped = (over: Record<string, any[]> = {}) => ({
    "documents.select": [{ data: { id: "doc-2", name: "IMG_2375.jpg", file_url: "org-1/j11/IMG_2375.jpg", size_bytes: 10, job_id: "j11" }, error: null }],
    "organized_items.select": [{ data: null, error: null }, { data: [], error: null }],
    "organizations.select": [{ data: { settings: {} }, error: null }],
    "supplier_aliases.select": [
      { data: [{ alias: "Consolidated Electrical Dist.", supplier_account_id: "acct-ced" }], error: null },
      { data: [{ alias: "Consolidated Electrical Dist.", supplier_account_id: "acct-ced" }], error: null },
    ],
    "bills.select": [{ data: [TRAY_BILL], error: null }],
    "supplier_invoices.select": [{ data: [], error: null }],
    "bill_supplier_invoices.select": [{ data: [], error: null }],
    ...over,
  });
  beforeEach(() => {
    ai.parsed = {
      vendor: "Consolidated Electrical Dist.",
      amount: 323.71,
      date: "2026-09-24",
      document_number: "8802-SO-257555",
      line_items: [{ description: "SIEM Q2020", quantity: 8, unit_price: 26.58, amount: 212.64 }],
      payment: "on_account",
      confidence: "high",
    };
  });

  it("the same ticket snapped again on the job page writes NOTHING and says which bill it is", async () => {
    state.client = fakeSupabase(snapped(), calls);
    const res = await billJobReceipt("doc-2");
    expect(res).toMatchObject({ ok: true, already: true });
    expect(res.sameAs).toContain("Already on the books: Consolidated Electrical Dist. #8802-SO-257555, $323.71, 2026-09-24, on J-011 13897 Herringbone.");
    // The fact only: each door names the button it renders (never "under Receipts & Documents").
    expect(res.sameAs).toBe("Already on the books: Consolidated Electrical Dist. #8802-SO-257555, $323.71, 2026-09-24, on J-011 13897 Herringbone. Nothing was recorded twice.");
    // The Add Cost sheet never falls back to a typed second bill on an ok.
    expect(res.warning).toBe(res.sameAs);
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("organized_items", "insert")).toBeUndefined();
  });

  it("Different Purchase: Record It Anyway records it, and the bill says a person checked", async () => {
    state.client = fakeSupabase(
      snapped({
        "organized_items.select": [{ data: null, error: null }],
        "bills.insert": [{ data: { id: "bill-new" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli" }], error: null }],
        "organized_items.insert": [{ data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    const res = await billJobReceipt("doc-2", { differentPurchase: true });
    expect(res.ok).toBe(true);
    expect(res.already).toBeUndefined();
    expect(did("bills", "insert")!.payload.notes).toContain("A person checked: a different purchase");
  });
});

describe("TOOLS in the PO box, read fresh (Erik, 2026-09-24)", () => {
  it("picks Tools & Supplies from the PO, keeps whose guess the bucket was, and files nothing", async () => {
    ai.parsed = {
      paper_type: "bill",
      kind: "receipt",
      title: "Consolidated Electrical Dist. — $44.44",
      vendor: "Consolidated Electrical Dist.",
      amount: 44.44,
      document_number: "8802-SO-257558",
      po_number: "TOOLS",
      job_hint: "JOB NAME AND ADDRESS ERIK TAYLOR TOOLS",
      payment: "on_account",
      destination: "overhead",
      overhead_category: "Tools & Supplies",
      job_marks: {},
      confidence: "high",
    };
    state.client = fakeSupabase(
      {
        "organized_items.insert": [{ data: { id: "oi-a" }, error: null }],
        "jobs.select": [JOBS],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-a" }], error: null }],
      },
      calls,
    );
    const res = await analyzeAndFile({ path: "org-1/organize/a.jpg", name: "a.jpg", mime: "image/jpeg", size: 1000 });
    expect(res.item?.suggestion).toEqual({
      jobLabel: null,
      bucket: "Tools & Supplies",
      picked: true,
      because: "Business cost picked from the PO on the bill: TOOLS",
    });
    const proposal = lastDid("organized_items", "update")!.payload.proposal;
    expect(proposal.companyUse).toEqual({ bucket: "Tools & Supplies", from: "po", words: "TOOLS" });
    expect(proposal.bucketFrom).toBe("reader");
    expect(did("bills", "insert")).toBeUndefined();
  });
});

// ── loadBooks: the read every "already on the books?" door leans on (review of audit v994) ─────
describe("loadBooks reads the bills that can match, in SQL, newest first", () => {
  it("only bills with a number in either column, only live ones, ordered, under the cap", async () => {
    const { loadBooks } = await import("./paperwork-core");
    const seen: { table: string; ops: [string, ...unknown[]][] }[] = [];
    const client = {
      from(table: string) {
        const rec = { table, ops: [] as [string, ...unknown[]][] };
        seen.push(rec);
        const chain: any = new Proxy(
          {},
          {
            get(_t, prop: string) {
              if (prop === "then") return (resolve: any) => resolve({ data: [], error: null });
              return (...args: unknown[]) => {
                rec.ops.push([prop, ...args]);
                return chain;
              };
            },
          },
        );
        return chain;
      },
    };
    await loadBooks(client, "org-1");
    const bills = seen.find((s) => s.table === "bills")!;
    expect(bills.ops).toContainEqual(["eq", "org_id", "org-1"]);
    expect(bills.ops).toContainEqual(["or", "bill_number.not.is.null,supplier_invoice_number.not.is.null"]);
    expect(bills.ops).toContainEqual(["is", "superseded_by_bill_id", null]);
    expect(bills.ops).toContainEqual(["order", "created_at", { ascending: false }]);
  });
});

describe("audit v994 wave 2: the paperwork doors say what they did", () => {
  it("DB5: a bill carrying the same long number under another spelling WARNS and never refuses; the bill says a person filed it anyway", async () => {
    const elsewhere = { ...BOOKED_BILL, supplier: "Consolidated Electrical Dist.", supplier_account_id: "acct-ced" };
    const paper = { ...PAPER, vendor: "Consolidated Electrical Distributors (CED)" };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: paper, error: null }],
        ...books([elsewhere]),
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }, { data: [{ id: "oi-9" }], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-3" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "l1" }], error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(true);
    const notes = String(did("bills", "insert")!.payload.notes);
    expect(notes).toContain("A person filed this with a bill carrying the same number under another supplier spelling on the books: Consolidated Electrical Dist. #8802-1108330");
    // Never decides the account for them: the paper's spelling is on no account, so none is written.
    expect(did("bills", "insert")!.payload.supplier_account_id).toBeUndefined();
  });

  it("DB5: Same Purchase: Tie Them ties to a bill the warning found", async () => {
    const elsewhere = { ...BOOKED_BILL, supplier: "Consolidated Electrical Dist.", supplier_account_id: "acct-ced" };
    state.client = fakeSupabase(
      {
        "organized_items.select": [
          { data: { ...PAPER, vendor: "Consolidated Electrical Distributors (CED)" }, error: null },
          { data: [], error: null },
        ],
        ...books([elsewhere]),
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await tiePaperwork("oi-9", { billId: "bill-1" });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^Tied\. Filed against Consolidated Electrical Dist\. #8802-1108330/);
    expect(res.message).not.toContain("spelled another way");
    expect(did("organized_items", "update")!.payload).toMatchObject({ tied_bill_id: "bill-1", status: "filed" });
  });

  it("MR6: a total that doesn't match its lines is written into the bill's notes, never corrected and never refused", async () => {
    const paper = { ...PAPER, doc_number: null, amount: 1284, line_items: [{ description: "Breakers", quantity: 1, unit_price: 684, amount: 684, category: "Materials" }] };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: paper, error: null }],
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }, { data: [{ id: "oi-9" }], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-3" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "l1" }], error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-9", { type: "job", jobId: "job-046" });
    expect(res.ok).toBe(true);
    const bill = did("bills", "insert")!.payload;
    expect(bill.amount).toBe(1284);
    expect(String(bill.notes)).toContain("add up to $684.00, $600.00 less than the $1284.00 total");
  });

  it("TD6: a read that lands after the paper was filed changes nothing, and says so", async () => {
    ai.parsed = { paper_type: "receipt", kind: "receipt", title: "Home Depot", vendor: "Home Depot", amount: 12, confidence: "high" };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { id: "oi-r", title: "hd.jpg", file_url: "org-1/organize/hd.jpg", status: "needs_review" }, error: null }],
        "jobs.select": [{ data: [], error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        // Filed from another screen during the read: the guarded write matches nothing.
        "organized_items.update": [{ data: [], error: null }],
      },
      calls,
    );
    const { readPaperworkItem } = await import("./actions");
    const res = await readPaperworkItem("oi-r");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("filed while it was being read");
    expect(did("organized_items", "update")!.eqs).toContainEqual(["status", "needs_review"]);
  });

  it("TD5: deleting a tray-filed bill from Bills puts its paper back, with the copy on the job taken off", async () => {
    const { deleteBill } = await import("@/app/(app)/jobs/actions");
    state.client = fakeSupabase(
      {
        "bills.select": [
          { data: { id: "bill-2", amount: 653.25, on_shelf: false, bill_line_items: [] }, error: null },
          { data: [], error: null },
        ],
        "organized_items.select": [
          { data: [], error: null }, // tied papers
          {
            data: [{ id: "oi-9", title: "CED — $653.25", source: "bills_drop", created_at: "2026-09-20T10:00:00Z", document_id: "doc-1", file_url: "org-1/organize/ced.pdf", doc_type: "bill", category: "Bill", kind: "receipt", proposal: { po: "X", filed: { how: "bill" } } }],
            error: null,
          },
        ],
        "bills.delete": [{ data: [{ id: "bill-2" }], error: null }],
        "documents.select": [{ data: { id: "doc-1", created_at: "2026-09-20T10:05:00Z", file_url: "org-1/organize/ced.pdf" }, error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-9" }], error: null }],
      },
      calls,
    );
    const res = await deleteBill("bill-2", "job-046");
    expect(res.ok).toBe(true);
    expect(res.warning).toContain('Its paper, "CED — $653.25", is back in Sort These');
    expect(did("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", bill_id: null, document_id: null, job_id: null, category: "Bill", proposal: { po: "X", filed: null } });
    expect(did("documents", "delete")).toBeDefined();
  });

  it("TD2 at the trash: a bill with a copy set aside against it refuses to delete, and names the copy", async () => {
    const { deleteBill } = await import("@/app/(app)/jobs/actions");
    state.client = fakeSupabase(
      {
        "bills.select": [
          { data: { id: "bill-2", amount: 95.27, on_shelf: false, bill_line_items: [] }, error: null },
          { data: [{ id: "bill-c", supplier: "Swigard's", amount: 95.27, bill_date: "2026-09-10", job_id: "job-044", jobs: { job_number: "J-044", name: "Dino" } }], error: null },
        ],
        "organized_items.select": [{ data: [], error: null }],
      },
      calls,
    );
    const res = await deleteBill("bill-2", "job-046");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("The copy on J-044 Dino");
    expect(res.error).toContain("Nothing was deleted.");
    expect(did("bills", "delete")).toBeUndefined();
  });
});
