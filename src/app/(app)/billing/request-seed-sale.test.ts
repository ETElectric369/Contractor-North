import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * THE OFFICE'S REQUEST A PAYMENT FORM ON A REVISED ESTIMATE (cn-v1178, audit B1, the office half). The
 * job's newest accepted estimate is the revision; its deposit request is the SALE's, made on the original
 * (paid here). The seed hands the form that request as the deposit's own, so the form draws its doors and
 * never prefills a second deposit. The real lib/payment-request on the small in-memory database, which
 * answers quote_family_ids by migration 0416's rule. Stand-ins: the Larkspur job, E-900 revised by E-901.
 */
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-larkspur", role: "owner" })) }));
vi.mock("@/lib/lang-of", () => ({ callerLang: vi.fn(async () => "en") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/unbilled-work", () => ({ unbilledWorkForJob: vi.fn(async () => ({})), customerUnbilled: vi.fn(() => ({ materials: 0 })) }));

import { readPaymentRequestSeed } from "./request-actions";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];

beforeEach(() => {
  writes = [];
  const req: Row = { id: "inv-901", org_id: ORG, job_id: JOB, customer_id: "cust-1", quote_id: "q-900", invoice_kind: "prepayment", status: "paid", title: "Deposit", invoice_number: "INV-901", public_token: "tok-901", tax_rate: 0, total: 420, subtotal: 420, amount_paid: 420, created_at: "2026-11-01T00:00:00Z" };
  db = {
    jobs: [{ id: JOB, org_id: ORG, job_number: "J-900", status: "in_progress", customer_id: "cust-1" }],
    organizations: [{ id: ORG, settings: {} }],
    quotes: [
      { id: "q-900", org_id: ORG, job_id: JOB, quote_number: "E-900", status: "superseded", deposit_amount: 420, revises_quote_id: null, created_at: "2026-10-01T00:00:00Z" },
      { id: "q-901", org_id: ORG, job_id: JOB, quote_number: "E-901", status: "accepted", deposit_amount: 480, revises_quote_id: "q-900", created_at: "2026-10-05T00:00:00Z" },
    ],
    invoices: [req],
    invoice_items: [{ id: "l-901", org_id: ORG, invoice_id: "inv-901", description: "Deposit", quantity: 1, unit_price: 420, line_total: 420, import_source: "prepayment", prepaid_invoice_id: null, sort_order: 0 }],
    customer_credits: [],
    payments: [],
  };
  state.client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

describe("readPaymentRequestSeed on a revised estimate", () => {
  it("hands the form the sale's paid request as the deposit's own, never a second figure to ask", async () => {
    const seed = await readPaymentRequestSeed(JOB);
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    expect(seed.deposit.quote).toEqual({ id: "q-901", number: "E-901" });
    expect(seed.deposit.request).toMatchObject({ id: "inv-901", number: "INV-901", amount: 420, status: "paid" });
  });

  it("Keep Both (the pointer cleared): the second estimate is its own sale, with no request yet", async () => {
    db.quotes[1].revises_quote_id = null;
    const seed = await readPaymentRequestSeed(JOB);
    expect(seed.ok && seed.deposit.request).toBe(null);
  });
});
