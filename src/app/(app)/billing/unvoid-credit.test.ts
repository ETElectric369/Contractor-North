import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * A BILL BACK FROM VOID (cn-v1177, skeptic #80, F6). While it was void it took nothing off; since then
 * the request it named may have been voided or used by another bill. The un-void door takes its credit
 * lines that would no longer hold off FIRST, then flips, then recalculates (a draft's sync takes what
 * is left). The database no longer re-checks a void bill coming back as a draft (0414), so this door is
 * what keeps it whole. On the small in-memory database. Stand-ins only.
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

import { setInvoiceStatus } from "./actions";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];

const inv = (id: string, o: Row): Row => ({ id, org_id: ORG, job_id: JOB, customer_id: "cust-1", invoice_kind: "standard", title: "Larkspur panel", invoice_number: id.toUpperCase(), tax_rate: 0, amount_paid: 0, ...o });
const item = (invoice_id: string, unit_price: number, o: Row = {}): Row => ({ id: `${invoice_id}-${o.import_source ?? "work"}`, org_id: ORG, invoice_id, description: "Labor", quantity: 1, unit_price, line_total: unit_price, import_source: null, prepaid_invoice_id: null, sort_order: 0, ...o });
const credits = (id: string) => db.invoice_items.filter((l) => l.invoice_id === id && l.import_source === "prepaid_credit").map((l) => [l.line_total, l.prepaid_invoice_id]);

beforeEach(() => {
  writes = [];
  db = {
    jobs: [{ id: JOB, org_id: ORG, status: "in_progress", customer_id: "cust-1" }],
    organizations: [{ id: ORG, settings: {} }],
    invoices: [
      inv("inv-900", { invoice_kind: "prepayment", status: "paid", title: "Deposit", total: 1000, subtotal: 1000, amount_paid: 1000, created_at: "2026-10-01T00:00:00Z" }),
      // A: voided while it carried the whole request.
      inv("inv-901", { status: "void", total: 0, subtotal: 0, created_at: "2026-10-02T00:00:00Z" }),
      // B: went out after A was voided and took $600 of it.
      inv("inv-902", { status: "sent", total: 0, subtotal: 0, created_at: "2026-10-03T00:00:00Z", sent_at: "2026-10-03T00:00:00Z" }),
    ],
    invoice_items: [
      item("inv-900", 1000, { import_source: "prepayment", description: "Deposit" }),
      item("inv-901", 1500),
      item("inv-901", -1000, { import_source: "prepaid_credit", prepaid_invoice_id: "inv-900", description: "Less deposit (INV-900)" }),
      item("inv-902", 600),
      item("inv-902", -600, { import_source: "prepaid_credit", prepaid_invoice_id: "inv-900", description: "Less deposit (INV-900)" }),
    ],
    customer_credits: [],
    payments: [],
  };
  state.client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

describe("un-voiding a bill whose credit would no longer hold", () => {
  it("back to Draft: the stale $1,000 line comes off first, then the draft takes only the $400 left", async () => {
    expect(await setInvoiceStatus("inv-901", "draft")).toEqual({ ok: true });
    const a = db.invoices.find((i) => i.id === "inv-901")!;
    expect(a.status).toBe("draft");
    expect(credits("inv-901")).toEqual([[-400, "inv-900"]]);
    expect(a.total).toBe(1100);
    // The stale line was deleted BEFORE the status was written.
    const del = writes.findIndex((w) => w.table === "invoice_items" && w.verb === "delete");
    const flip = writes.findIndex((w) => w.table === "invoices" && w.verb === "update" && w.payload?.status === "draft");
    expect(del).toBeGreaterThanOrEqual(0);
    expect(flip).toBeGreaterThan(del);
  });

  it("the request it named was voided since: the line comes off and nothing is taken", async () => {
    db.invoices.find((i) => i.id === "inv-900")!.status = "void";
    db.invoice_items = db.invoice_items.filter((l) => l.invoice_id !== "inv-902" || l.import_source !== "prepaid_credit");
    expect(await setInvoiceStatus("inv-901", "draft")).toEqual({ ok: true });
    expect(credits("inv-901")).toEqual([]);
    expect(db.invoices.find((i) => i.id === "inv-901")!.total).toBe(1500);
  });

  it("back as Sent: what would not hold comes off, and the bill stands at its work", async () => {
    expect(await setInvoiceStatus("inv-901", "sent")).toEqual({ ok: true });
    expect(credits("inv-901")).toEqual([]);
    expect(db.invoices.find((i) => i.id === "inv-901")!.total).toBe(1500);
  });

  it("a line that still holds stays as written", async () => {
    db.invoice_items = db.invoice_items.filter((l) => l.invoice_id !== "inv-902");
    db.invoices = db.invoices.filter((i) => i.id !== "inv-902");
    writes.length = 0;
    expect(await setInvoiceStatus("inv-901", "sent")).toEqual({ ok: true });
    expect(credits("inv-901")).toEqual([[-1000, "inv-900"]]);
    expect(writes.some((w) => w.table === "invoice_items" && w.verb === "delete")).toBe(false);
  });
});
