import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE THREE MONEY DOORS ON THE SUPPLIER CARD, PINNED (review of cn-v951..v966, 2026-09-20).
 *
 * Every fixture below is Erik's own data. The $95.27 CED ticket really is filed on two jobs, both
 * copies really are on invoices the customer has already paid, and the duplicate picker really is
 * the button that sets one aside. What these tests hold down is not the arithmetic - that lives in
 * supplier-balance and is tested there - but the SENTENCES and the ROLLBACKS: what the server says
 * happened, and what it takes back when a race beats it.
 *
 * The fake PostgREST builder is the one purchasing/actions.test.ts uses, widened for the verbs
 * these actions chain. Unscripted calls throw, so a test also pins WHICH statements run: if a fix
 * quietly adds a read against a man's books, a test here goes red rather than green.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import {
  linkBillsBySupplierText,
  recordSupplierInvoiceAsBill,
  resolveDuplicateBill,
  setSupplierInvoiceJob,
} from "./supplier-actions";

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

/** Staff, in an org. Every action in this file starts here. */
const STAFF = { data: { role: "owner", org_id: "org-1", active: true }, error: null };

// His real rows: one CED ticket, $95.27, eight lines, filed on two jobs.
const NORTHWOODS_COPY = "8ce93d0a-d2ce-46a9-a857-2c7070224246";
const WHITNEY_COPY = "31b489e4-743b-4208-9742-7fb4005c642c";
const GROUP = `dup:${JSON.stringify([NORTHWOODS_COPY, WHITNEY_COPY])}`;

let calls: Call[];
beforeEach(() => { calls = []; });

describe("resolveDuplicateBill - setting a copy aside says what it costs", () => {
  /** The keeper, the supersede, and the link move. The claim read is scripted per test. */
  const script = (claimRows: any[] | null, over: Record<string, any[]> = {}) => ({
    "profiles.select": [STAFF],
    "bills.select": [{ data: { id: WHITNEY_COPY, amount: "95.27", job_id: "job-whitney", jobs: { name: "85 Whitney Place" } }, error: null }],
    "bills.update": [{ data: [{ id: NORTHWOODS_COPY, job_id: "job-northwoods", jobs: { name: "13631 Northwoods" } }], error: null }],
    "bill_supplier_invoices.update": [{ data: [], error: null }],
    "invoice_items.select": [{ data: claimRows, error: null }],
    ...over,
  });

  it("names the paid invoice the set-aside copy is on, and the door back", async () => {
    // INV-050 (paid) claims the Northwoods copy through source_ids - his real row, five bill ids
    // on one line. The cost stops counting; the $119.09 the customer was charged does not.
    state.client = fakeSupabase(
      script([
        { import_key: null, source_ids: [NORTHWOODS_COPY, "7cf0c30a-48b4-4748-9b2c-8e53151ab7ba"], invoices: { invoice_number: "INV-050", status: "paid", job_id: "job-northwoods" } },
      ]),
      calls,
    );

    const res = await resolveDuplicateBill({ groupId: GROUP, keepBillId: WHITNEY_COPY, duplicateBillIds: [NORTHWOODS_COPY] });

    expect(res.ok).toBe(true);
    expect(res.message).toContain("Kept the $95.27 ticket on 85 Whitney Place.");
    expect(res.message).toContain("already billed to the customer on INV-050");
    expect(res.message).toContain("the cost stops counting, but what you charged for it does not");
    // NO DEAD ENDS: Credit / Refund is the literal label in the Actions menu on the invoice.
    expect(res.message).toContain("Credit / Refund in the Actions menu on the invoice");
    expect(res.message).not.toContain("--");
  });

  it("moves the supplier's own invoice onto the copy that counts", async () => {
    // 0277 is unique on the INVOICE, so a link left on the set-aside copy could never be replaced -
    // and it would name a bill every cost reader ignores.
    state.client = fakeSupabase(script([]), calls);
    await resolveDuplicateBill({ groupId: GROUP, keepBillId: WHITNEY_COPY, duplicateBillIds: [NORTHWOODS_COPY] });

    const relink = calls.find((c) => c.table === "bill_supplier_invoices" && c.verb === "update");
    expect(relink?.payload).toEqual({ bill_id: WHITNEY_COPY });
  });

  it("says nothing extra when no invoice claims the copy", async () => {
    state.client = fakeSupabase(script([]), calls);
    const res = await resolveDuplicateBill({ groupId: GROUP, keepBillId: WHITNEY_COPY, duplicateBillIds: [NORTHWOODS_COPY] });
    expect(res.ok).toBe(true);
    expect(res.message).toBe(
      "Kept the $95.27 ticket on 85 Whitney Place. The copy on 13631 Northwoods stops counting against that job and stays on your bills list.",
    );
  });

  it("sends him to the draft itself when the claimant has not gone out yet", async () => {
    // A draft is not a bill he sent: its lines are still editable, so a credit would be the wrong
    // advice. Same split the receipt card and the invoice page both make.
    state.client = fakeSupabase(
      script([{ import_key: `bill:${NORTHWOODS_COPY}`, source_ids: null, invoices: { invoice_number: "INV-071", status: "draft", job_id: "job-northwoods" } }]),
      calls,
    );
    const res = await resolveDuplicateBill({ groupId: GROUP, keepBillId: WHITNEY_COPY, duplicateBillIds: [NORTHWOODS_COPY] });
    expect(res.message).toContain("INV-071, still a draft");
    expect(res.message).not.toContain("Credit / Refund");
  });

  it("still supersedes when the claim read fails, and never refuses over it", async () => {
    // The money is already right by then. A failed read costs him a sentence, not the decision.
    state.client = fakeSupabase(script(null, { "invoice_items.select": [{ data: null, error: { code: "42501", message: "permission denied" } }] }), calls);
    const res = await resolveDuplicateBill({ groupId: GROUP, keepBillId: WHITNEY_COPY, duplicateBillIds: [NORTHWOODS_COPY] });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("stops counting against that job");
  });

  it("says so when the link could not follow the cost", async () => {
    state.client = fakeSupabase(script([], { "bill_supplier_invoices.update": [{ data: null, error: { code: "42501", message: "permission denied" } }] }), calls);
    const res = await resolveDuplicateBill({ groupId: GROUP, keepBillId: WHITNEY_COPY, duplicateBillIds: [NORTHWOODS_COPY] });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("still tied to the copy you set aside");
  });
});

// ── RECORD IT AS A BILL, AND THE TAP THAT LOSES THE RACE ────────────────────────────────────────

const INVOICE_ID = "si-1104644";
const INV_ROW = {
  data: {
    id: INVOICE_ID,
    invoice_number: "8802-1104644",
    kind: "invoice",
    invoice_date: "2026-07-29",
    job_id: "job-whitney",
    supplier_account_id: "acct-ced",
    tax: 0,
    shipping: 0,
    total: "95.27",
    open_balance: "95.27",
    closed: false,
    supplier_accounts: { name: "CED Truckee" },
    jobs: { name: "85 Whitney Place", job_number: "J-028" },
  },
  error: null,
};

/** The reads every run of recordSupplierInvoiceAsBill makes before it writes anything. */
const recordScript = (over: Record<string, any[]> = {}) => ({
  "profiles.select": [STAFF],
  "supplier_invoices.select": [INV_ROW, { data: [{ id: INVOICE_ID, kind: "invoice", total: "95.27", open_balance: "95.27", closed: false }], error: null }],
  "bill_supplier_invoices.select": [{ data: [], error: null }],
  "bills.select": [{ data: [], error: null }],
  "supplier_invoice_lines.select": [{ data: [], error: null }],
  "bills.insert": [{ data: [{ id: "bill-new" }], error: null }],
  ...over,
});

const DUPLICATE_KEY = { code: "23505", message: "duplicate key value violates unique constraint" };

describe("recordSupplierInvoiceAsBill - the rollback after a lost race", () => {
  it("takes its own bill back out when another bill won the claim", async () => {
    state.client = fakeSupabase(
      recordScript({
        "bill_supplier_invoices.insert": [{ data: null, error: DUPLICATE_KEY }],
        "bill_supplier_invoices.select": [{ data: [], error: null }, { data: [{ bill_id: "bill-theirs" }], error: null }],
        "bills.delete": [{ data: [{ id: "bill-new" }], error: null }],
      }),
      calls,
    );

    const res = await recordSupplierInvoiceAsBill({ invoiceId: INVOICE_ID });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("8802-1104644 is already recorded as a bill. Reload the page and you'll see it.");
    expect(calls.some((c) => c.table === "bills" && c.verb === "delete")).toBe(true);
  });

  it("does NOT delete when the winning claim points at the bill this call just wrote", async () => {
    /**
     * The race this branch actually loses: the other tap took the join-only path and tied the
     * invoice to THIS bill (0276 permits no second live bill with this number). The old code
     * deleted it blind, and `bill_supplier_invoices.bill_id` is `on delete cascade` - so the
     * delete took the other tap's claim with it and left the invoice carrying no live bill at
     * all, after both screens had been told it worked.
     */
    state.client = fakeSupabase(
      recordScript({
        "bill_supplier_invoices.insert": [{ data: null, error: DUPLICATE_KEY }],
        "bill_supplier_invoices.select": [{ data: [], error: null }, { data: [{ bill_id: "bill-new" }], error: null }],
      }),
      calls,
    );

    const res = await recordSupplierInvoiceAsBill({ invoiceId: INVOICE_ID });
    expect(calls.some((c) => c.table === "bills" && c.verb === "delete")).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("8802-1104644 is a bill on 85 Whitney Place now: $95.27");
    // And it does not claim the tie failed: the tie exists, another tap wrote it.
    expect(res.message).not.toContain("didn't get tied");
  });

  it("says the second bill is still sitting there when the rollback removes no rows", async () => {
    // A zero-row delete is a 204. Reported as success it leaves the job carrying the cost twice
    // with nothing on any screen admitting it.
    state.client = fakeSupabase(
      recordScript({
        "bill_supplier_invoices.insert": [{ data: null, error: DUPLICATE_KEY }],
        "bill_supplier_invoices.select": [{ data: [], error: null }, { data: [{ bill_id: "bill-theirs" }], error: null }],
        "bills.delete": [{ data: [], error: null }],
      }),
      calls,
    );

    const res = await recordSupplierInvoiceAsBill({ invoiceId: INVOICE_ID });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("still sitting in Bills at $95.27");
    // NO DEAD ENDS: Delete is on the bill itself, which is a control that exists.
    expect(res.error).toContain("Delete it there");
  });

  it("takes it back out and says so when it cannot tell whose bill won", async () => {
    // A claim certainly exists - the unique index just said so. Leaving this bill behind would
    // double the job's cost silently; taking it out puts the invoice back on the list with a
    // button on it, which is the recoverable half of an unknowable pair.
    state.client = fakeSupabase(
      recordScript({
        "bill_supplier_invoices.insert": [{ data: null, error: DUPLICATE_KEY }],
        "bill_supplier_invoices.select": [{ data: [], error: null }, { data: null, error: { code: "42501", message: "permission denied" } }],
        "bills.delete": [{ data: [{ id: "bill-new" }], error: null }],
      }),
      calls,
    );

    const res = await recordSupplierInvoiceAsBill({ invoiceId: INVOICE_ID });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("taken back out");
    expect(res.error).toContain("Purchases Not In Your Books");
  });

  it("refuses instead of writing when it cannot read whether a bill already carries it", async () => {
    // This read is the one thing between a genuine second tap and a second bill for the same
    // money; its error used to be dropped, so a refused query read as "nothing found".
    state.client = fakeSupabase(
      recordScript({ "bill_supplier_invoices.select": [{ data: null, error: { code: "42501", message: "permission denied" } }] }),
      calls,
    );

    const res = await recordSupplierInvoiceAsBill({ invoiceId: INVOICE_ID });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Couldn't check whether 8802-1104644 is already in your books");
    expect(calls.some((c) => c.table === "bills" && c.verb === "insert")).toBe(false);
  });
});

// ── THE SPELLING THAT BELONGS TO SOMEBODY ELSE ──────────────────────────────────────────────────

describe("a refusal over a saved spelling names no button that does not exist", () => {
  it("says where the spelling is filed and what happened to the bills, and stops there", async () => {
    state.client = fakeSupabase(
      {
        "profiles.select": [STAFF],
        "supplier_accounts.select": [{ data: { id: "acct-truckee", name: "CED Truckee", on_account: true }, error: null }],
        "supplier_aliases.select": [{
          data: [{ id: "alias-1", alias: "Consolidated Electrical Dist.", supplier_account_id: "acct-sunnyvale", supplier_accounts: { name: "CED Sunnyvale" } }],
          error: null,
        }],
      },
      calls,
    );

    const res = await linkBillsBySupplierText({ supplier: "Consolidated Electrical Dist.", accountId: "acct-truckee" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('"Consolidated Electrical Dist." is already saved as a name for CED Sunnyvale, so these bills were left alone.');
    // The two doors this used to send him to - "take it off there", "file these bills one at a
    // time" - are removeSupplierAlias and linkBillToSupplierAccount, and NOTHING calls either.
    expect(res.error).not.toMatch(/take it off|one at a time/i);
    // And nothing was written on the way to the refusal.
    expect(calls.some((c) => c.verb !== "select")).toBe(false);
  });
});

// ── PUTTING AN INVOICE ON A JOB, AND WHETHER ITS COST HAS LANDED ────────────────────────────────

describe("setSupplierInvoiceJob - a set-aside copy is not 'in your books'", () => {
  const script = (links: any[]) => ({
    "profiles.select": [STAFF],
    "jobs.select": [{ data: { id: "job-whitney", name: "85 Whitney Place", job_number: "J-028" }, error: null }],
    "supplier_invoices.update": [{ data: [{ id: INVOICE_ID, invoice_number: "8802-1104644" }], error: null }],
    "bill_supplier_invoices.select": [{ data: links, error: null }],
  });

  it("still names the next step when the only bill carrying it was set aside", async () => {
    // Every cost reader in the app ignores a superseded bill, so "its bill is already in your
    // books" would be telling him a cost had landed on a job carrying none of it.
    state.client = fakeSupabase(script([{ bill_id: NORTHWOODS_COPY, bills: { superseded_by_bill_id: WHITNEY_COPY } }]), calls);
    const res = await setSupplierInvoiceJob({ invoiceId: INVOICE_ID, jobId: "job-whitney" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Record It As A Bill");
  });

  it("says the cost is already in his books when a live bill carries it", async () => {
    state.client = fakeSupabase(script([{ bill_id: WHITNEY_COPY, bills: { superseded_by_bill_id: null } }]), calls);
    const res = await setSupplierInvoiceJob({ invoiceId: INVOICE_ID, jobId: "job-whitney" });
    expect(res.message).toBe("8802-1104644 is on 85 Whitney Place now, and its bill is already in your books.");
  });
});
