import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * A BILL BACK FROM VOID (cn-v1177, skeptic #80, F6). While it was void it took nothing off; since then
 * the request it named may have been voided or used by another bill. The un-void door takes its credit
 * lines that would no longer hold off FIRST, then flips, then recalculates (a draft's sync takes what
 * is left). The database no longer re-checks a void bill coming back as a draft (0414), so this door is
 * what keeps it whole. On the small in-memory database. Stand-ins only.
 *
 * AND THE DOOR BEFORE IT (found by the database suite the night of the release): unvoidConflict reads a
 * line with an import source and no recorded claim as a line built before claims existed, and refuses
 * to bring its bill back beside any other live bill. A "Less deposit" line is exactly that shape, and
 * its request is always another live bill, so every case below was refused on a real database while
 * this file passed: the in-memory database did not hand the door the bill's lines. It does now, and the
 * last two cases hold both halves: money ahead is not a legacy line, and a real one still closes the way.
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

describe("money ahead is not a legacy line, and a legacy line still is", () => {
  it("the door is handed the bill's lines: a labor line that records no claim still closes the way back, naming the live bills", async () => {
    db.invoice_items.push(item("inv-901", 800, { id: "inv-901-labor", import_source: "labor", description: "Labor: Sam Tillery" }));
    const r = await setInvoiceStatus("inv-901", "draft");
    expect(r.ok).toBe(false);
    const said = (r as { error?: string }).error ?? "";
    expect(said).toContain("INV-901 can't come back from void");
    expect(said).toContain("INV-900");
    expect(said).toContain("INV-902");
    expect(db.invoices.find((i) => i.id === "inv-901")!.status).toBe("void");
    expect(writes).toEqual([]);
  });

  it("a voided payment request comes back beside the job's other live bill", async () => {
    // Nothing takes it off: the one bill that did is void, and the bill that went out carries only work.
    db.invoices.find((i) => i.id === "inv-900")!.status = "void";
    db.invoice_items = db.invoice_items.filter((l) => l.import_source !== "prepaid_credit");
    expect(await setInvoiceStatus("inv-900", "sent")).toEqual({ ok: true });
    expect(db.invoices.find((i) => i.id === "inv-900")!.status).toBe("sent");
  });
});

/**
 * A REQUEST WITH MONEY ON IT IS NOT VOIDED (cn-v1178, audit D4). Voided, no bill would take its money off
 * and the next one would ask for it again; the one way through is to give it back first.
 */
describe("voiding a payment request with money paid on it", () => {
  beforeEach(() => {
    // Only the request: nothing took it off.
    db.invoices = db.invoices.filter((i) => i.id === "inv-900");
    db.invoice_items = db.invoice_items.filter((l) => l.invoice_id === "inv-900");
  });

  it("is refused while paid less refunded is above zero, naming the one action", async () => {
    expect(await setInvoiceStatus("inv-900", "void")).toEqual({ ok: false, error: "INV-900 has $1,000.00 paid on it. Refund it first, then void it." });
    expect(db.invoices[0].status).toBe("paid");
    db.customer_credits.push({ id: "cc-1", org_id: ORG, invoice_id: "inv-900", amount: 400, disposition: "refund" });
    expect(await setInvoiceStatus("inv-900", "void")).toEqual({ ok: false, error: "INV-900 has $600.00 paid on it. Refund it first, then void it." });
  });

  it("once the money is given back, it voids", async () => {
    db.customer_credits.push({ id: "cc-1", org_id: ORG, invoice_id: "inv-900", amount: 1000, disposition: "refund" });
    expect(await setInvoiceStatus("inv-900", "void")).toEqual({ ok: true });
    expect(db.invoices[0].status).toBe("void");
  });
});

/**
 * ONE SALE, ONE DEPOSIT, AT THE UN-VOID DOOR (cn-v1178, carried C38): a voided deposit request does not
 * come back beside the deposit request that now stands for its estimate or for any estimate of its sale,
 * and the sentence names that request.
 */
describe("a voided deposit request coming back beside the sale's standing one", () => {
  beforeEach(() => {
    db.invoices = db.invoices.filter((i) => i.id === "inv-900");
    db.invoice_items = db.invoice_items.filter((l) => l.invoice_id === "inv-900");
    Object.assign(db.invoices[0], { status: "void", amount_paid: 0, quote_id: "q-900" });
    db.quotes = [
      { id: "q-900", org_id: ORG, revises_quote_id: null },
      { id: "q-901", org_id: ORG, revises_quote_id: "q-900" },
    ];
  });

  for (const [what, quote] of [["the same estimate", "q-900"], ["a revision of it", "q-901"]] as const) {
    it(`is refused when ${what} has a live request, naming it`, async () => {
      db.invoices.push(inv("inv-950", { invoice_kind: "prepayment", status: "sent", title: "Deposit", total: 500, quote_id: quote, created_at: "2026-10-05T00:00:00Z" }));
      expect(await setInvoiceStatus("inv-900", "sent")).toEqual({
        ok: false,
        error: "INV-900 can't come back from void: INV-950 is this sale's deposit request now. Void INV-950 first, or leave INV-900 void.",
      });
      expect(db.invoices[0].status).toBe("void");
    });
  }

  it("another sale's request (the pointer cleared by Keep Both) does not stand in its way", async () => {
    db.quotes[1].revises_quote_id = null;
    db.invoices.push(inv("inv-950", { invoice_kind: "prepayment", status: "sent", title: "Deposit", total: 500, quote_id: "q-901", created_at: "2026-10-05T00:00:00Z" }));
    expect(await setInvoiceStatus("inv-900", "sent")).toEqual({ ok: true });
  });
});

/**
 * A DRAW'S "LESS PREVIOUS BILLINGS" LINE (cn-v1178, carried C37) still closes the way back from void
 * beside a live bill, in words true of it: it bills no hours, and it was not built before claims.
 */
describe("a void draw whose only unclaimed line is its draw credit", () => {
  it("is refused in its own words", async () => {
    db.invoice_items = db.invoice_items.filter((l) => l.invoice_id !== "inv-901");
    db.invoice_items.push(item("inv-901", 2000, { id: "inv-901-quote", description: "Progress billing" }));
    db.invoice_items.push(item("inv-901", -500, { id: "inv-901-dc", import_source: "draw_credit", description: "Less previous billings" }));
    const r = await setInvoiceStatus("inv-901", "draft");
    const said = (r as { error?: string }).error ?? "";
    expect(r.ok).toBe(false);
    expect(said).toContain('INV-901 can\'t come back from void: its "Less previous billings" line takes earlier draws off');
    expect(said).not.toContain("built before");
  });
});
