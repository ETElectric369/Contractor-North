import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * THE BILL GOING OUT COMES FIRST (cn-v1177, skeptic #80). A draft's credit lines count while it is a
 * draft, so an older draft left open would hold a request's credit and the bill actually sent would
 * take nothing off. At every draft → sent flip (outgoingDraftFirst, run by sendDraftForPayment and by
 * the office doors' freshBeforeSend): the other drafts' derived lines go first, the outgoing bill takes
 * the request off, and the other drafts, resolved after, take only what is left. Stand-ins only.
 */
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));

import { recalcInvoice } from "./invoice-recalc";
import { outgoingDraftFirst } from "./payment-request";
import { sendDraftForPayment } from "./pay-door-send";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];
let client: any;

const draft = (id: string, number: string, created_at: string, work: number): { inv: Row; line: Row } => ({
  inv: { id, org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "standard", status: "draft", title: "Larkspur panel", invoice_number: number, tax_rate: 0, subtotal: 0, total: 0, amount_paid: 0, created_at },
  line: { id: `${id}-work`, org_id: ORG, invoice_id: id, description: "Labor", quantity: 1, unit_price: work, line_total: work, import_source: "labor", prepaid_invoice_id: null, sort_order: 0 },
});
const credits = (id: string) => db.invoice_items.filter((l) => l.invoice_id === id && l.import_source === "prepaid_credit").map((l) => [l.line_total, l.prepaid_invoice_id]);
const bill = (id: string) => db.invoices.find((i) => i.id === id)!;

beforeEach(async () => {
  writes = [];
  const older = draft("inv-901", "INV-901", "2026-10-02T00:00:00Z", 1000);
  const newer = draft("inv-902", "INV-902", "2026-10-03T00:00:00Z", 600);
  db = {
    jobs: [{ id: JOB, org_id: ORG, status: "in_progress", customer_id: "cust-1" }],
    organizations: [{ id: ORG, settings: {} }],
    invoices: [
      { id: "inv-900", org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "prepayment", status: "paid", title: "Deposit", invoice_number: "INV-900", tax_rate: 0, subtotal: 1000, total: 1000, amount_paid: 1000, created_at: "2026-10-01T00:00:00Z" },
      older.inv,
      newer.inv,
    ],
    invoice_items: [
      { id: "req-line", org_id: ORG, invoice_id: "inv-900", description: "Deposit", quantity: 1, unit_price: 1000, line_total: 1000, import_source: "prepayment", prepaid_invoice_id: null, sort_order: 0 },
      older.line,
      newer.line,
    ],
    customer_credits: [],
    payments: [],
  };
  client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
  // The older draft, resolved first, holds the whole request; the newer one takes nothing.
  expect(await recalcInvoice(client, "inv-901")).toBe(true);
  expect(await recalcInvoice(client, "inv-902")).toBe(true);
  expect(credits("inv-901")).toEqual([[-1000, "inv-900"]]);
  expect(credits("inv-902")).toEqual([]);
});

describe("two drafts on one job; the NEWER one is sent", () => {
  it("sendDraftForPayment: the newer bill takes the request off ($600), the older one is left only what is left ($400)", async () => {
    expect(await sendDraftForPayment(client, "inv-902")).toEqual({ ok: true });
    expect(bill("inv-902").status).not.toBe("draft");
    expect(credits("inv-902")).toEqual([[-600, "inv-900"]]);
    expect(bill("inv-902").total).toBe(0);
    expect(credits("inv-901")).toEqual([[-400, "inv-900"]]);
    expect(bill("inv-901")).toMatchObject({ status: "draft", total: 600 });
  });

  it("the older draft's lines are gone BEFORE the outgoing bill's are written (the database's hold sees room)", async () => {
    writes.length = 0;
    expect(await outgoingDraftFirst(client, "inv-902")).toBe(true);
    const items = writes.filter((w) => w.table === "invoice_items");
    const firstDelete = items.findIndex((w) => w.verb === "delete");
    const outgoingInsert = items.findIndex((w) => w.verb === "insert" && [w.payload].flat().some((r: Row) => r.invoice_id === "inv-902"));
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(outgoingInsert).toBeGreaterThan(firstDelete);
    // Nothing was sent: both are still drafts, and consistent.
    expect([bill("inv-901").status, bill("inv-902").status]).toEqual(["draft", "draft"]);
    expect(credits("inv-902")).toEqual([[-600, "inv-900"]]);
    expect(credits("inv-901")).toEqual([[-400, "inv-900"]]);
  });

  it("a bill that is not a draft is left exactly as it is", async () => {
    bill("inv-902").status = "sent";
    writes.length = 0;
    expect(await outgoingDraftFirst(client, "inv-902")).toBe(true);
    expect(writes).toEqual([]);
  });
});
