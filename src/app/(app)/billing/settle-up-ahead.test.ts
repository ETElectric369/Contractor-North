import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, failingReads, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * SETTLE UP ON A JOB WITH MONEY ALREADY PAID AHEAD (cn-v1177). The no-open-bill branch is reached only
 * when every live payment request on the job is paid in full. The settle-up bill then carries the work
 * it settles: the typed figure PLUS what the requests still have to come off; the recalc's sync takes
 * each request off; the bill comes to the typed figure exactly, is sent and paid by it. With no money
 * ahead it writes exactly what it always wrote. On the small in-memory database
 * (lib/prepayment-db.test-util): what is read back is what the door wrote. Stand-ins only.
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
// What follows a payment: the recalc (the real one), and nothing else here.
vi.mock("@/lib/after-payment-landed", async () => {
  const { recalcInvoice } = await import("@/lib/invoice-recalc");
  return { afterPaymentLanded: vi.fn(async (sb: any, o: { invoiceId: string }) => recalcInvoice(sb, o.invoiceId)) };
});

import { settleUp } from "./actions";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];
const seq = { n: 0 };

/** A payment request, paid in full (so it is not an open bill). */
const paidRequest = (id: string, amount: number, created_at: string): { inv: Row; line: Row } => ({
  inv: { id, org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "prepayment", status: "paid", title: "Deposit", invoice_number: id.toUpperCase(), tax_rate: 0, subtotal: amount, total: amount, amount_paid: amount, created_at },
  line: { id: `${id}-line`, org_id: ORG, invoice_id: id, description: "Deposit", quantity: 1, unit_price: amount, line_total: amount, import_source: "prepayment", prepaid_invoice_id: null, sort_order: 0 },
});

beforeEach(() => {
  writes = [];
  seq.n = 100;
  db = {
    jobs: [{ id: JOB, org_id: ORG, name: "Larkspur panel", job_number: "J-900", customer_id: "cust-1", inquiry_id: null, status: "in_progress" }],
    organizations: [{ id: ORG, settings: {} }],
    invoices: [],
    invoice_items: [],
    customer_credits: [],
    payments: [],
  };
  state.client = fakeDb(db, { org: ORG, writes, seq });
});

const settle = (amount: number) => settleUp({ source: "job", id: JOB, amount, method: "cash" });
const theBill = () => db.invoices.find((i) => i.invoice_kind === "standard")!;
const linesOf = (id: string) => db.invoice_items.filter((l) => l.invoice_id === id);

describe("settleUp with money paid ahead", () => {
  it("a paid 500 request and a typed 300: one bill, its line 800, the request taken off (-500), total 300, paid 300", async () => {
    const r = paidRequest("inv-900", 500, "2026-10-01T00:00:00Z");
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    const res = await settle(300);
    expect(res).toMatchObject({ ok: true });
    expect(db.invoices.filter((i) => i.invoice_kind === "standard")).toHaveLength(1);
    const bill = theBill();
    expect(linesOf(bill.id).map((l) => [l.import_source ?? null, l.line_total, l.prepaid_invoice_id ?? null])).toEqual([
      [null, 800, null],
      ["prepaid_credit", -500, "inv-900"],
    ]);
    expect(bill).toMatchObject({ total: 300, amount_paid: 300, status: "paid" });
    expect(db.payments.map((p) => p.amount)).toEqual([300]);
    // The request shows its 500 taken, by this bill.
    const { readPrepaymentStates } = await import("@/lib/payment-request");
    const [s] = await readPrepaymentStates(state.client, JOB);
    expect(s).toMatchObject({ takenTotal: 500, left: 0, moneyLeft: 0 });
    expect(s.taken).toEqual([{ invoiceId: bill.id, amount: 500 }]);
  });

  it("two paid requests come off, oldest first; the bill still comes to what they paid", async () => {
    for (const r of [paidRequest("inv-900", 500, "2026-10-01T00:00:00Z"), paidRequest("inv-901", 250, "2026-10-05T00:00:00Z")]) {
      db.invoices.push(r.inv);
      db.invoice_items.push(r.line);
    }
    expect(await settle(100)).toMatchObject({ ok: true });
    const bill = theBill();
    expect(linesOf(bill.id).map((l) => [l.line_total, l.prepaid_invoice_id ?? null])).toEqual([
      [850, null],
      [-500, "inv-900"],
      [-250, "inv-901"],
    ]);
    expect(bill).toMatchObject({ total: 100, amount_paid: 100, status: "paid" });
  });

  it("a request an earlier bill already took part of: only what is left comes off", async () => {
    const r = paidRequest("inv-900", 500, "2026-10-01T00:00:00Z");
    db.invoices.push(r.inv, { id: "inv-899", org_id: ORG, job_id: JOB, invoice_kind: "standard", status: "paid", invoice_number: "INV-899", total: 0, amount_paid: 0, created_at: "2026-10-02T00:00:00Z" });
    db.invoice_items.push(r.line, { id: "old-credit", org_id: ORG, invoice_id: "inv-899", quantity: 1, unit_price: -200, line_total: -200, import_source: "prepaid_credit", prepaid_invoice_id: "inv-900" });
    expect(await settle(300)).toMatchObject({ ok: true });
    const bill = db.invoices.find((i) => i.invoice_kind === "standard" && i.id !== "inv-899")!;
    expect(linesOf(bill.id).map((l) => l.line_total)).toEqual([600, -300]);
    expect(bill).toMatchObject({ total: 300, amount_paid: 300, status: "paid" });
  });

  it("no money ahead: the one line is the typed figure, nothing else is written on the bill (as before)", async () => {
    expect(await settle(300)).toMatchObject({ ok: true });
    const bill = theBill();
    expect(linesOf(bill.id)).toHaveLength(1);
    expect(writes.filter((w) => w.table === "invoice_items" && w.verb === "insert").map((w) => w.payload)).toEqual([
      { invoice_id: bill.id, description: "Larkspur panel", quantity: 1, unit: "EA", unit_price: 300, sort_order: 0 },
    ]);
    expect(bill).toMatchObject({ total: 300, amount_paid: 300, status: "paid" });
  });

  it("a failed read of the job's requests writes nothing", async () => {
    const r = paidRequest("inv-900", 500, "2026-10-01T00:00:00Z");
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    state.client = failingReads(state.client, "customer_credits");
    const res = await settle(300);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Couldn't read this job's payment requests");
    expect(writes).toEqual([]);
  });

  it("the job path with an unpaid request: the payment lands on the request, no bill is minted (unchanged)", async () => {
    const r = paidRequest("inv-900", 1000, "2026-10-01T00:00:00Z");
    r.inv.status = "sent";
    r.inv.amount_paid = 0;
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    expect(await settle(1000)).toMatchObject({ ok: true, invoiceId: "inv-900" });
    expect(db.invoices.filter((i) => i.invoice_kind === "standard")).toHaveLength(0);
    expect(db.payments.map((p) => [p.invoice_id, p.amount])).toEqual([["inv-900", 1000]]);
  });

  it("a bill that does not come to what they paid is left a draft: not sent, nothing recorded, its id handed back", async () => {
    const r = paidRequest("inv-900", 500, "2026-10-01T00:00:00Z");
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    // The request is voided between the read and the recalc: nothing comes off, the bill reads 800.
    const base = state.client;
    state.client = {
      ...base,
      from: (t: string) => {
        if (t === "invoice_items" && db.invoices.some((i) => i.invoice_kind === "standard")) {
          const req = db.invoices.find((i) => i.id === "inv-900");
          if (req) req.status = "void";
        }
        return base.from(t);
      },
    };
    const res = await settle(300);
    expect(res.ok).toBe(false);
    const bill = theBill();
    expect(res).toMatchObject({ invoiceId: bill.id });
    expect(res.error).toMatch(/doesn't come to the \$300\.00 they paid/);
    expect(bill.status).toBe("draft");
    expect(db.payments).toEqual([]);
  });
});

describe("a payment on a draft that the send lowers (skeptic #80, F8)", () => {
  it("the send takes a paid request off; the typed amount is now more than the bill asks: refused, never cut down, nothing recorded", async () => {
    const r = paidRequest("inv-900", 400, "2026-10-01T00:00:00Z");
    db.invoices.push(r.inv, {
      id: "inv-901", org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "standard", status: "draft", title: "Larkspur panel",
      invoice_number: "INV-901", tax_rate: 0, subtotal: 1000, total: 1000, amount_paid: 0, created_at: "2026-10-02T00:00:00Z",
    });
    db.invoice_items.push(r.line, { id: "w1", org_id: ORG, invoice_id: "inv-901", description: "Labor", quantity: 1, unit_price: 1000, line_total: 1000, import_source: "labor", prepaid_invoice_id: null, sort_order: 0 });
    // Paid in full as it read before the send (a stale $1,000): the person said yes to sending it.
    const res = await settleUp({ source: "job", id: JOB, amount: 1000, method: "cash", sendIt: true });
    expect(res).toMatchObject({ ok: false, invoiceId: "inv-901" });
    expect(res.error).toBe("INV-901 has $600.00 left, less than the $1,000.00 they paid. Record $600.00 on INV-901, then put the rest on a new invoice.");
    expect(db.payments).toEqual([]);
  });
});

describe("a visit's Get Paid on a job with a payment request (source appointment)", () => {
  const APPT = "appt-900";
  beforeEach(() => {
    db.appointments = [{ id: APPT, org_id: ORG, title: "Larkspur panel visit", status: "scheduled", customer_id: "cust-1", inquiry_id: null, job_id: JOB }];
  });
  const settleVisit = (amount: number) => settleUp({ source: "appointment", id: APPT, amount, method: "cash" });

  it("an UNPAID request is refused before anything is written, naming it and handing back its id", async () => {
    const r = paidRequest("inv-900", 1000, "2026-10-01T00:00:00Z");
    r.inv.status = "sent";
    r.inv.amount_paid = 0;
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    const res = await settleVisit(1000);
    expect(res).toMatchObject({ ok: false, invoiceId: "inv-900" });
    expect(res.error).toBe("INV-900 still asks for $1,000.00. Take this payment on INV-900.");
    expect(writes).toEqual([]);
    expect(db.payments).toEqual([]);
  });

  it("a part-paid request is refused for what it still asks", async () => {
    const r = paidRequest("inv-900", 1000, "2026-10-01T00:00:00Z");
    r.inv.status = "partial";
    r.inv.amount_paid = 400;
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    const res = await settleVisit(300);
    expect(res.error).toBe("INV-900 still asks for $600.00. Take this payment on INV-900.");
    expect(writes).toEqual([]);
  });

  it("another DRAFT on the job holding the request's credit: the bill going out comes first and takes it; the draft keeps what is left", async () => {
    const r = paidRequest("inv-900", 500, "2026-10-01T00:00:00Z");
    db.invoices.push(r.inv, {
      id: "inv-899", org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "standard", status: "draft", title: "Larkspur panel",
      invoice_number: "INV-899", tax_rate: 0, subtotal: 300, total: 300, amount_paid: 0, created_at: "2026-10-02T00:00:00Z",
    });
    db.invoice_items.push(
      r.line,
      { id: "d-work", org_id: ORG, invoice_id: "inv-899", description: "Labor", quantity: 1, unit_price: 800, line_total: 800, import_source: "labor", prepaid_invoice_id: null, sort_order: 0 },
      { id: "d-credit", org_id: ORG, invoice_id: "inv-899", description: "Less deposit (INV-900)", quantity: 1, unit_price: -500, line_total: -500, import_source: "prepaid_credit", prepaid_invoice_id: "inv-900", sort_order: 1 },
    );
    expect(await settleVisit(300)).toMatchObject({ ok: true });
    const bill = db.invoices.find((i) => i.invoice_kind === "standard" && i.id !== "inv-899")!;
    expect(linesOf(bill.id).map((l) => [l.line_total, l.prepaid_invoice_id ?? null])).toEqual([
      [800, null],
      [-500, "inv-900"],
    ]);
    expect(bill).toMatchObject({ total: 300, amount_paid: 300, status: "paid" });
    expect(linesOf("inv-899").filter((l) => l.import_source === "prepaid_credit")).toEqual([]);
  });

  it("a PAID request: one bill, the request taken off, the bill paid by the typed figure", async () => {
    const r = paidRequest("inv-900", 500, "2026-10-01T00:00:00Z");
    db.invoices.push(r.inv);
    db.invoice_items.push(r.line);
    expect(await settleVisit(300)).toMatchObject({ ok: true });
    expect(db.invoices.filter((i) => i.invoice_kind === "standard")).toHaveLength(1);
    const bill = theBill();
    expect(bill.appointment_id).toBe(APPT);
    expect(linesOf(bill.id).map((l) => [l.line_total, l.prepaid_invoice_id ?? null])).toEqual([
      [800, null],
      [-500, "inv-900"],
    ]);
    expect(bill).toMatchObject({ total: 300, amount_paid: 300, status: "paid" });
  });
});
