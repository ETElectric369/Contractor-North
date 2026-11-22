import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * GET PAID ON A JOB SAYS WHAT IT DID (cn-v1179, decision E: "the result names the bill and what happened to
 * the job"). settleUp hands back `landed`: the bill that took the money (made just now or not; a payment
 * request said as one), and what became of the job, read off the paid gate's own verdict, through the REAL
 * recalc, the real paid gate and the real fixed-price rule. Only the bell, Google and the caches are
 * stand-ins. The money-safety behaviours are pinned beside it (actions.test, settle-up-ahead.test) and are
 * re-checked here where the result touches them: a re-tap records once and says so.
 *
 * On lib/prepayment-db.test-util (filters honoured; invoices and quotes projected to their select lists).
 */
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-larkspur", role: "owner" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })), createNotifications: vi.fn(async () => true) }));
vi.mock("@/lib/push", () => ({ orgStaffIds: vi.fn(async () => ["user-1", "office-2"]), sendPushToProfiles: vi.fn(async () => {}), orgStaffIdsOrThrow: vi.fn(async () => ["user-1"]) }));
const work = vi.hoisted(() => ({ hours: 0, total: 0 }));
vi.mock("@/lib/unbilled-work", async (orig) => ({
  ...(await orig<typeof import("@/lib/unbilled-work")>()),
  unbilledWorkForJob: async () => ({
    hours: work.hours, laborAmount: work.total, laborByPerson: [], billsAmount: 0, excluded: 0, billsCount: 0, markupPct: 0.11,
    billsBilled: 0, returnsAmount: 0, returnsCount: 0, returnsCredit: 0, stockCount: 0, stockAmount: 0,
    stockBilled: 0, stockShorts: 0, stockShortsWords: null, stockNoCostWords: null, total: work.total,
    lastInvoiceNumber: null, lastInvoiceAt: null, lastInvoiceStatus: null, poCoveredBills: 0,
    claimedCount: 0, claimedOn: [], schemaReady: true, rows: [],
  }),
  fixedBillingsNotYetNetted: async () => 0,
}));

import { settleUp } from "./actions";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];

beforeEach(() => {
  work.hours = 0;
  work.total = 0;
  writes = [];
  db = {
    jobs: [{ id: JOB, org_id: ORG, name: "Larkspur Rewire", job_number: "J-900", customer_id: "cust-1", inquiry_id: null, status: "in_progress", billing_type: "fixed", customers: { name: "Sam Tillery" } }],
    organizations: [{ id: ORG, settings: {} }],
    quotes: [],
    invoices: [],
    invoice_items: [],
    customer_credits: [],
    payments: [],
    payment_milestones: [],
    tasks: [],
  };
  state.client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

const cash = (amount: number) => settleUp({ source: "job", id: JOB, amount, method: "cash" });
const sentBill = (id: string, total: number, over: Row = {}): Row => ({
  id, org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "standard", status: "sent", title: "Larkspur Rewire", invoice_number: id.toUpperCase(), tax_rate: 0, subtotal: total, total, amount_paid: 0, created_at: "2026-10-02T00:00:00Z", ...over,
});
const line = (invoiceId: string, amount: number, over: Row = {}): Row => ({ id: `${invoiceId}-l`, org_id: ORG, invoice_id: invoiceId, description: "Work", quantity: 1, unit_price: amount, line_total: amount, import_source: null, prepaid_invoice_id: null, sort_order: 0, ...over });

describe("settleUp says which bill took the money, and what became of the job", () => {
  it("row 7, end to end: a fixed price of $5,000, no bill, $2,000 cash: a bill MADE just now takes it, and the job stays open (price not all billed)", async () => {
    db.quotes.push({ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", total: 5000, created_at: "2026-10-01T00:00:00Z" });
    const r = await cash(2000);
    expect(r.ok).toBe(true);
    const made = db.invoices.find((i) => i.invoice_kind === "standard")!;
    expect(r.landed).toEqual({ number: made.invoice_number, made: true, request: false, draft: false, job: "price" });
    expect(made).toMatchObject({ total: 2000, amount_paid: 2000, status: "paid" });
    expect(db.jobs[0].status).toBe("in_progress");
  });

  it("row 11: the job's one open sent bill takes a part payment: named, not made here, the job as it was", async () => {
    db.invoices.push(sentBill("inv-900", 1250));
    db.invoice_items.push(line("inv-900", 1250));
    const r = await cash(500);
    expect(r).toMatchObject({ ok: true, invoiceId: "inv-900" });
    expect(r.landed).toEqual({ number: "INV-900", made: false, request: false, draft: false, job: "untouched" });
  });

  it("row 11, paid in full on a fixed job with no accepted estimate: the job is finished, and said", async () => {
    db.invoices.push(sentBill("inv-900", 1250));
    db.invoice_items.push(line("inv-900", 1250));
    const r = await cash(1250);
    expect(r.landed).toEqual({ number: "INV-900", made: false, request: false, draft: false, job: "finished" });
    expect(db.jobs[0].status).toBe("complete");
  });

  it("a job that hasn't started: the bill is paid off, the job stays open, and that is said", async () => {
    db.jobs[0].status = "scheduled";
    const r = await cash(300);
    expect(r.landed).toMatchObject({ made: true, job: "not_started" });
    expect(db.jobs[0].status).toBe("scheduled");
  });

  it("row 6: time and material, recorded work on no bill, $300 typed: a bill made for the figure, the job open with work still to bill", async () => {
    db.jobs[0].billing_type = "tm";
    work.hours = 6.5;
    work.total = 812.4;
    const r = await cash(300);
    expect(r.landed).toMatchObject({ made: true, job: "work" });
    expect(db.jobs[0].status).toBe("in_progress");
  });

  it("row 15: an unpaid payment request is the only open bill: the payment lands on it and is said as a payment request", async () => {
    db.invoices.push(sentBill("inv-900", 1000, { invoice_kind: "prepayment", title: "Deposit" }));
    db.invoice_items.push(line("inv-900", 1000, { import_source: "prepayment" }));
    const r = await cash(1000);
    expect(r).toMatchObject({ ok: true, invoiceId: "inv-900" });
    expect(r.landed).toEqual({ number: "INV-900", made: false, request: true, draft: false, job: "untouched" });
  });

  it("row 17: money paid ahead, no open bill: the bill made now takes it off and is said as made", async () => {
    db.invoices.push(sentBill("inv-900", 500, { invoice_kind: "prepayment", title: "Deposit", status: "paid", amount_paid: 500, created_at: "2026-10-01T00:00:00Z" }));
    db.invoice_items.push(line("inv-900", 500, { import_source: "prepayment" }));
    const r = await cash(300);
    const made = db.invoices.find((i) => i.invoice_kind === "standard")!;
    expect(r.landed).toMatchObject({ number: made.invoice_number, made: true, request: false });
    expect(made).toMatchObject({ total: 300, amount_paid: 300 });
  });

  it("the same tap twice: one payment, and the second answer says it was already recorded", async () => {
    // The stand-in stamps its rows on 2026-11-01 00:00:NN; the clock is set a minute after, so the
    // five-minute same-tap window sees the first payment as the moment ago it is.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:03:00Z"));
    try {
      db.invoices.push(sentBill("inv-900", 1250));
      db.invoice_items.push(line("inv-900", 1250));
      await cash(500);
      const again = await cash(500);
      expect(again).toMatchObject({ ok: true, invoiceId: "inv-900" });
      expect(again.landed).toMatchObject({ again: true });
      expect(db.payments).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the card door (collect later) records nothing and says nothing of a payment", async () => {
    db.invoices.push(sentBill("inv-900", 1250));
    db.invoice_items.push(line("inv-900", 1250));
    const r = await settleUp({ source: "job", id: JOB, amount: 0, method: "card", collect: "later" });
    expect(r).toMatchObject({ ok: true, invoiceId: "inv-900" });
    expect(r.landed).toBeUndefined();
    expect(db.payments).toEqual([]);
  });
});
