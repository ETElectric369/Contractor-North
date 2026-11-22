import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, failingReads, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * WHAT THE JOB'S GET PAID SAYS WHEN IT OPENS (cn-v1179, decision E; the Get Paid scout's rows 6, 7, 11, 13,
 * 14, 15, 17, 18). readGetPaidFacts is one staff read: the job's open bills by the rule settleUp lands a
 * payment by, the work or the price not on a bill yet, and the money actually PAID ahead, only where it
 * comes off the bill the payment lands on.
 *
 * ON THE STAND-IN THAT HONOURS WHAT A READ ASKS (lib/prepayment-db.test-util): eq / neq / in / is filters
 * are applied, and `invoices` and `quotes` come back with only the columns their select list names (a read
 * that forgot invoice_kind would name no payment request here, as on the database). Other tables come back
 * whole. Stand-ins only: J-900 Larkspur, INV-900 and on.
 */
const state = vi.hoisted(() => ({ client: null as any, lang: "en", staff: true }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (state.staff ? { supabase: state.client, userId: "user-1", orgId: "org-larkspur", role: "owner" } : { error: "That's for the office." })),
}));
vi.mock("@/lib/lang-of", () => ({ callerLang: vi.fn(async () => state.lang) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
const work = vi.hoisted(() => ({ hours: 0, total: 0 }));
vi.mock("@/lib/unbilled-work", () => ({
  unbilledWorkForJob: async () => ({
    hours: work.hours, laborAmount: work.total, laborByPerson: [], billsAmount: 0, excluded: 0, billsCount: 0, markupPct: 0.11,
    billsBilled: 0, returnsAmount: 0, returnsCount: 0, returnsCredit: 0, stockCount: 0, stockAmount: 0,
    stockBilled: 0, stockShorts: 0, stockShortsWords: null, stockNoCostWords: null, total: work.total,
    lastInvoiceNumber: null, lastInvoiceAt: null, lastInvoiceStatus: null, poCoveredBills: 0,
    claimedCount: 0, claimedOn: [], schemaReady: true, rows: [],
  }),
  customerUnbilled: vi.fn(),
  fixedBillingsNotYetNetted: async () => 0,
  claimedSourcesOnJob: async () => ({}),
}));

import { readGetPaidFacts } from "./request-actions";
import { dict } from "@/lib/i18n";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];

const bill = (id: string, total: number, paid: number, over: Row = {}): Row => ({
  id, org_id: ORG, job_id: JOB, invoice_kind: "standard", status: paid >= total ? "paid" : "sent", invoice_number: id.toUpperCase(), total, amount_paid: paid, created_at: `2026-11-0${1 + (Number(id.slice(-1)) || 0)}T00:00:00Z`, ...over,
});
/** A payment request and its one line (lib/payment-request reads both). */
const request = (id: string, amount: number, paid: number): { inv: Row; line: Row } => ({
  inv: bill(id, amount, paid, { invoice_kind: "prepayment", title: "Deposit", created_at: "2026-10-01T00:00:00Z" }),
  line: { id: `${id}-line`, org_id: ORG, invoice_id: id, description: "Deposit", quantity: 1, unit_price: amount, line_total: amount, import_source: "prepayment", prepaid_invoice_id: null },
});

beforeEach(() => {
  state.lang = "en";
  state.staff = true;
  work.hours = 0;
  work.total = 0;
  writes = [];
  db = {
    jobs: [{ id: JOB, org_id: ORG, status: "in_progress", billing_type: "fixed", job_number: "J-900", name: "Larkspur Rewire" }],
    quotes: [],
    invoices: [],
    invoice_items: [],
    customer_credits: [],
    payments: [],
    payment_milestones: [],
  };
  state.client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

const facts = async () => {
  const f = await readGetPaidFacts(JOB);
  if (!f.ok) throw new Error(f.error);
  return f;
};

describe("readGetPaidFacts", () => {
  it("row 11: one open SENT bill is named with what is left, and nothing paid ahead is said over it", async () => {
    db.invoices.push(bill("inv-900", 1250, 0));
    const f = await facts();
    expect(f.open).toEqual([{ id: "inv-900", number: "INV-900", balance: 1250, draft: false, request: false }]);
    expect(f.owed).toEqual({ kind: "bills" });
    expect(f.paidAhead).toBe(0);
  });

  it("a DRAFT is named as a draft (the send-first question stays the payment door's)", async () => {
    db.invoices.push(bill("inv-900", 800, 0, { status: "draft" }));
    expect((await facts()).open).toEqual([{ id: "inv-900", number: "INV-900", balance: 800, draft: true, request: false }]);
  });

  it("row 15: an unpaid payment request alone is the open bill, NAMED as a request; money only asked is not said as paid ahead", async () => {
    const r = request("inv-900", 1000, 0);
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    const f = await facts();
    expect(f.open).toEqual([{ id: "inv-900", number: "INV-900", balance: 1000, draft: false, request: true }]);
    expect(f.paidAhead).toBe(0);
  });

  it("row 13: two open bills (a request and a bill for the work) are both listed, each with its own door", async () => {
    const r = request("inv-900", 500, 0);
    db.invoices.push(r.inv, bill("inv-901", 2000, 0));
    db.invoice_items.push(r.line);
    const f = await facts();
    expect(f.open.map((b) => [b.number, b.balance, b.request])).toEqual([
      ["INV-900", 500, true],
      ["INV-901", 2000, false],
    ]);
    expect(f.owed).toEqual({ kind: "bills" });
  });

  it("row 18: money PAID ahead and a sent open bill written before it: the sent bill takes nothing off, so nothing is said", async () => {
    const r = request("inv-900", 500, 500);
    db.invoices.push(r.inv, bill("inv-901", 2000, 0));
    db.invoice_items.push(r.line);
    const f = await facts();
    expect(f.open.map((b) => b.number)).toEqual(["INV-901"]);
    expect(f.paidAhead).toBe(0);
  });

  it("row 17: money paid ahead and no open bill: said, because the bill this payment writes takes it off", async () => {
    const r = request("inv-900", 500, 500);
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    const f = await facts();
    expect(f.open).toEqual([]);
    expect(f.paidAhead).toBe(500);
    expect(f.owed).toEqual({ kind: "nothing" });
  });

  describe("skeptic #82, S1: the paid-ahead line is said only where it is not already off the figure", () => {
    it("the PRICE state: what is left already counts the paid request as billed, so nothing is said over it", async () => {
      db.quotes.push({ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", total: 5000, created_at: "2026-10-01T00:00:00Z" });
      const r = request("inv-900", 1000, 1000);
      db.invoices.push(r.inv);
      db.invoice_items.push(r.line);
      const f = await facts();
      expect(f.owed).toEqual({ kind: "price", contract: 5000, billed: 1000, left: 4000 });
      expect(f.paidAhead).toBe(0);
    });

    it("ONE OPEN DRAFT: its balance is already net of its credit, so nothing is said over it", async () => {
      const r = request("inv-900", 500, 500);
      db.invoices.push(r.inv, bill("inv-901", 2000, 0, { status: "draft" }));
      db.invoice_items.push(r.line);
      const f = await facts();
      expect(f.open.map((b) => [b.number, b.draft])).toEqual([["INV-901", true]]);
      expect(f.paidAhead).toBe(0);
    });

    it("the T&M WORK state: the figure is gross and the bill settleUp writes takes it off, so it is still said", async () => {
      db.jobs[0].billing_type = "tm";
      work.hours = 6.5;
      work.total = 812.4;
      const r = request("inv-900", 500, 500);
      db.invoices.push(r.inv);
      db.invoice_items.push(r.line);
      const f = await facts();
      expect(f.owed).toEqual({ kind: "work", amount: 812.4 });
      expect(f.paidAhead).toBe(500);
    });
  });

  it("row 14: every bill paid, nothing left to bill: nothing is owed", async () => {
    db.invoices.push(bill("inv-900", 1250, 1250));
    expect(await facts()).toMatchObject({ open: [], owed: { kind: "nothing" }, paidAhead: 0 });
  });

  it("row 7: a fixed price not all billed, no open bill: the two figures and what is left (the job page's own)", async () => {
    db.quotes.push({ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", total: 5000, created_at: "2026-10-01T00:00:00Z" });
    db.invoices.push(bill("inv-900", 2000, 2000));
    expect((await facts()).owed).toEqual({ kind: "price", contract: 5000, billed: 2000, left: 3000 });
  });

  it("row 6: time and material, recorded work on no bill, no open bill: the billing step's own figure", async () => {
    db.jobs[0].billing_type = "tm";
    work.hours = 6.5;
    work.total = 812.4;
    expect((await facts()).owed).toEqual({ kind: "work", amount: 812.4 });
    work.hours = 0;
    work.total = 0;
    expect((await facts()).owed).toEqual({ kind: "nothing" });
  });

  it("another company's bill on the same job id is never listed (the company pin)", async () => {
    db.invoices.push(bill("inv-900", 1250, 0, { org_id: "org-other" }));
    expect((await facts()).open).toEqual([]);
  });

  it("a lost read is never 'nothing owed': said in the person's language", async () => {
    state.client = failingReads(state.client, "invoices");
    expect(await readGetPaidFacts(JOB)).toEqual({ ok: false, error: dict("en").su_gp_readFailed });
    state.lang = "es";
    expect(await readGetPaidFacts(JOB)).toEqual({ ok: false, error: dict("es").su_gp_readFailed });
  });

  it("a tech reaches nothing: staff only, nothing read", async () => {
    state.staff = false;
    expect(await readGetPaidFacts(JOB)).toEqual({ ok: false, error: "That's for the office." });
  });
});
