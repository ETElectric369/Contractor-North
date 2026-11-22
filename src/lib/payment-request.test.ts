import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}) }));

import { createPaymentRequest, ensureDepositRequestForQuoteToken, liveRequestForQuote, lostToTheStandingRequest, payDoorFacts, planPrepaidCredit, readPrepaymentStates, readPrepaymentStatesInCompany, resyncJobDrafts, syncPrepaidCredit } from "./payment-request";
import { recalcInvoice } from "./invoice-recalc";
import { prepaymentStates } from "./prepayments";
import { fakeDb, failingReads, type Write } from "./prepayment-db.test-util";

/**
 * THE SYNC, ON A SMALL IN-MEMORY DATABASE (cn-v1177). Every read and write lib/payment-request makes
 * is answered by tables held here, filters and all (eq / neq / in / is), so what a test reads back is
 * what the code wrote. What this cannot prove is the database's own boundary (two writers at once,
 * the triggers of 0414): src/lib/payment-request.integration.test.ts asks the database that.
 * Stand-ins only: J-900, INV-900, Larkspur.
 */
type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
let db: Tables;
let writes: Write[];
let seq = { n: 0 };

const ORG = "org-larkspur";
const JOB = "job-900";
const fake = (tables: Tables) => fakeDb(tables, { org: ORG, writes, seq });

const request = (id: string, amount: number, o: Row = {}): Row[] => [
  { id, org_id: ORG, job_id: JOB, invoice_kind: "prepayment", status: "sent", title: "Deposit", invoice_number: id.toUpperCase(), amount_paid: 0, tax_rate: 0, created_at: "2026-11-01T00:00:00Z", ...o },
];
const bill = (id: string, o: Row = {}): Row => ({ id, org_id: ORG, job_id: JOB, invoice_kind: "standard", status: "draft", invoice_number: id.toUpperCase(), amount_paid: 0, tax_rate: 0, created_at: "2026-11-02T00:00:00Z", ...o });
const line = (invoice_id: string, unit_price: number, o: Row = {}): Row => ({
  id: `line-${++seq.n}`,
  org_id: ORG,
  invoice_id,
  description: "Work",
  quantity: 1,
  unit_price,
  line_total: unit_price,
  import_source: null,
  prepaid_invoice_id: null,
  sort_order: 0,
  ...o,
});
const credits = (invoiceId: string) => db.invoice_items.filter((l) => l.invoice_id === invoiceId && l.import_source === "prepaid_credit");

beforeEach(() => {
  writes = [];
  seq = { n: 100 };
  db = {
    jobs: [{ id: JOB, org_id: ORG, customer_id: "cust-1", status: "in_progress" }],
    quotes: [],
    organizations: [{ id: ORG, settings: {} }],
    invoices: [...request("inv-900", 1000)],
    invoice_items: [line("inv-900", 1000, { import_source: "prepayment", description: "Deposit" })],
    customer_credits: [],
    payments: [],
  };
});

describe("planPrepaidCredit — what the sync would write, decided without a database", () => {
  const states = prepaymentStates([{ id: "r1", invoice_number: "INV-900", status: "sent", title: "Deposit", created_at: "2026-11-01", amount: 1000, amount_paid: 0, refunded: 0 }], []);
  it("a bill with no credit line yet gets one, after its last line, for as much as fits", () => {
    const plan = planPrepaidCredit([{ id: "a", line_total: 600, import_source: "labor", prepaid_invoice_id: null, description: "Labor", sort_order: 3 }], states);
    expect(plan).toEqual({ remove: [], change: [], add: [{ prepaid_invoice_id: "r1", description: "Less deposit (INV-900)", unit_price: -600, sort_order: 4 }] });
  });
  it("an unchanged set writes nothing", () => {
    const plan = planPrepaidCredit(
      [
        { id: "a", line_total: 1200, import_source: "labor", prepaid_invoice_id: null, description: "Labor", sort_order: 0 },
        { id: "c", line_total: -1000, import_source: "prepaid_credit", prepaid_invoice_id: "r1", description: "Less deposit (INV-900)", sort_order: 1 },
      ],
      states,
    );
    expect(plan).toEqual({ remove: [], change: [], add: [] });
  });
  it("a credit for a request that asks nothing now, and a second line for the same request, come off", () => {
    const plan = planPrepaidCredit(
      [
        { id: "a", line_total: 1200, import_source: null, prepaid_invoice_id: null, description: "Work", sort_order: 0 },
        { id: "old", line_total: -50, import_source: "prepaid_credit", prepaid_invoice_id: "gone", description: "Less deposit (INV-899)", sort_order: 1 },
        { id: "c1", line_total: -1000, import_source: "prepaid_credit", prepaid_invoice_id: "r1", description: "Less deposit (INV-900)", sort_order: 1 },
        { id: "c2", line_total: -1, import_source: "prepaid_credit", prepaid_invoice_id: "r1", description: "Less deposit (INV-900)", sort_order: 2 },
      ],
      states,
    );
    expect(plan.remove.sort()).toEqual(["c2", "old"]);
    expect(plan.add).toEqual([]);
  });
});

describe("syncPrepaidCredit and resyncJobDrafts", () => {
  it("two drafts on one job never both take the same dollar: the older takes what fits, the next the rest", async () => {
    db.invoices.push(bill("a", { created_at: "2026-11-02T00:00:00Z" }), bill("b", { created_at: "2026-11-03T00:00:00Z" }));
    db.invoice_items.push(line("a", 800), line("b", 900));
    await resyncJobDrafts(fake(db), JOB);
    expect(credits("a").map((l) => l.line_total)).toEqual([-800]);
    expect(credits("b").map((l) => l.line_total)).toEqual([-200]);
    // Resolved again in the other order, the sum is still the request's 1,000: never 1,600.
    expect(await syncPrepaidCredit(fake(db), "b")).toBe(true);
    expect(await syncPrepaidCredit(fake(db), "a")).toBe(true);
    const total = [...credits("a"), ...credits("b")].reduce((s, l) => s + Math.abs(l.line_total), 0);
    expect(total).toBe(1000);
  });

  it("an unchanged set writes nothing", async () => {
    db.invoices.push(bill("a"));
    db.invoice_items.push(line("a", 1500));
    expect(await syncPrepaidCredit(fake(db), "a")).toBe(true);
    const n = writes.length;
    expect(await syncPrepaidCredit(fake(db), "a")).toBe(true);
    expect(writes.length).toBe(n);
  });

  it("the line it writes: quantity 1, negative, a credit, the request named, after the bill's own lines", async () => {
    db.invoices.push(bill("a"));
    db.invoice_items.push(line("a", 600, { sort_order: 4 }));
    expect(await syncPrepaidCredit(fake(db), "a")).toBe(true);
    expect(credits("a")).toEqual([
      expect.objectContaining({ quantity: 1, unit_price: -600, line_total: -600, line_kind: "credit", prepaid_invoice_id: "inv-900", description: "Less deposit (INV-900)", sort_order: 5, org_id: ORG }),
    ]);
  });

  it("a request made while a draft is open reaches that draft", async () => {
    db.invoices = [bill("a")];
    db.invoice_items = [line("a", 2000)];
    const made = await createPaymentRequest(fake(db), { orgId: ORG, jobId: JOB, purpose: "materials", amount: 750, createdBy: "user-1" });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.request).toMatchObject({ label: "Materials Payment", amount: 750, balance: 750, status: "sent" });
    const req = db.invoices.find((i) => i.id === made.request.id)!;
    expect(req).toMatchObject({ invoice_kind: "prepayment", tax_rate: 0, due_date: null, due_date_by_hand: true, quote_id: null, status: "sent" });
    expect(db.invoice_items.filter((l) => l.invoice_id === req.id)).toEqual([expect.objectContaining({ import_source: "prepayment", quantity: 1, unit_price: 750 })]);
    expect(credits("a").map((l) => [l.prepaid_invoice_id, l.line_total])).toEqual([[req.id, -750]]);
    expect(db.invoices.find((i) => i.id === "a")!.total).toBe(1250);
  });

  it("a voided request leaves the draft", async () => {
    db.invoices.push(bill("a"));
    db.invoice_items.push(line("a", 1500));
    await resyncJobDrafts(fake(db), JOB);
    expect(credits("a")).toHaveLength(1);
    db.invoices.find((i) => i.id === "inv-900")!.status = "void";
    await resyncJobDrafts(fake(db), JOB);
    expect(credits("a")).toHaveLength(0);
    expect(db.invoices.find((i) => i.id === "a")!.total).toBe(1500);
  });

  it("a sent bill is never rewritten: its credit stands as written, whatever the requests do", async () => {
    db.invoices.push(bill("a", { status: "sent" }));
    db.invoice_items.push(line("a", 1500), line("a", -400, { import_source: "prepaid_credit", prepaid_invoice_id: "inv-900", description: "Less deposit (INV-900)" }));
    db.invoices.push(...request("inv-901", 300, { created_at: "2026-10-01T00:00:00Z" }));
    const n = writes.length;
    expect(await syncPrepaidCredit(fake(db), "a")).toBe(true);
    await resyncJobDrafts(fake(db), JOB);
    expect(writes.length).toBe(n);
    expect(credits("a").map((l) => l.line_total)).toEqual([-400]);
  });

  it("a request, and a bill with no job, are left as they are", async () => {
    db.invoices.push(bill("nojob", { job_id: null }));
    db.invoice_items.push(line("nojob", 900));
    expect(await syncPrepaidCredit(fake(db), "nojob")).toBe(true);
    expect(await syncPrepaidCredit(fake(db), "inv-900")).toBe(true);
    expect(writes).toEqual([]);
  });

  it("THE TAX: the recalc runs the sync first, then puts the credit in the subtotal and never in the tax base", async () => {
    db.invoices.push(bill("a", { tax_rate: 0.1 }));
    db.invoice_items.push(line("a", 1000));
    expect(await recalcInvoice(fake(db), "a")).toBe(true);
    expect(db.invoices.find((i) => i.id === "a")).toMatchObject({ subtotal: 0, tax: 100, total: 100 });
  });

  it("a failed read is never an empty table: the sync says false and the recalc writes nothing", async () => {
    db.invoices.push(bill("a"));
    db.invoice_items.push(line("a", 1000));
    const broken = failingReads(fake(db), "customer_credits");
    await expect(readPrepaymentStates(broken, JOB)).rejects.toBeTruthy();
    expect(await syncPrepaidCredit(broken, "a")).toBe(false);
    expect(await recalcInvoice(broken, "a")).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe("createPaymentRequest — the rules", () => {
  it("refuses a job that is over, a job with no customer, a bad amount, and another company's job", async () => {
    const mk = (o: Partial<Parameters<typeof createPaymentRequest>[1]>) =>
      createPaymentRequest(fake(db), { orgId: ORG, jobId: JOB, purpose: "deposit", amount: 500, createdBy: null, ...o });
    expect(await mk({ amount: 0 })).toEqual({ ok: false, why: "bad_amount" });
    expect(await mk({ amount: Number.NaN })).toEqual({ ok: false, why: "bad_amount" });
    expect(await mk({ orgId: "org-snowbell" })).toEqual({ ok: false, why: "no_job" });
    db.jobs[0].status = "complete";
    expect(await mk({})).toEqual({ ok: false, why: "job_over" });
    db.jobs[0].status = "in_progress";
    db.jobs[0].customer_id = null;
    expect(await mk({})).toEqual({ ok: false, why: "no_customer" });
  });

  it("an estimate's deposit: only this job's accepted estimate, and its live request is handed back, never a second", async () => {
    db.quotes.push({ id: "q-900", org_id: ORG, job_id: JOB, status: "sent" });
    const mk = () => createPaymentRequest(fake(db), { orgId: ORG, jobId: JOB, purpose: "deposit", amount: 420, quoteId: "q-900", createdBy: null });
    expect(await mk()).toEqual({ ok: false, why: "bad_quote" });
    db.quotes[0].status = "accepted";
    const first = await mk();
    expect(first.ok && first.existing).toBe(false);
    const again = await mk();
    expect(again.ok && again.existing).toBe(true);
    expect(again.ok && first.ok && again.request.id === first.request.id).toBe(true);
    expect(db.invoices.filter((i) => i.quote_id === "q-900")).toHaveLength(1);
  });
});

describe("a deposit request found as a DRAFT is never handed on (skeptic #80, F10)", () => {
  const draftRequest = () => {
    db.quotes.push({ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", public_token: "qt-900", deposit_amount: 420 });
    db.invoices.push(...request("inv-901", 420, { status: "draft", quote_id: "q-900", public_token: "tok-901", total: 420, subtotal: 420 }));
    db.invoice_items.push(line("inv-901", 420, { import_source: "prepayment", description: "Deposit" }));
  };
  it("the existing path finishes its birth (recalc, then the sent stamp) and hands it back as existing", async () => {
    draftRequest();
    const r = await createPaymentRequest(fake(db), { orgId: ORG, jobId: JOB, purpose: "deposit", amount: 420, quoteId: "q-900", createdBy: null });
    expect(r).toMatchObject({ ok: true, existing: true, request: { id: "inv-901", amount: 420 } });
    expect(r.ok && r.request.status).not.toBe("draft");
    expect(db.invoices.find((i) => i.id === "inv-901")!.status).not.toBe("draft");
    expect(db.invoices.filter((i) => i.quote_id === "q-900")).toHaveLength(1);
  });
  it("a draft that lost its own line is taken back and the answer is 'failed' (the route sends the customer back to retry)", async () => {
    draftRequest();
    db.invoice_items = db.invoice_items.filter((l) => l.invoice_id !== "inv-901");
    const r = await createPaymentRequest(fake(db), { orgId: ORG, jobId: JOB, purpose: "deposit", amount: 420, quoteId: "q-900", createdBy: null });
    expect(r).toEqual({ ok: false, why: "failed" });
    expect(db.invoices.find((i) => i.id === "inv-901")).toBeUndefined();
  });
  it("the customer's link: a draft found live gets its birth finished, and the card door gets a sent bill", async () => {
    draftRequest();
    const door = await ensureDepositRequestForQuoteToken(fake(db), "qt-900");
    expect(door).toEqual({ ok: true, invoiceToken: "tok-901", paid: false });
    expect(db.invoices.find((i) => i.id === "inv-901")!.status).not.toBe("draft");
  });
});

describe("the customer's link makes nothing the page would not offer (skeptic #80, F5; public_quote's twin)", () => {
  beforeEach(() => {
    db.quotes.push({ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", public_token: "qt-900", deposit_amount: 420 });
  });
  const door = () => ensureDepositRequestForQuoteToken(fake(db), "qt-900");
  const deposits = () => db.invoices.filter((i) => i.quote_id === "q-900");
  it("no request yet, the job open: one is made (the control)", async () => {
    expect(await door()).toMatchObject({ ok: true });
    expect(deposits()).toHaveLength(1);
  });
  it("the office VOIDED the estimate's request: nothing is made (a new one is the office's own form)", async () => {
    db.invoices.push(...request("inv-901", 420, { status: "void", quote_id: "q-900" }));
    expect(await door()).toEqual({ ok: false, why: "no_deposit" });
    expect(deposits()).toHaveLength(1);
  });
  it("the job is complete or cancelled with no live request: nothing is made", async () => {
    for (const st of ["complete", "cancelled"]) {
      db.jobs[0].status = st;
      expect(await door()).toEqual({ ok: false, why: "no_deposit" });
    }
    expect(deposits()).toHaveLength(0);
  });
  it("a LIVE request on a finished job is still handed back: it is owed", async () => {
    db.invoices.push(...request("inv-901", 420, { status: "sent", quote_id: "q-900", public_token: "tok-901", total: 420 }));
    db.jobs[0].status = "complete";
    expect(await door()).toEqual({ ok: true, invoiceToken: "tok-901", paid: false });
  });
});

/**
 * ONE SALE, ONE DEPOSIT (cn-v1178, audit B1). A revision of an estimate whose deposit was requested or
 * paid is the same sale: the customer's tap on the revision's link is HANDED that request, paid or not,
 * and never makes a second; the office's form is handed it as existing. The stand-in answers
 * quote_family_ids by migration 0416's rule from its quotes table, and refuses a second live request in
 * a family as 0416's guard does. Stand-ins: E-900 (q-900) revised by E-901 (q-901), INV-901.
 */
describe("one sale, one deposit: a revision's deposit is its sale's request (cn-v1178, B1)", () => {
  beforeEach(() => {
    db.quotes.push(
      { id: "q-900", org_id: ORG, job_id: JOB, status: "superseded", public_token: "qt-900", deposit_amount: 420, revises_quote_id: null },
      { id: "q-901", org_id: ORG, job_id: JOB, status: "accepted", public_token: "qt-901", deposit_amount: 420, revises_quote_id: "q-900" },
    );
  });
  const live = (o: Row = {}) => {
    db.invoices.push(...request("inv-901", 420, { status: "paid", amount_paid: 420, quote_id: "q-900", public_token: "tok-901", total: 420, ...o }));
    db.invoice_items.push(line("inv-901", 420, { import_source: "prepayment", description: "Deposit" }));
  };
  const deposits = () => db.invoices.filter((i) => i.invoice_kind === "prepayment" && i.quote_id);

  it("the customer's tap on the revision is handed the original's PAID request; nothing new is made", async () => {
    live();
    expect(await ensureDepositRequestForQuoteToken(fake(db), "qt-901")).toEqual({ ok: true, invoiceToken: "tok-901", paid: true });
    expect(deposits()).toHaveLength(1);
  });
  it("and its unpaid one, the same way", async () => {
    live({ status: "sent", amount_paid: 0 });
    expect(await ensureDepositRequestForQuoteToken(fake(db), "qt-901")).toEqual({ ok: true, invoiceToken: "tok-901", paid: false });
    expect(deposits()).toHaveLength(1);
  });
  it("a request the office voided anywhere in the sale: the revision's tap makes nothing", async () => {
    live({ status: "void", amount_paid: 0 });
    expect(await ensureDepositRequestForQuoteToken(fake(db), "qt-901")).toEqual({ ok: false, why: "no_deposit" });
    expect(deposits()).toHaveLength(1);
  });
  it("the office's door hands back the sale's request as existing, on the original or on the revision", async () => {
    live({ status: "sent", amount_paid: 0 });
    const r = await createPaymentRequest(fake(db), { orgId: ORG, jobId: JOB, purpose: "deposit", amount: 420, quoteId: "q-901", createdBy: null });
    expect(r).toMatchObject({ ok: true, existing: true, request: { id: "inv-901" } });
    expect((await liveRequestForQuote(fake(db), ORG, "q-900"))?.id).toBe("inv-901");
    expect(deposits()).toHaveLength(1);
  });
  it("Keep Both (the pointer cleared) makes two sales: the second estimate gets its own request", async () => {
    live({ status: "sent", amount_paid: 0 });
    db.quotes[1].revises_quote_id = null;
    const r = await createPaymentRequest(fake(db), { orgId: ORG, jobId: JOB, purpose: "deposit", amount: 420, quoteId: "q-901", createdBy: null });
    expect(r).toMatchObject({ ok: true, existing: false });
    expect(deposits()).toHaveLength(2);
  });
  it("THE LOST RACE: a request the read missed and the database's guard refused is read again and handed back, never 'failed'", async () => {
    live({ status: "sent", amount_paid: 0 });
    const client = fake(db);
    const honest = client.rpc;
    let first = true;
    // The first family read answers as if the original's request were not there yet (another tap landed
    // between the read and the insert): the insert then meets 0416's guard, as on a real database.
    client.rpc = async (fn: string, args: Record<string, unknown>) => (first ? ((first = false), { data: [args.p_quote], error: null }) : honest(fn, args));
    const r = await createPaymentRequest(client, { orgId: ORG, jobId: JOB, purpose: "deposit", amount: 420, quoteId: "q-901", createdBy: null });
    expect(r).toMatchObject({ ok: true, existing: true, request: { id: "inv-901" } });
    expect(writes.some((w) => w.table === "invoices" && w.verb === "refused")).toBe(true);
    expect(deposits()).toHaveLength(1);
  });
  it("the guard's words and 0414's index are both read as 'a request already stands'", () => {
    expect(lostToTheStandingRequest({ code: "P0001", message: "This sale already has a deposit request: INV-901. Use that one. Nothing was made." })).toBe(true);
    expect(lostToTheStandingRequest({ code: "23505", message: "duplicate key" })).toBe(true);
    expect(lostToTheStandingRequest({ code: "42501", message: "permission denied" })).toBe(false);
  });
  it("a database without quote_family_ids is an ERROR, never 'no request': the tap makes nothing", async () => {
    const client = fakeDb(db, { org: ORG, writes, seq, noFamilyFn: true });
    expect(await ensureDepositRequestForQuoteToken(client, "qt-901")).toEqual({ ok: false, why: "failed" });
    expect(deposits()).toHaveLength(0);
  });
});

/**
 * THE SERVICE CLIENT NAMES THE COMPANY (cn-v1178, audit D7). A read that is not pinned by hand reads
 * every company on the database; job ids are unique today, so the stand-in puts another company's row
 * under the same job id to see whether a read asks.
 */
describe("service-client reads of a job's requests are pinned to one company (cn-v1178, D7)", () => {
  beforeEach(() => {
    db.invoices.push(
      { id: "inv-snow", org_id: "org-snowbell", job_id: JOB, invoice_kind: "prepayment", status: "sent", title: "Deposit", invoice_number: "INV-950", amount_paid: 0, tax_rate: 0, created_at: "2026-11-01T00:00:00Z" },
      { id: "draft-snow", org_id: "org-snowbell", job_id: JOB, invoice_kind: "standard", status: "draft", invoice_number: "INV-951", amount_paid: 0, tax_rate: 0, created_at: "2026-11-02T00:00:00Z" },
    );
    db.invoice_items.push(line("inv-snow", 777, { org_id: "org-snowbell", import_source: "prepayment" }), line("draft-snow", 900, { org_id: "org-snowbell" }));
  });
  it("readPrepaymentStatesInCompany reads only that company's requests", async () => {
    const states = await readPrepaymentStatesInCompany(fake(db), ORG, JOB);
    expect(states.map((x) => x.id)).toEqual(["inv-900"]);
  });
  it("resyncJobDrafts with the company touches no other company's draft", async () => {
    await resyncJobDrafts(fake(db), JOB, null, ORG);
    expect(writes.filter((w) => w.table === "invoice_items" && w.verb === "insert")).toEqual([]);
    expect(db.invoice_items.filter((l) => l.invoice_id === "draft-snow" && l.import_source === "prepaid_credit")).toEqual([]);
  });
  it("the customer's tap resyncs in the estimate's company only", async () => {
    db.quotes.push({ id: "q-900", org_id: ORG, job_id: JOB, status: "accepted", public_token: "qt-900", deposit_amount: 420 });
    expect(await ensureDepositRequestForQuoteToken(fake(db), "qt-900")).toMatchObject({ ok: true });
    expect(db.invoice_items.filter((l) => l.invoice_id === "draft-snow" && l.import_source === "prepaid_credit")).toEqual([]);
  });
});

/**
 * THE STAND-IN ITSELF IS HONEST (cn-v1178, the audit's L2): a read of invoices or quotes gets only what it
 * named; a second live deposit request for one estimate is 0414's 23505; an unknown function is an error.
 */
describe("the in-memory database answers what a read asks, and holds the deposit boundary", () => {
  it("projects invoices and quotes to the select list (aliases too), embeds as before", async () => {
    db.quotes.push({ id: "q-900", org_id: ORG, status: "accepted", deposit_amount: 420 });
    const c = fake(db);
    expect((await c.from("invoices").select("id, status").eq("id", "inv-900").maybeSingle()).data).toEqual({ id: "inv-900", status: "sent" });
    expect((await c.from("quotes").select("n:deposit_amount").eq("id", "q-900").maybeSingle()).data).toEqual({ n: 420 });
    const withLines = (await c.from("invoices").select("id, invoice_items(line_total)").eq("id", "inv-900").maybeSingle()).data;
    expect(Object.keys(withLines).sort()).toEqual(["id", "invoice_items"]);
    expect((await c.from("invoices").select("*").eq("id", "inv-900").maybeSingle()).data.invoice_kind).toBe("prepayment");
  });
  it("a second live deposit request for one estimate is refused with 0414's index; a void one is not counted", async () => {
    db.quotes.push({ id: "q-900", org_id: ORG, revises_quote_id: null });
    db.invoices[0].quote_id = "q-900";
    const c = fake(db);
    // The SAME estimate: 0416's guard skips it (d.quote_id <> new.quote_id), so the index answers (skeptic S5).
    const second = await c.from("invoices").insert({ job_id: JOB, invoice_kind: "prepayment", quote_id: "q-900", status: "draft" }).select("id").single();
    expect(second.error?.code).toBe("23505");
    const noGuard = fakeDb(db, { org: ORG, writes, seq, noFamilyFn: true });
    const viaIndex = await noGuard.from("invoices").insert({ job_id: JOB, invoice_kind: "prepayment", quote_id: "q-900", status: "draft" }).select("id").single();
    expect(viaIndex.error?.code).toBe("23505");
    db.invoices[0].status = "void";
    expect((await c.from("invoices").insert({ job_id: JOB, invoice_kind: "prepayment", quote_id: "q-900", status: "draft" }).select("id").single()).error).toBe(null);
  });
  it("skeptic S5: the same estimate answers 23505, another estimate of the sale answers the guard's words", async () => {
    db.quotes.push({ id: "q-900", org_id: ORG, revises_quote_id: null }, { id: "q-901", org_id: ORG, revises_quote_id: "q-900" });
    db.invoices[0].quote_id = "q-900";
    const c = fake(db);
    const same = await c.from("invoices").insert({ job_id: JOB, invoice_kind: "prepayment", quote_id: "q-900", status: "draft" }).select("id").single();
    expect(same.error).toEqual({ code: "23505", message: 'duplicate key value violates unique constraint "invoices_one_live_deposit_request_per_estimate"' });
    const sibling = await c.from("invoices").insert({ job_id: JOB, invoice_kind: "prepayment", quote_id: "q-901", status: "draft" }).select("id").single();
    expect(sibling.error).toEqual({ code: "P0001", message: `This sale already has a deposit request: ${db.invoices[0].invoice_number}. Use that one. Nothing was made.` });
  });
  it("a payment landing on a request is never refused by the guard, even beside a second live one", async () => {
    db.quotes.push({ id: "q-900", org_id: ORG, revises_quote_id: null }, { id: "q-901", org_id: ORG, revises_quote_id: "q-900" });
    db.invoices[0].quote_id = "q-900";
    db.invoices.push(...request("inv-901", 420, { quote_id: "q-901" }));
    const c = fake(db);
    expect((await c.from("invoices").update({ status: "paid", amount_paid: 1000 }).eq("id", "inv-900").select("id")).error).toBe(null);
  });
  it("an unknown database function is an error", async () => {
    expect((await fake(db).rpc("no_such_fn", {})).error).toBeTruthy();
  });
});

describe("payDoorFacts — what a Get Paid sheet opened from a request needs", () => {
  it("the card door, the company's methods, Venmo when a handle is set, texting's readiness", () => {
    const off = payDoorFacts({ settings: {}, stripe_account_id: null, stripe_charges_enabled: false });
    expect(off.cardEnabled).toBe(false);
    expect(off.venmoConfigured).toBe(false);
    expect(Array.isArray(off.methods) && off.methods.length > 0).toBe(true);
    expect(typeof off.textReady).toBe("boolean");
    const on = payDoorFacts({ settings: { venmo_handle: " larkspur-electric ", payment_methods: ["Cash", "Check"] }, stripe_account_id: "acct_test", stripe_charges_enabled: true });
    expect(on).toMatchObject({ cardEnabled: true, venmoConfigured: true, methods: ["Cash", "Check"] });
    expect(payDoorFacts({ settings: { venmo_handle: "   " } }).venmoConfigured).toBe(false);
  });
});
