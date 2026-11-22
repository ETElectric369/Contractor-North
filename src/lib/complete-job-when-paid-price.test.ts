import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, failingReads, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * A FIXED-PRICE JOB IS NOT FINISHED BY A PAYMENT WHILE ITS PRICE IS NOT BILLED (cn-v1179, decision E,
 * the Get Paid scout's row 7). The billing step skips a fixed-price job, so a part payment on its one flat
 * bill used to finish it with the rest of the contract on no bill. The gate now asks the job page's own
 * figures (computeJobProgress: the accepted contract, and what went out on sent bills).
 *
 * ON THE STAND-IN THAT HONOURS WHAT A READ ASKS (lib/prepayment-db.test-util): every eq / neq / in / is
 * filter is applied, and a read of `invoices` or `quotes` comes back with ONLY the columns its select list
 * names, so a gate that forgot `total` or `status` would read nothing here, as it would on the database.
 * Stand-ins only: J-900 Larkspur, INV-900 and on.
 */
const calls = vi.hoisted(() => ({ pushed: [] as string[], reported: [] as string[] }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: async (_k: string, id: string) => void calls.pushed.push(id) }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string) => void calls.reported.push(where) }));
const work = vi.hoisted(() => ({ total: 0 }));
vi.mock("@/lib/unbilled-work", () => ({
  unbilledWorkForJob: async () => ({
    hours: 0, laborAmount: 0, laborByPerson: [], billsAmount: 0, excluded: 0, billsCount: 0, markupPct: 0.11,
    billsBilled: 0, returnsAmount: 0, returnsCount: 0, returnsCredit: 0, stockCount: 0, stockAmount: 0,
    stockBilled: 0, stockShorts: 0, stockShortsWords: null, stockNoCostWords: null, total: work.total,
    lastInvoiceNumber: null, lastInvoiceAt: null, lastInvoiceStatus: null, poCoveredBills: 0,
    claimedCount: 0, claimedOn: [], schemaReady: true, rows: [],
  }),
  fixedBillingsNotYetNetted: async () => 0,
  claimedSourcesOnJob: async () => ({}),
}));

import { completeJobWhenPaid } from "./complete-job-when-paid";
import { priceLeftToBill } from "./finish-bills-first";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];
let client: any;

const job = (over: Row = {}): Row => ({ id: JOB, org_id: ORG, status: "in_progress", billing_type: "fixed", job_number: "J-900", name: "Larkspur Rewire", customers: { name: "Sam Tillery" }, ...over });
const quote = (over: Row = {}): Row => ({ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", total: 5000, created_at: "2026-10-01T00:00:00Z", ...over });
const bill = (id: string, total: number, over: Row = {}): Row => ({
  id, org_id: ORG, job_id: JOB, invoice_kind: "standard", status: "paid", invoice_number: id.toUpperCase(), total, amount_paid: total, created_at: "2026-11-01T00:00:00Z", ...over,
});

beforeEach(() => {
  calls.pushed.length = 0;
  calls.reported.length = 0;
  work.total = 0;
  writes = [];
  db = { jobs: [job()], quotes: [quote()], change_orders: [], invoices: [], invoice_items: [], tasks: [], customer_credits: [], payments: [], payment_milestones: [] };
  client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

const paid = (id: string) => completeJobWhenPaid(client, id, { kind: "staff" });

describe("the fixed-price gate", () => {
  it("(a) a flat part payment, price not all billed: the job stays open, and the office is told the figures", async () => {
    db.invoices.push(bill("inv-900", 2000));
    const r = await paid("inv-900");
    expect(r.completed).toBe(false);
    expect(r).toMatchObject({ open: "price", sayTitle: "Still to bill", jobId: JOB });
    expect(r.say).toBe("Larkspur Rewire · J-900 — Sam Tillery was paid, but its price isn't all billed yet: $5,000.00 agreed, $2,000.00 billed, $3,000.00 still to bill. It stays open: bill the rest, or tap Finish Job if that's all of it.");
    expect(db.jobs[0].status).toBe("in_progress");
    expect(writes.some((w) => w.table === "jobs")).toBe(false);
    expect(calls.pushed).toEqual([]);
  });

  it("(b) a deposit request paid ahead, then the final for the rest (which takes the request off) paid: FULLY billed, the job finishes", async () => {
    db.invoices.push(
      { ...bill("inv-900", 1000), invoice_kind: "prepayment", created_at: "2026-10-05T00:00:00Z" },
      bill("inv-901", 4000),
    );
    db.invoice_items.push(
      { id: "w", org_id: ORG, invoice_id: "inv-901", line_total: 5000, import_source: "quote", prepaid_invoice_id: null },
      { id: "c", org_id: ORG, invoice_id: "inv-901", line_total: -1000, import_source: "prepaid_credit", prepaid_invoice_id: "inv-900" },
    );
    const r = await paid("inv-901");
    expect(r).toMatchObject({ completed: true, jobId: JOB });
    expect(db.jobs[0].status).toBe("complete");
  });

  it("(b, paid last) the request paid AFTER the final that took it off: the same gate, through the final, finishes it", async () => {
    db.invoices.push(
      { ...bill("inv-900", 1000), invoice_kind: "prepayment", status: "sent", amount_paid: 0, created_at: "2026-10-05T00:00:00Z" },
      bill("inv-901", 4000),
    );
    db.invoice_items.push({ id: "c", org_id: ORG, invoice_id: "inv-901", line_total: -1000, import_source: "prepaid_credit", prepaid_invoice_id: "inv-900" });
    expect((await paid("inv-901")).completed).toBe(false); // the request still asks: "1 other open bill"
    db.invoices[0].status = "paid";
    db.invoices[0].amount_paid = 1000;
    expect(await paid("inv-900")).toMatchObject({ completed: true, jobId: JOB });
    expect(db.jobs[0].status).toBe("complete");
  });

  it("(c) the price billed in full by one bill, paid: the job finishes", async () => {
    db.invoices.push(bill("inv-900", 5000));
    expect(await paid("inv-900")).toEqual({ completed: true, jobId: JOB });
    expect(db.jobs[0].status).toBe("complete");
  });

  it("(d) no accepted estimate (a proposal only, or none): exactly as before, a paid flat bill finishes the job", async () => {
    db.quotes = [quote({ status: "sent" })];
    client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    db.invoices.push(bill("inv-900", 2000));
    expect(await paid("inv-900")).toEqual({ completed: true, jobId: JOB });
    db.jobs[0].status = "in_progress";
    db.quotes = [];
    client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    expect(await paid("inv-900")).toEqual({ completed: true, jobId: JOB });
  });

  it("(e) time and material: exactly as before (its work is the billing step's, never the price's)", async () => {
    db.jobs[0].billing_type = "tm";
    db.invoices.push(bill("inv-900", 2000));
    expect(await paid("inv-900")).toEqual({ completed: true, jobId: JOB });
    expect(db.jobs[0].status).toBe("complete");
  });

  it("another company's estimate on the same job id is never read (the company pin)", async () => {
    db.quotes = [quote({ org_id: "org-other" })];
    client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    db.invoices.push(bill("inv-900", 2000));
    expect((await paid("inv-900")).completed).toBe(true);
  });

  it("a failed estimate read is never 'nothing left': the job stays open and that is said", async () => {
    db.invoices.push(bill("inv-900", 2000));
    client = failingReads(client, "quotes");
    const r = await paid("inv-900");
    expect(r.completed).toBe(false);
    expect(r.sayTitle).toBe("Couldn't check this job's bills");
    expect(r.say).toContain("couldn't check its price against its bills");
    expect(db.jobs[0].status).toBe("in_progress");
    expect(calls.reported).toContain("priceLeftToBill.read");
  });
});

/**
 * EVERYTHING BILLABLE IS THE GATE'S FIGURE (cn-v1181): the gate reads lib/everything-billable, the job
 * page's tile, so change orders, discounts on sent bills and tax are measured the same way in both. Each
 * case below was wrong under the old figure (computeJobProgress: accepted totals less sent totals).
 */
describe("the gate reads Everything Billable", () => {
  const co = (id: string, amount: number, over: Row = {}): Row => ({ id, org_id: ORG, job_id: JOB, co_number: "CO-900", description: "Add two receptacles", amount, status: "approved", ...over });

  it("a discount line on the sent bill is a lower price: billed in full, the job finishes (it stayed open for ever)", async () => {
    db.invoices.push(bill("inv-900", 4500, { subtotal: 4500, tax: 0 }));
    db.invoice_items.push({ id: "d", org_id: ORG, invoice_id: "inv-900", line_kind: "discount", line_total: -500 });
    expect(await paid("inv-900")).toEqual({ completed: true, jobId: JOB });
    expect(db.jobs[0].status).toBe("complete");
  });

  it("another company's discount line on the same bill id is never read (the company pin)", async () => {
    db.invoices.push(bill("inv-900", 4500, { subtotal: 4500, tax: 0 }));
    db.invoice_items.push({ id: "d", org_id: "org-other", invoice_id: "inv-900", line_kind: "discount", line_total: -500 });
    expect((await paid("inv-900")).completed).toBe(false);
  });

  it("an approved deduct, billed: the price came down with it, the job finishes", async () => {
    db.change_orders.push(co("co-1", -900));
    db.invoices.push(bill("inv-900", 4100, { subtotal: 4100, tax: 0 }));
    expect(await paid("inv-900")).toEqual({ completed: true, jobId: JOB });
  });

  it("an approved add never billed keeps the job open, and the figures say it; a pending one or another company's is no price", async () => {
    db.change_orders.push(co("co-1", 1000), co("co-2", 700, { status: "pending" }), co("co-3", 300, { org_id: "org-other" }));
    db.invoices.push(bill("inv-900", 5000, { subtotal: 5000, tax: 0 }));
    const r = await paid("inv-900");
    expect(r.completed).toBe(false);
    expect(r).toMatchObject({ open: "price", sayTitle: "Still to bill" });
    expect(r.say).toContain("$6,000.00 agreed, $5,000.00 billed, $1,000.00 still to bill");
    expect(db.jobs[0].status).toBe("in_progress");
  });

  it("a taxed estimate billed with no tax (exempt): the price is measured before tax, the job finishes", async () => {
    db.quotes = [quote({ subtotal: 5000, tax: 400, total: 5400 })];
    client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    db.invoices.push(bill("inv-900", 5000, { subtotal: 5000, tax: 0 }));
    expect(await paid("inv-900")).toEqual({ completed: true, jobId: JOB });
  });

  it("draws on a taxed estimate (born tax 0 on the tax-included total): said in before-tax dollars", async () => {
    db.quotes = [quote({ subtotal: 5000, tax: 400, total: 5400 })];
    client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    // A paid draw is a stage, never the end (the gate's rule 1): the standard bill after it is where the price is asked.
    db.invoices.push(bill("inv-900", 2700, { invoice_kind: "progress", subtotal: 2700, tax: 0 }), bill("inv-901", 1250, { subtotal: 1250, tax: 0 }));
    const r = await paid("inv-901");
    expect(r.completed).toBe(false);
    expect(r.say).toContain("$5,000.00 agreed, $3,750.00 billed, $1,250.00 still to bill");
    db.invoices[1].total = db.invoices[1].subtotal = db.invoices[1].amount_paid = 2500;
    expect(await paid("inv-901")).toEqual({ completed: true, jobId: JOB });
  });

  it("a taxed estimate, a paid request and a standard taxed final that took it off: the credit line is read and handed to the rule, so the price reads billed in full and the job finishes (cn-v1181 fixer, F15)", async () => {
    // $10,000 + $725 tax. $1,000 asked ahead and paid (tax-free money against the tax-included price:
    // it counts at its before-tax share, $932.40). The final carries its own tax: its subtotal holds the
    // credit line at the request's FULL $1,000, so the rule puts the request's tax share back
    // (credit x (1 - ratio) = $67.60). Without the credit handed in, $67.60 reads as still to bill and a
    // job billed in full is held open for ever.
    db.quotes = [quote({ subtotal: 10000, tax: 725, total: 10725 })];
    client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    db.invoices.push(
      { ...bill("inv-900", 1000), invoice_kind: "prepayment", subtotal: 1000, tax: 0, created_at: "2026-10-05T00:00:00Z" },
      bill("inv-901", 9725, { subtotal: 9000, tax: 725 }),
    );
    db.invoice_items.push(
      { id: "w", org_id: ORG, invoice_id: "inv-901", line_total: 10000, import_source: "quote", line_kind: null },
      { id: "c", org_id: ORG, invoice_id: "inv-901", line_total: -1000, import_source: "prepaid_credit", line_kind: "credit", prepaid_invoice_id: "inv-900" },
    );
    expect(await paid("inv-901")).toEqual({ completed: true, jobId: JOB });
    expect(db.jobs[0].status).toBe("complete");
  });

  it("a taxed estimate, a paid request and a DRAW that took it off: a draw needs no credit term (it left the tax-included slice, and the ratio turns both back), so before-tax dollars still unbilled keep the job open (cn-v1181, lane S; the rule as changed after skeptic #84)", async () => {
    db.quotes = [quote({ subtotal: 10000, tax: 725, total: 10725 })];
    client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    db.invoices.push(
      { ...bill("inv-900", 1000), invoice_kind: "prepayment", created_at: "2026-10-05T00:00:00Z" },
      bill("inv-901", 9671.36, { invoice_kind: "progress", subtotal: 9671.36, tax: 0 }),
      bill("inv-902", 10, { subtotal: 10, tax: 0 }),
    );
    db.invoice_items.push(
      { id: "w", org_id: ORG, invoice_id: "inv-901", line_total: 10671.36, import_source: null, line_kind: null },
      { id: "c", org_id: ORG, invoice_id: "inv-901", line_total: -1000, import_source: "prepaid_credit", line_kind: "credit", prepaid_invoice_id: "inv-900" },
      // Another company's credit on the same bill id is never read (the company pin).
      { id: "x", org_id: "org-other", invoice_id: "inv-901", line_total: -5000, import_source: "prepaid_credit", line_kind: "credit", prepaid_invoice_id: "inv-900" },
    );
    const r = await paid("inv-902");
    expect(r.completed).toBe(false);
    expect(r.say).toContain("$10,000.00 agreed, $9,959.99 billed, $40.01 still to bill");
    expect(db.jobs[0].status).toBe("in_progress");
  });

  it("a failed read of the credit lines is never 'nothing taken off': the job stays open", async () => {
    db.invoices.push(bill("inv-900", 5000));
    const real = client.from;
    // Only the read of the credit lines fails (a timeout); the discount read beside it answers.
    client = {
      ...client,
      from: (t: string) => {
        const c = real(t);
        if (t !== "invoice_items") return c;
        let fail = false;
        const eq = c.eq;
        const then = c.then;
        c.eq = (col: string, v: unknown) => ((fail ||= col === "import_source"), eq(col, v));
        c.then = (ok: any, bad: any) => (fail ? Promise.resolve({ data: null, error: { message: "timeout" } }).then(ok, bad) : then(ok, bad));
        return c;
      },
    };
    const r = await paid("inv-900");
    expect(r.completed).toBe(false);
    expect(r.sayTitle).toBe("Couldn't check this job's bills");
    expect(calls.reported).toContain("priceLeftToBill.read");
  });

  it("a failed change-order read is never 'nothing left': the job stays open", async () => {
    db.invoices.push(bill("inv-900", 5000));
    client = failingReads(client, "change_orders");
    const r = await paid("inv-900");
    expect(r.completed).toBe(false);
    expect(r.sayTitle).toBe("Couldn't check this job's bills");
    expect(calls.reported).toContain("priceLeftToBill.read");
  });
});

describe("priceLeftToBill, the pure rule", () => {
  const q = [{ total: 5000, status: "accepted", created_at: "2026-10-01" }];
  it("reads the contract and the sent bills the way the job page does: drafts and voids are not billed", () => {
    expect(
      priceLeftToBill({
        billingType: "fixed",
        quotes: q,
        invoices: [
          { total: 2000, status: "paid", amount_paid: 2000 },
          { total: 3000, status: "draft", amount_paid: 0 },
          { total: 900, status: "void", amount_paid: 0 },
        ],
      }),
    ).toEqual({ contract: 5000, billed: 2000, left: 3000 });
  });
  it("billed past the price (a change order on top) leaves nothing to bill", () => {
    expect(priceLeftToBill({ billingType: null, quotes: q, invoices: [{ total: 5400, status: "sent", amount_paid: 0 }] })).toEqual({ contract: 5000, billed: 5400, left: 0 });
  });
  it("time and material, or no accepted estimate: not this rule's business", () => {
    expect(priceLeftToBill({ billingType: "tm", quotes: q, invoices: [] })).toBeNull();
    expect(priceLeftToBill({ billingType: "fixed", quotes: [{ total: 5000, status: "sent" }], invoices: [] })).toBeNull();
  });
});
