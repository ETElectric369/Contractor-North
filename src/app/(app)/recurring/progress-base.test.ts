import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, failingReads, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";
import { everythingBillable } from "@/lib/everything-billable";

/**
 * PART OF THE ESTIMATE: THE DOOR BILLS A PERCENT OF THE FIGURE THE SHEET SHOWS (cn-v1181, lane S).
 * The New Invoice sheet's "Percent of what is left" reads lib/everything-billable's partLeftGross; the
 * door that writes the part (createProgressInvoice) worked out its own base, so a discount on a sent
 * bill, an approved deduct, or a taxed estimate billed with no tax made the two disagree. These cases
 * bill 100% so the draft's figure IS the base; the stand-in honours filters and select lists, so a door
 * that forgot a column (a line's line_kind, a change order's amount) reads nothing, as on the database.
 * Stand-ins only: J-900 Larkspur, INV-900 and on.
 */
const ctx = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: ctx.client, userId: "user-1", orgId: "org-larkspur" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/invoice-recalc", () => ({ recalcInvoice: async () => true }));
vi.mock("@/lib/invoice-due", () => ({ defaultDueDateIsoForOrg: async () => "2026-12-22T20:00:00.000Z" }));

import { createProgressInvoice } from "./actions";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];

const quote = (over: Row = {}): Row => ({ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", subtotal: 5000, tax: 0, total: 5000, created_at: "2026-10-01T00:00:00Z", ...over });
const sent = (id: string, total: number, over: Row = {}): Row => ({
  id, org_id: ORG, job_id: JOB, invoice_kind: "standard", status: "sent", invoice_number: id.toUpperCase(), subtotal: total, tax: 0, total, amount_paid: 0, created_at: "2026-11-01T00:00:00Z", ...over,
});
const line = (invoice_id: string, line_total: number, over: Row = {}): Row => ({ id: `${invoice_id}-${line_total}-${Math.random()}`, org_id: ORG, invoice_id, line_total, import_source: null, line_kind: null, ...over });

beforeEach(() => {
  writes = [];
  db = { jobs: [{ id: JOB, org_id: ORG, customer_id: "cust-900", name: "Larkspur Rewire" }], quotes: [quote()], change_orders: [], invoices: [], invoice_items: [], payment_milestones: [], org_settings: [] };
  ctx.client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

const part = (pct = 100) => createProgressInvoice(JOB, { kind: "progress", mode: "percent", value: pct });
const made = () => writes.filter((w) => w.table === "invoices" && w.verb === "insert").map((w) => w.payload);
/** What the sheet shows as the base, from the same rows (the rule the page reads). */
const sheet = () =>
  everythingBillable({
    quotes: db.quotes,
    changeOrders: db.change_orders.filter((c) => c.job_id === JOB) as any,
    invoices: db.invoices.map((i) => {
      const ls = db.invoice_items.filter((l) => l.invoice_id === i.id);
      return {
        ...i,
        discount: ls.filter((l) => l.line_kind === "discount").reduce((t, l) => t + l.line_total, 0),
        prepaidCredit: ls.filter((l) => l.import_source === "prepaid_credit").reduce((t, l) => t + l.line_total, 0),
      } as any;
    }),
  })!.partLeftGross;

describe("the plain cases: the base is what it always was", () => {
  const table: [string, () => void, number][] = [
    ["nothing billed", () => {}, 5000],
    ["one sent bill", () => db.invoices.push(sent("inv-900", 2000)), 3000],
    ["a void bill is not billing", () => db.invoices.push(sent("inv-901", 1000, { status: "void" })), 5000],
    [
      "a taxed estimate billed with its tax",
      () => {
        db.quotes[0] = quote({ subtotal: 10000, tax: 725, total: 10725 });
        db.invoices.push(sent("inv-900", 4290, { subtotal: 4000, tax: 290 }));
      },
      6435,
    ],
    [
      "a paid request and a draw that took it off",
      () => {
        db.invoices.push(sent("inv-900", 1000, { invoice_kind: "prepayment", status: "paid", amount_paid: 1000 }), sent("inv-901", 1500, { invoice_kind: "progress" }));
        db.invoice_items.push(line("inv-901", 2500), line("inv-901", -1000, { import_source: "prepaid_credit", line_kind: "credit" }));
      },
      2500,
    ],
    [
      "a taxed estimate, a paid request and a draw that took it off",
      () => {
        db.quotes[0] = quote({ subtotal: 10000, tax: 725, total: 10725 });
        db.invoices.push(sent("inv-900", 1000, { invoice_kind: "prepayment", status: "paid", amount_paid: 1000 }), sent("inv-901", 2000, { invoice_kind: "progress" }));
        db.invoice_items.push(line("inv-901", 3000), line("inv-901", -1000, { import_source: "prepaid_credit", line_kind: "credit" }));
      },
      7725,
    ],
    ["an unpaid request alone is not work", () => db.invoices.push(sent("inv-900", 1000, { invoice_kind: "prepayment" })), 5000],
  ];
  it.each(table)("%s", async (_name, seed, base) => {
    seed();
    const r = await part();
    expect(r.ok).toBe(true);
    expect(made()).toHaveLength(1);
    expect(made()[0]).toMatchObject({ subtotal: base, total: base, invoice_kind: "progress" });
    expect(sheet()).toBe(base);
  });

  it("a percent is a percent of that base", async () => {
    db.invoices.push(sent("inv-900", 2000));
    expect((await part(25)).ok).toBe(true);
    expect(made()[0]).toMatchObject({ subtotal: 750 });
  });
});

describe("where the old base was larger than the sheet's", () => {
  it("a discount given on a sent bill is not billed again as a part", async () => {
    db.invoices.push(sent("inv-900", 1500));
    db.invoice_items.push(line("inv-900", 2000), line("inv-900", -500, { line_kind: "discount" }));
    expect((await part()).ok).toBe(true);
    expect(made()[0]).toMatchObject({ subtotal: 3000 });
    expect(sheet()).toBe(3000);
  });

  it("an approved deduct change order comes off; a pending one and another job's do not", async () => {
    db.change_orders.push(
      { id: "co-1", org_id: ORG, job_id: JOB, co_number: "CO-1", description: "Deduct", amount: -500, status: "approved" },
      { id: "co-2", org_id: ORG, job_id: JOB, co_number: "CO-2", description: "Pending", amount: -700, status: "pending" },
      { id: "co-3", org_id: ORG, job_id: "job-901", co_number: "CO-3", description: "Snowbell", amount: -900, status: "approved" },
    );
    expect((await part()).ok).toBe(true);
    expect(made()[0]).toMatchObject({ subtotal: 4500 });
    expect(sheet()).toBe(4500);
  });

  it("a taxed estimate billed with no tax does not offer the tax as work", async () => {
    db.quotes[0] = quote({ subtotal: 10000, tax: 725, total: 10725 });
    db.invoices.push(sent("inv-900", 4000, { subtotal: 4000, tax: 0 }));
    expect((await part()).ok).toBe(true);
    expect(made()[0]).toMatchObject({ subtotal: 6435 });
    expect(sheet()).toBe(6435);
  });
});

describe("refusals", () => {
  it.each(["quotes", "change_orders", "invoices"])("a failed read of %s is never 'nothing billed': nothing is made", async (table) => {
    db.invoices.push(sent("inv-900", 2000));
    ctx.client = failingReads(ctx.client, table);
    const r = await part();
    expect(r).toEqual({ ok: false, error: "The job's estimate and bills couldn't be read, so nothing was made. Try again." });
    expect(made()).toHaveLength(0);
  });

  it("percent with nothing left says why, and makes nothing", async () => {
    db.invoices.push(sent("inv-900", 1500));
    db.invoice_items.push(line("inv-900", 2000), line("inv-900", -500, { line_kind: "discount" }));
    db.invoices.push(sent("inv-901", 3000));
    const r = await part(50);
    expect(r).toEqual({ ok: false, error: "Nothing of the estimate is left to bill as a part: its sent bills already cover it. Nothing was made." });
    expect(made()).toHaveLength(0);
  });

  it("no estimate: the sentence it always said", async () => {
    db.quotes = [];
    expect(await part()).toEqual({ ok: false, error: "Add a quote/estimate to bill a percentage — or bill a fixed amount." });
  });

  it("a fixed amount is the person's own figure, uncapped, as before", async () => {
    db.invoices.push(sent("inv-900", 1500));
    db.invoice_items.push(line("inv-900", 2000), line("inv-900", -500, { line_kind: "discount" }));
    const r = await createProgressInvoice(JOB, { kind: "progress", mode: "fixed", value: 9000 });
    expect(r.ok).toBe(true);
    expect(made()[0]).toMatchObject({ subtotal: 9000 });
  });
});
