import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * REQUESTS WORTH MORE THAN THE WORK (cn-v1177, skeptic #80). Finish no longer calls a payment request
 * "covered": the bill is built for the work and its sync takes the request off, capped at the bill's
 * own lines. So the job ends with a bill that comes to $0.00 and names the request; that bill is the
 * job's bill on the books, and once it is sent the job reads billed, never "To Be Invoiced". On the
 * small in-memory database: what is read back is what was written. Stand-ins only.
 */
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { recalcInvoice } from "./invoice-recalc";
import { markInvoiceSent } from "./invoice-sent-stamp";
import { readPrepaymentStates } from "./payment-request";
import { jobBillingStatus } from "./analytics/money-metrics";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];
let client: any;

beforeEach(() => {
  writes = [];
  db = {
    jobs: [{ id: JOB, org_id: ORG, status: "in_progress", customer_id: "cust-1" }],
    organizations: [{ id: ORG, settings: {} }],
    invoices: [
      { id: "inv-900", org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "prepayment", status: "paid", title: "Deposit", invoice_number: "INV-900", tax_rate: 0, subtotal: 1000, total: 1000, amount_paid: 1000, created_at: "2026-10-01T00:00:00Z" },
      { id: "inv-901", org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "standard", status: "draft", title: "Larkspur panel", invoice_number: "INV-901", tax_rate: 0, subtotal: 0, total: 0, amount_paid: 0, created_at: "2026-11-01T00:00:00Z" },
    ],
    invoice_items: [
      { id: "req-line", org_id: ORG, invoice_id: "inv-900", description: "Deposit", quantity: 1, unit_price: 1000, line_total: 1000, import_source: "prepayment", prepaid_invoice_id: null, sort_order: 0 },
      { id: "work-line", org_id: ORG, invoice_id: "inv-901", description: "Labor", quantity: 1, unit_price: 600, line_total: 600, import_source: "labor", prepaid_invoice_id: null, sort_order: 0 },
    ],
    customer_credits: [],
    payments: [],
  };
  client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

describe("a $1,000 paid request on $600 of work", () => {
  it("the bill built for the work comes to $0.00, takes $600 off naming INV-900, and leaves $400 in hand", async () => {
    expect(await recalcInvoice(client, "inv-901")).toBe(true);
    const lines = db.invoice_items.filter((l) => l.invoice_id === "inv-901");
    expect(lines.map((l) => [l.line_total, l.prepaid_invoice_id ?? null, l.description])).toEqual([
      [600, null, "Labor"],
      [-600, "inv-900", "Less deposit (INV-900)"],
    ]);
    expect(db.invoices.find((i) => i.id === "inv-901")).toMatchObject({ total: 0, invoice_kind: "standard", job_id: JOB });
    const [s] = await readPrepaymentStates(client, JOB);
    expect(s).toMatchObject({ takenTotal: 600, left: 400, moneyLeft: 400 });
  });

  it("once sent, it is the job's bill: the job reads billed (paid in full), never To Be Invoiced", async () => {
    expect(await recalcInvoice(client, "inv-901")).toBe(true);
    // A draft is not yet invoiced, by the app's own vocabulary.
    expect(jobBillingStatus(db.invoices.map((i) => ({ ...i }) as { status: string }))).toBe("to_be_invoiced");
    expect((await markInvoiceSent(client, "inv-901")).ok).toBe(true);
    expect(await recalcInvoice(client, "inv-901")).toBe(true);
    const status = jobBillingStatus(db.invoices.map((i) => ({ ...i }) as { status: string }));
    expect(status).not.toBe("to_be_invoiced");
    expect(status).toBe("paid_in_full");
  });
});
