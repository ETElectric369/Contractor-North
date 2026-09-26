import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CARD'S ONE TAP, AND ITS UNDO (Bills plan, Wave A, 2026-09-25).
 *
 * fileSupplierPaper chains the two actions that already do each half (setSupplierInvoiceJob, then
 * recordSupplierInvoiceAsBill); these tests pin what the chain adds: the job comes back off when
 * the record fails (and says so, including when the put-back itself did not land), the Business
 * Cost shape, and an Undo that refuses once a customer invoice bills the paper.
 *
 * The fake PostgREST builder is supplier-actions.test.ts's, with `or` added for the claim read.
 * Unscripted calls throw, so each test also pins WHICH statements run, in which order.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { fileSupplierPaper, undoFileSupplierPaper } from "./supplier-actions";

type Call = { table: string; verb: string; payload?: any };

function fakeSupabase(script: Record<string, any[]>, calls: Call[]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      let verb = "select";
      const chain: any = {
        insert(payload: any) { verb = "insert"; calls.push({ table, verb, payload }); return chain; },
        update(payload: any) { verb = "update"; calls.push({ table, verb, payload }); return chain; },
        delete() { verb = "delete"; calls.push({ table, verb }); return chain; },
        select() { if (verb === "select") calls.push({ table, verb }); return chain; },
        eq() { return chain; },
        neq() { return chain; },
        is() { return chain; },
        in() { return chain; },
        or() { return chain; },
        not() { return chain; },
        order() { return chain; },
        limit() { return chain; },
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

const STAFF = { data: { role: "owner", org_id: "org-1", active: true }, error: null };
const OK = (data: any) => ({ data, error: null });
const INVOICE = "si-herringbone";
const NUMBER = "8802-1106969";

/** CED's 8802-1106969, $301.81, "13897 HERRINGBONE", open, as recordSupplierInvoiceAsBill reads it. */
const recordRow = (jobId: string | null) =>
  OK({
    id: INVOICE,
    invoice_number: NUMBER,
    kind: "invoice",
    invoice_date: "2026-09-04",
    job_id: jobId,
    supplier_account_id: "acct-ced",
    tax: 0,
    shipping: 0,
    total: "301.81",
    open_balance: "301.81",
    closed: false,
    supplier_accounts: { name: "Consolidated Electrical Distributors" },
    jobs: jobId ? { name: "13897 Herringbone", job_number: "J-011" } : null,
  });
const siblings = OK([{ id: INVOICE, kind: "invoice", total: "301.81", open_balance: "301.81", closed: false }]);
const docsForSamePurchase = OK([{ id: INVOICE, invoice_number: NUMBER, supplier_account_id: "acct-ced", job_id: null, total: "301.81", invoice_date: "2026-09-04" }]);

let calls: Call[];
beforeEach(() => {
  calls = [];
});

describe("fileSupplierPaper: Put It On J-011, one tap", () => {
  /** Every read and write the happy path makes, in order, per table. */
  const happy = (over: Record<string, any[]> = {}) => ({
    // fileSupplierPaper, setSupplierInvoiceJob, recordSupplierInvoiceAsBill: each checks staff.
    "profiles.select": [STAFF, STAFF, STAFF],
    "supplier_invoices.select": [
      OK({ id: INVOICE, invoice_number: NUMBER, kind: "invoice", job_id: null }), // the paper, before anything
      docsForSamePurchase, // setSupplierInvoiceJob's "maybe already on the books?"
      recordRow("j-011"), // the record reads it again, job on it now
      siblings, // the reversal check
      docsForSamePurchase, // the record's own "already in your books?"
    ],
    "jobs.select": [OK({ id: "j-011", name: "13897 Herringbone", job_number: "J-011" })],
    "supplier_invoices.update": [OK([{ id: INVOICE, invoice_number: NUMBER, supplier_account_id: "acct-ced", total: "301.81", invoice_date: "2026-09-04" }])],
    "bill_supplier_invoices.select": [OK([]), OK([]), OK([]), OK([])],
    "bills.select": [OK([]), OK([])],
    "supplier_aliases.select": [OK([]), OK([])],
    "supplier_invoice_lines.select": [OK([])],
    "bills.insert": [OK([{ id: "bill-new" }])],
    "bill_supplier_invoices.insert": [OK([{ id: "link-new" }])],
    ...over,
  });

  it("puts it on the job AND records the bill, and hands back exactly what Undo needs", async () => {
    state.client = fakeSupabase(happy(), calls);
    const res = await fileSupplierPaper({ invoiceId: INVOICE, jobId: "j-011" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain(`${NUMBER} is a bill on 13897 Herringbone now: $301.81`);
    expect(res.undo).toEqual({ invoiceId: INVOICE, billId: "bill-new", jobSetTo: "j-011", jobBefore: null });
    expect(calls.find((c) => c.table === "supplier_invoices" && c.verb === "update")?.payload).toEqual({ job_id: "j-011" });
    expect(calls.find((c) => c.table === "bills" && c.verb === "insert")?.payload).toMatchObject({ job_id: "j-011", amount: 301.81, org_id: "org-1" });
  });

  it("takes the job back off when the record fails, and says nothing changed", async () => {
    state.client = fakeSupabase(
      happy({
        "supplier_invoices.select": [
          OK({ id: INVOICE, invoice_number: NUMBER, kind: "invoice", job_id: null }),
          docsForSamePurchase,
          { data: null, error: { message: "connection reset" } }, // the record cannot read it
        ],
        "supplier_invoices.update": [
          OK([{ id: INVOICE, invoice_number: NUMBER, supplier_account_id: "acct-ced", total: "301.81", invoice_date: "2026-09-04" }]),
          OK([{ id: INVOICE }]), // the put-back
        ],
      }),
      calls,
    );
    const res = await fileSupplierPaper({ invoiceId: INVOICE, jobId: "j-011" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Couldn't read that invoice just now, so nothing was written.");
    expect(res.error).toContain("The job was taken back off it, so nothing changed.");
    const updates = calls.filter((c) => c.table === "supplier_invoices" && c.verb === "update").map((c) => c.payload);
    expect(updates).toEqual([{ job_id: "j-011" }, { job_id: null }]);
    expect(calls.some((c) => c.table === "bills" && c.verb === "insert")).toBe(false);
  });

  it("a put-back that wrote no rows is said out loud, never 'nothing changed'", async () => {
    state.client = fakeSupabase(
      happy({
        "supplier_invoices.select": [
          OK({ id: INVOICE, invoice_number: NUMBER, kind: "invoice", job_id: null }),
          docsForSamePurchase,
          { data: null, error: { message: "connection reset" } },
        ],
        "supplier_invoices.update": [
          OK([{ id: INVOICE, invoice_number: NUMBER, supplier_account_id: "acct-ced", total: "301.81", invoice_date: "2026-09-04" }]),
          OK([]),
        ],
      }),
      calls,
    );
    const res = await fileSupplierPaper({ invoiceId: INVOICE, jobId: "j-011" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("is still on that job with no bill");
    expect(res.error).not.toContain("nothing changed");
  });

  it("refuses a paper that is not a purchase before any job goes on it", async () => {
    state.client = fakeSupabase(
      { "profiles.select": [STAFF], "supplier_invoices.select": [OK({ id: INVOICE, invoice_number: "8802-1104645", kind: "credit_memo", job_id: null })] },
      calls,
    );
    const res = await fileSupplierPaper({ invoiceId: INVOICE, jobId: "j-030" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("isn't a purchase");
    expect(calls.some((c) => c.verb !== "select")).toBe(false);
  });

  it("needs exactly one answer: a job, or Business Cost", async () => {
    state.client = fakeSupabase({ "profiles.select": [STAFF] }, calls);
    const res = await fileSupplierPaper({ invoiceId: INVOICE });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Pick a job for it, or Business Cost. Nothing was filed.");
  });
});

describe("fileSupplierPaper: Business Cost", () => {
  it("records it with no job, in the bucket he pressed, and Undo leaves the paper's job alone", async () => {
    state.client = fakeSupabase(
      {
        "profiles.select": [STAFF, STAFF],
        "supplier_invoices.select": [OK({ id: INVOICE, invoice_number: NUMBER, kind: "invoice", job_id: null }), recordRow(null), siblings, docsForSamePurchase],
        "bill_supplier_invoices.select": [OK([]), OK([])],
        "bills.select": [OK([])],
        "supplier_aliases.select": [OK([])],
        "supplier_invoice_lines.select": [OK([])],
        "bills.insert": [OK([{ id: "bill-cost" }])],
        "bill_supplier_invoices.insert": [OK([{ id: "link" }])],
      },
      calls,
    );
    const res = await fileSupplierPaper({ invoiceId: INVOICE, businessCost: "Tools & Supplies" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain(`${NUMBER} is a business cost now, under Tools & Supplies: $301.81`);
    expect(calls.find((c) => c.table === "bills" && c.verb === "insert")?.payload).toMatchObject({ job_id: null, category: "Tools & Supplies" });
    expect(res.undo).toEqual({ invoiceId: INVOICE, billId: "bill-cost", jobSetTo: null, jobBefore: null });
    expect(calls.some((c) => c.table === "supplier_invoices" && c.verb === "update")).toBe(false);
  });

  it("a bucket that is not one of the six is refused, never guessed at", async () => {
    state.client = fakeSupabase(
      { "profiles.select": [STAFF], "supplier_invoices.select": [OK({ id: INVOICE, invoice_number: NUMBER, kind: "invoice", job_id: null })] },
      calls,
    );
    const res = await fileSupplierPaper({ invoiceId: INVOICE, businessCost: "Gas" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Pick one of the six business-cost buckets");
    expect(calls.some((c) => c.verb === "insert")).toBe(false);
  });
});

describe("undoFileSupplierPaper", () => {
  const TOKEN = { invoiceId: INVOICE, billId: "bill-new", jobSetTo: "j-011", jobBefore: null };
  const BILL = OK({ id: "bill-new", supplier_invoice_number: NUMBER, job_id: "j-011" });

  it("refuses once a customer invoice bills it, and names that invoice", async () => {
    state.client = fakeSupabase(
      {
        "profiles.select": [STAFF],
        "bill_supplier_invoices.select": [OK([{ bill_id: "bill-new" }])],
        "bills.select": [BILL],
        "invoice_items.select": [OK([{ import_key: "bli:line-1", source_ids: ["bill-new"], invoices: { invoice_number: "INV-078", status: "draft" } }])],
      },
      calls,
    );
    const res = await undoFileSupplierPaper(TOKEN);
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`INV-078 already bills ${NUMBER}, so Undo can't take it back.`);
    expect(calls.some((c) => c.verb === "delete" || c.verb === "update")).toBe(false);
  });

  it("takes the bill back out and the job back off", async () => {
    state.client = fakeSupabase(
      {
        "profiles.select": [STAFF],
        "bill_supplier_invoices.select": [OK([{ bill_id: "bill-new" }])],
        "bills.select": [BILL, OK({ id: "bill-new", amount: "301.81", on_shelf: false, bill_line_items: [] }), OK([])],
        "invoice_items.select": [OK([])],
        "organized_items.select": [OK([])],
        "bills.delete": [OK([{ id: "bill-new" }])],
        "supplier_invoices.update": [OK([{ id: INVOICE }])],
      },
      calls,
    );
    const res = await undoFileSupplierPaper(TOKEN);
    expect(res.ok).toBe(true);
    expect(res.message).toBe(`Undone: ${NUMBER}'s bill is gone and the paper is on no job again. Its card is back.`);
    expect(calls.find((c) => c.table === "supplier_invoices" && c.verb === "update")?.payload).toEqual({ job_id: null });
  });

  it("hands back the database's own refusal when an invoice claimed it in between (0278)", async () => {
    state.client = fakeSupabase(
      {
        "profiles.select": [STAFF],
        "bill_supplier_invoices.select": [OK([{ bill_id: "bill-new" }])],
        "bills.select": [BILL, OK({ id: "bill-new", amount: "301.81", on_shelf: false, bill_line_items: [] }), OK([])],
        "invoice_items.select": [OK([])],
        "organized_items.select": [OK([])],
        "bills.delete": [{ data: null, error: { code: "P0001", message: "INV-078 already bills this receipt. Void that invoice, or take its materials lines off, then delete this receipt." } }],
      },
      calls,
    );
    const res = await undoFileSupplierPaper(TOKEN);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("INV-078 already bills this receipt.");
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("touches nothing when the paper is tied to a different bill (a client's token deletes nothing)", async () => {
    state.client = fakeSupabase(
      { "profiles.select": [STAFF], "bill_supplier_invoices.select": [OK([{ bill_id: "someone-elses" }])], "bills.select": [BILL] },
      calls,
    );
    const res = await undoFileSupplierPaper(TOKEN);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("isn't tied to that bill anymore");
    expect(calls.some((c) => c.verb === "delete")).toBe(false);
  });
});
