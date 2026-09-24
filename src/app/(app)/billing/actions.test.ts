import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE THREE DOORS cn-v967 CLOSED IN billing/actions.ts, pinned.
 *
 * 1. A receipt flagged `pricing_provisional` (0271 — CED's Sunnyvale counter prints its own retail
 *    price where Erik's contract price belongs) was itemised onto a customer's invoice with no
 *    gate and no word said. It already happened: $467.87 on J-046, Jason Waldow. The fixture below
 *    is that receipt, line for line out of his database.
 * 2. createProgressReportInvoice swallowed a real import failure and shipped a draw missing the
 *    work, or deleted the draft and blamed "no labor or materials logged" — the one failure 0260
 *    was built to make loud, muffled by the function that mints the customer's document.
 * 3. The scope block, the title and the due date could be rewritten on a delivered invoice without
 *    0269's revision stamp, so the "the customer is holding an older copy" banner never fired for
 *    the words on the document itself.
 */

const state = vi.hoisted(() => ({ client: null as any }));
const spies = vi.hoisted(() => ({ reportError: (..._a: any[]) => {} }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/server", () => ({ after: vi.fn((fn: any) => fn?.()) }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn((...a: any[]) => spies.reportError(...a)) }));

import {
  importCostsIntoInvoice,
  createProgressReportInvoice,
  setInvoiceDescription,
  setInvoiceTitle,
  setInvoiceDueDate,
} from "./actions";

// ── A scriptable PostgREST fake, ROUTED not queued ────────────────────────────────────────────
// Keyed on the table plus the select list (or the payload's keys on a write), because these
// actions fire several reads of the same table concurrently inside Promise.all — a FIFO queue
// would make the test's own ordering a coin flip. An unrouted call throws by name, so the test
// also pins WHICH statements run.

type Q = {
  table: string;
  verb: "select" | "insert" | "update" | "delete" | "rpc";
  cols: string;
  payload?: any;
  single?: boolean;
};
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  const client: any = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc(fn: string, args: any) {
      const q: Q = { table: `rpc:${fn}`, verb: "rpc", cols: "", payload: args };
      calls.push(q);
      return Promise.resolve(answer(q));
    },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "" };
      calls.push(q);
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        single() { q.single = true; return Promise.resolve(answer(q)); },
        maybeSingle() { q.single = true; return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) {
          try { resolve(answer(q)); } catch (e) { reject?.(e); }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "ilike", "overlaps", "order", "limit", "range", "filter", "contains"]) {
        chain[m] = () => chain;
      }
      return chain;
    },
  };
  return client;
}

const INV = "9fc9aaaa-0000-4000-8000-000000000001";
const JOB = "3d1bb8cc-ac74-4a57-9eef-6739d0a1a0c3"; // J-046, Jason Waldow

/** bills.id c0535cdb… — the real Sunnyvale ticket, pricing_provisional = true. */
const WALDOW_BILL = {
  id: "c0535cdb-e485-4679-8e56-fd0918fd728b",
  supplier: "Contractors Electrical Distributors",
  bill_number: null,
  amount: "467.87",
  po_id: null,
  pricing_provisional: true,
};

/** Its bill_line_items, copied out of his database. */
const WALDOW_LINES = [
  { id: "90cf614c", bill_id: WALDOW_BILL.id, description: "ITE PN1632L1125C 125A Plug On Neutral Load Center", quantity: "1.00", unit_price: "107.33", amount: "107.33", category: "Electrical", sort_order: 0, billable: true, billed_amount: null },
  { id: "374b0d23", bill_id: WALDOW_BILL.id, description: "3M 33+SUPER3/4X76FT 3/4 x 76 33+ Super Vinyl Tape", quantity: "2.00", unit_price: "8.24", amount: "16.48", category: "Electrical", sort_order: 1, billable: true, billed_amount: null },
  { id: "24bfd5db", bill_id: WALDOW_BILL.id, description: "IDEAL 30641 500/5000 Twister 341-Tan", quantity: "500.00", unit_price: "108.36", amount: "108.36", category: "Electrical", sort_order: 2, billable: true, billed_amount: null },
  { id: "595b34f6", bill_id: WALDOW_BILL.id, description: "IDEAL 30030 8-Oz Anti Oxidant Comp", quantity: "1.00", unit_price: "20.65", amount: "20.65", category: "Electrical", sort_order: 3, billable: true, billed_amount: null },
  { id: "eb753e54", bill_id: WALDOW_BILL.id, description: "SQD HOM120 Miniature Circuit", quantity: "3.00", unit_price: "6.17", amount: "18.51", category: "Electrical", sort_order: 4, billable: true, billed_amount: null },
  { id: "266c063c", bill_id: WALDOW_BILL.id, description: "SQD HOMT1515 Miniature Circuit", quantity: "4.00", unit_price: "15.12", amount: "60.48", category: "Electrical", sort_order: 5, billable: true, billed_amount: null },
  { id: "1c3216e4", bill_id: WALDOW_BILL.id, description: "SQD HOMT2020 Miniature Circuit", quantity: "4.00", unit_price: "15.12", amount: "60.48", category: "Electrical", sort_order: 6, billable: true, billed_amount: null },
  { id: "99fb20d5", bill_id: WALDOW_BILL.id, description: "SQD HOMT230250 Miniature Ckt Brkr", quantity: "2.00", unit_price: "37.79", amount: "75.58", category: "Electrical", sort_order: 7, billable: true, billed_amount: null },
];

/** The reads importCostsIntoInvoice makes that aren't about the bills themselves. */
function costsImportRoute(opts: { bills: any[]; lines: any[]; landedAfter: string[]; rpcError?: any; onInvoice?: any[] }) {
  return (q: Q): Reply => {
    if (q.table === "invoices" && q.verb === "select") {
      if (q.cols.includes("invoice_kind") && q.cols.includes("job_id") && q.single) return { data: { id: INV, job_id: JOB, invoice_kind: "standard" } };
      if (q.cols.includes("invoice_number")) return { data: [] };            // activeDrawOnJob
      if (q.cols === "status") return { data: { status: "draft" } };          // requireLiveInvoice
      if (q.cols.includes("invoice_items(import_key")) return { data: [] };   // claimedSourcesOnJob
      if (q.cols.includes("sent_at")) return { data: { sent_at: null } };     // stampInvoiceRevised
      if (q.cols.includes("tax_rate")) return { data: { tax_rate: 0, status: "draft" } };
    }
    if (q.table === "invoices" && q.verb === "update") return { data: null }; // recalcInvoice
    if (q.table === "purchase_orders") return { data: [] };
    if (q.table === "bills") return { data: opts.bills };
    if (q.table === "bill_line_items") return { data: opts.lines };
    if (q.table === "invoice_items" && q.verb === "select") {
      if (q.cols.includes("invoices!inner")) return { data: [] };             // claims by id
      if (q.cols.includes("import_key, edited")) {
        // BEFORE the RPC nothing has landed; AFTER it, the rows the RPC wrote.
        const seen = landedCalls++;
        return { data: seen === 0 ? [] : opts.landedAfter.map((id) => ({ import_key: `bill:${id}`, edited: false, source_ids: [id] })) };
      }
      if (q.cols === "line_total") return { data: [] };                       // recalcInvoice
      if (q.cols === "import_key, line_total, edited") return { data: opts.onInvoice ?? [] }; // edited tax rows
    }
    if (q.table === "payments") return { data: [] };
    if (q.table === "customer_credits") return { data: [] };
    if (q.table === "rpc:upsert_imported_invoice_items") {
      return opts.rpcError ? { error: opts.rpcError } : { data: { inserted: 1, updated: 0, kept_edited: 0, removed: 0 } };
    }
    return undefined;
  };
}

let calls: Q[];
let landedCalls = 0;
beforeEach(() => { calls = []; landedCalls = 0; });

describe("importCostsIntoInvoice — a counter preview is not his price (0271)", () => {
  it("says the prices are a preview when the receipt it just billed is flagged", async () => {
    state.client = fakeSupabase(
      costsImportRoute({ bills: [WALDOW_BILL], lines: WALDOW_LINES, landedAfter: [WALDOW_BILL.id] }),
      calls,
    );

    const res: any = await importCostsIntoInvoice(INV, 20);
    expect(res.ok).toBe(true);
    expect(res.stats.summary).toContain("one receipt's prices are a counter preview, not your account's pricing");
    expect(res.stats.summary).toContain("check it before you send");
    // It SUGGESTS, it does not block: the $467.87 still went on, marked up.
    const rpc = calls.find((c) => c.table === "rpc:upsert_imported_invoice_items");
    const rows = (rpc?.payload?.p_rows ?? []) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.round(rows.reduce((s, r) => s + r.quantity * r.unit_price, 0) * 100) / 100).toBe(561.44); // 467.87 × 1.20
  });

  it("asks for the column, so a flag the receipt reader set can be read at all", async () => {
    state.client = fakeSupabase(
      costsImportRoute({ bills: [WALDOW_BILL], lines: WALDOW_LINES, landedAfter: [WALDOW_BILL.id] }),
      calls,
    );
    await importCostsIntoInvoice(INV, 20);
    const billsRead = calls.find((c) => c.table === "bills" && c.verb === "select");
    expect(billsRead?.cols).toContain("pricing_provisional");
  });

  it("stays quiet on an ordinary receipt — no warning nobody needs", async () => {
    const settled = { ...WALDOW_BILL, pricing_provisional: false };
    state.client = fakeSupabase(
      costsImportRoute({ bills: [settled], lines: WALDOW_LINES, landedAfter: [settled.id] }),
      calls,
    );
    const res: any = await importCostsIntoInvoice(INV, 20);
    expect(res.ok).toBe(true);
    expect(res.stats.summary).not.toContain("counter preview");
  });

  it("names two receipts in the plural, and only the ones whose lines landed", async () => {
    const second = { ...WALDOW_BILL, id: "11111111-2222-4333-8444-555555555555", amount: "100.00", pricing_provisional: true };
    const heldBack = { ...WALDOW_BILL, id: "99999999-8888-4777-8666-555555555555", amount: "50.00", pricing_provisional: true };
    const lines = [
      ...WALDOW_LINES,
      { id: "l2", bill_id: second.id, description: "Wire", quantity: "1.00", unit_price: "100.00", amount: "100.00", category: "Electrical", sort_order: 0, billable: true, billed_amount: null },
      { id: "l3", bill_id: heldBack.id, description: "Strut", quantity: "1.00", unit_price: "50.00", amount: "50.00", category: "Electrical", sort_order: 0, billable: true, billed_amount: null },
    ];
    state.client = fakeSupabase(
      // heldBack's rows never land (the office edited that line by hand, so the RPC left it alone).
      costsImportRoute({ bills: [WALDOW_BILL, second, heldBack], lines, landedAfter: [WALDOW_BILL.id, second.id] }),
      calls,
    );
    const res: any = await importCostsIntoInvoice(INV, 0);
    expect(res.stats.summary).toContain("2 receipts' prices are a counter preview");
    expect(res.stats.summary).toContain("check them before you send");
  });
});

describe("importCostsIntoInvoice — an edited tax row left behind is said out loud (INV-074)", () => {
  /** Swigard's, $17.15: a Duct Flex at $15.99 and $1.16 of tax. */
  const SWIG = { id: "5a1f0000-0000-4000-8000-000000000074", supplier: "Swigard's", bill_number: null, amount: "17.15", po_id: null, pricing_provisional: false };
  const SWIG_LINES = [
    { id: "flex", bill_id: SWIG.id, description: "Duct Flex", quantity: "1.00", unit_price: "15.99", amount: "15.99", category: "Materials", sort_order: 0, billable: true, billed_amount: null },
    { id: "tax", bill_id: SWIG.id, description: "Sales Tax", quantity: "1.00", unit_price: "1.16", amount: "1.16", category: "Sales Tax", sort_order: 1, billable: true, billed_amount: null },
  ];

  it("names the bill, the kept figure and billItemisation's figure at the new markup", async () => {
    state.client = fakeSupabase(
      costsImportRoute({
        bills: [SWIG],
        lines: SWIG_LINES,
        landedAfter: [SWIG.id],
        // After the 30% run: the part refreshed, the renamed tax row still at its 25% figure.
        onInvoice: [
          { import_key: "bli:flex", line_total: 20.79, edited: false },
          { import_key: `bill:${SWIG.id}:remainder`, line_total: 1.45, edited: true },
        ],
      }),
      calls,
    );
    const res: any = await importCostsIntoInvoice(INV, 30);
    expect(res.ok).toBe(true);
    expect(res.stats.warnings).toEqual(["Swigard's: your edited Supplies & tax row stayed at $1.45; at 30% it would be $1.51"]);
    // Nothing about what is charged moved: the offer is billItemisation's, edited row or not.
    const rpc = calls.find((c) => c.table === "rpc:upsert_imported_invoice_items");
    expect((rpc?.payload?.p_rows ?? []).map((r: any) => [r.import_key, r.unit_price])).toEqual([
      ["bli:flex", 20.79],
      [`bill:${SWIG.id}:remainder`, 1.51],
    ]);
  });

  it("says nothing when no tax row was edited", async () => {
    state.client = fakeSupabase(
      costsImportRoute({
        bills: [SWIG],
        lines: SWIG_LINES,
        landedAfter: [SWIG.id],
        onInvoice: [
          { import_key: "bli:flex", line_total: 20.79, edited: false },
          { import_key: `bill:${SWIG.id}:remainder`, line_total: 1.51, edited: false },
        ],
      }),
      calls,
    );
    const res: any = await importCostsIntoInvoice(INV, 30);
    expect(res.ok).toBe(true);
    expect(res.stats.warnings).toBeUndefined();
  });

  it("a failed read of the invoice's rows does not fail an import that already landed", async () => {
    const route = costsImportRoute({ bills: [SWIG], lines: SWIG_LINES, landedAfter: [SWIG.id] });
    state.client = fakeSupabase((q) => (q.cols === "import_key, line_total, edited" ? { error: { message: "boom" } } : route(q)), calls);
    const reported: any[] = [];
    spies.reportError = (...a: any[]) => reported.push(a);
    const res: any = await importCostsIntoInvoice(INV, 30);
    spies.reportError = () => {};
    expect(res.ok).toBe(true);
    expect(res.stats.warnings).toBeUndefined();
    expect(reported.map((a) => a[0])).toContain("importCostsIntoInvoice.remainderDrift");
  });
});

// ── Finding 2: the draw must not swallow a real import failure ────────────────────────────────

const NEW_DRAW = "0dda0000-0000-4000-8000-00000000000d";

/** Everything createProgressReportInvoice reads before it writes a row. `rpcError` fails the
 *  labor import the way 0260's guard_invoice_item_claim does — a genuine concurrent claim. */
function drawRoute(opts: { laborRpcError?: any; costsRpcError?: any; bills?: any[] }) {
  return (q: Q): Reply => {
    if (q.table === "jobs" && q.cols.includes("customer_id")) return { data: { customer_id: "cust-1", name: "Jason Waldow" } };
    if (q.table === "jobs") return { data: null }; // customerLaborRate / customerMaterialMarkup
    if (q.table === "organizations") return { data: { settings: { default_labor_rate: 95, material_markup_percent: 20, invoice_due_days: 30 } } };
    if (q.table === "payment_milestones") return { data: null };
    if (q.table === "invoices" && q.verb === "select") {
      if (q.cols === "invoice_number") return { data: null };                       // no open draft draw
      if (q.cols.includes("invoice_items(import_source")) return { data: [] };      // fixedBillingsNotYetNetted
      if (q.cols.includes("invoice_items(import_key")) return { data: [] };         // claimedSourcesOnJob
      if (q.cols.includes("total, invoice_kind")) return { data: [] };              // standardBillingBlockerOnJob
      if (q.cols.includes("invoice_kind") && q.cols.includes("job_id") && q.single) return { data: { id: NEW_DRAW, job_id: JOB, invoice_kind: "progress" } };
      if (q.cols.includes("invoice_number")) return { data: [] };                   // activeDrawOnJob
      if (q.cols === "status") return { data: { status: "draft" } };
      if (q.cols === "subtotal") return { data: { subtotal: 665 } }; // the 7 hr the labor import landed
      if (q.cols.includes("sent_at")) return { data: { sent_at: null } };
      if (q.cols.includes("tax_rate")) return { data: { tax_rate: 0, status: "draft" } };
    }
    if (q.table === "invoices" && q.verb === "insert") return { data: { id: NEW_DRAW } };
    if (q.table === "invoices" && q.verb === "update") return { data: null };
    if (q.table === "invoices" && q.verb === "delete") return { data: null };
    if (q.table === "time_entries") return { data: [{ id: "te-1", clock_in: "2026-09-15T15:00:00Z", clock_out: "2026-09-15T22:00:00Z", lunch_minutes: 0, job_code: null, profiles: { id: "p-1", full_name: "Erik" } }] };
    if (q.table === "job_codes") return { data: [] };
    if (q.table === "profile_pay") return { data: [{ id: "p-1", hourly_rate: 45, bill_rate: 95 }] };
    if (q.table === "purchase_orders") return { data: [] };
    if (q.table === "bills") return { data: opts.bills ?? [] };
    if (q.table === "bill_line_items") return { data: [] }; // hand-entered: imports as its lump
    if (q.table === "invoice_items" && q.verb === "select") {
      if (q.cols.includes("invoices!inner")) return { data: [] };
      if (q.cols.includes("import_key, edited")) return { data: [] };
      if (q.cols === "invoice_id") return { data: [] };
      if (q.cols === "line_total") return { data: [] };
      if (q.cols === "import_key, line_total, edited") return { data: [] };
    }
    if (q.table === "payments") return { data: [] };
    if (q.table === "customer_credits") return { data: [] };
    if (q.table === "rpc:upsert_imported_invoice_items") {
      const src = q.payload?.p_source;
      if (src === "labor" && opts.laborRpcError) return { error: opts.laborRpcError };
      if (src === "costs" && opts.costsRpcError) return { error: opts.costsRpcError };
      return { data: { inserted: 1, updated: 0, kept_edited: 0, removed: 0 } };
    }
    return undefined;
  };
}

describe("createProgressReportInvoice — a lost import is never a quiet one (0260)", () => {
  it("refuses out loud and deletes the half-built draw when the labor import fails", async () => {
    const seen: any[] = [];
    spies.reportError = (...a: any[]) => { seen.push(a); };
    state.client = fakeSupabase(
      drawRoute({ laborRpcError: { code: "P0001", message: "hours already billed on INV-062" } }),
      calls,
    );

    const res: any = await createProgressReportInvoice(JOB, "progress");
    expect(res.ok).toBe(false);
    // The importer's own sentence, not a cheerful toast and not "no work logged".
    expect(String(res.error)).toContain("INV-062");
    expect(String(res.error)).not.toContain("No labor or materials are logged");
    // Deleted, because invoices_one_open_draft_draw would otherwise wall off every retry.
    expect(calls.some((c) => c.table === "invoices" && c.verb === "delete")).toBe(true);
    // Still logged for triage.
    expect(seen.some((a) => a[0] === "createProgressReportInvoice.labor")).toBe(true);
  });

  it("refuses out loud when the materials import fails, after labor already landed", async () => {
    spies.reportError = () => {};
    state.client = fakeSupabase(
      drawRoute({
        bills: [{ id: "b-1", supplier: "CED", bill_number: "9012345", amount: "120.00", po_id: null, pricing_provisional: false }],
        costsRpcError: { code: "P0001", message: "materials already billed on INV-070" },
      }),
      calls,
    );

    const res: any = await createProgressReportInvoice(JOB, "final");
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("INV-070");
    expect(calls.some((c) => c.table === "invoices" && c.verb === "delete")).toBe(true);
  });

  it("still passes quietly when a side is merely EMPTY — a labor-only job is not a failure", async () => {
    spies.reportError = () => {};
    // No bills and no POs on the job: importCostsIntoInvoice returns empty:true, which is normal.
    state.client = fakeSupabase(drawRoute({}), calls);
    const res: any = await createProgressReportInvoice(JOB, "progress");
    expect(res.ok).toBe(true);
    expect(res.id).toBe(NEW_DRAW);
    expect(calls.some((c) => c.table === "invoices" && c.verb === "delete")).toBe(false);
  });
});

// ── Finding 3: the words on the customer's document are a revision too (0269) ──────────────────

/** A DELIVERED invoice: sent_at set, revised_at still null. */
function headerRoute(opts: { sentAt: string | null; rowsWritten: number }) {
  return (q: Q): Reply => {
    if (q.table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } } };
    if (q.table === "invoices" && q.verb === "select" && q.cols.includes("sent_at")) return { data: { sent_at: opts.sentAt } };
    if (q.table === "invoices" && q.verb === "update") {
      const wrote = Array.from({ length: opts.rowsWritten }, () => ({ id: INV }));
      return { data: wrote };
    }
    return undefined;
  };
}

const stampedOn = (calls: Q[]) =>
  calls.filter((c) => c.table === "invoices" && c.verb === "update" && c.payload && "revised_at" in c.payload).length;

describe("the scope block, the title and the due date are revisions (0269)", () => {
  it("stamps revised_at when the scope is rewritten on a delivered invoice", async () => {
    state.client = fakeSupabase(headerRoute({ sentAt: "2026-09-01T18:00:00Z", rowsWritten: 1 }), calls);
    const res = await setInvoiceDescription(INV, "Panel upgrade, 200A");
    expect(res.ok).toBe(true);
    expect(stampedOn(calls)).toBe(1);
  });

  it("stamps revised_at when the title changes on a delivered invoice", async () => {
    state.client = fakeSupabase(headerRoute({ sentAt: "2026-09-01T18:00:00Z", rowsWritten: 1 }), calls);
    const res = await setInvoiceTitle(INV, "Service change, 13631 Northwoods");
    expect(res.ok).toBe(true);
    expect(stampedOn(calls)).toBe(1);
  });

  it("stamps revised_at when the due date is pulled in on a delivered invoice", async () => {
    state.client = fakeSupabase(headerRoute({ sentAt: "2026-09-01T18:00:00Z", rowsWritten: 1 }), calls);
    const res = await setInvoiceDueDate(INV, "2026-09-15");
    expect(res.ok).toBe(true);
    expect(stampedOn(calls)).toBe(1);
  });

  it("stamps nothing on a DRAFT — editing a draft is building it", async () => {
    state.client = fakeSupabase(headerRoute({ sentAt: null, rowsWritten: 1 }), calls);
    await setInvoiceDescription(INV, "Rough-in only");
    await setInvoiceTitle(INV, "Rough-in");
    await setInvoiceDueDate(INV, "2026-10-01");
    expect(stampedOn(calls)).toBe(0);
  });

  it("refuses out loud when the update touches no row (the silent-write law)", async () => {
    for (const run of [
      () => setInvoiceDescription(INV, "Panel upgrade"),
      () => setInvoiceTitle(INV, "Panel upgrade"),
      () => setInvoiceDueDate(INV, "2026-09-15"),
    ]) {
      calls = [];
      state.client = fakeSupabase(headerRoute({ sentAt: "2026-09-01T18:00:00Z", rowsWritten: 0 }), calls);
      const res = await run();
      expect(res.ok).toBe(false);
      expect(res.error).toBe("That didn't save - check your access and try again.");
      expect(stampedOn(calls)).toBe(0); // a stamp never follows a write that did not land
    }
  });
});
