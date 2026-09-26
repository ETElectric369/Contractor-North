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
  importLaborIntoInvoice,
  importQuoteItemsIntoInvoice,
  createProgressReportInvoice,
  setInvoiceDescription,
  setInvoiceTitle,
  setInvoiceDueDate,
  settleUp,
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
    let r = route(q);
    // upsertImportedItems' own read of the lines on each side of the RPC (a present line is never
    // dropped by a stale tombstone; what it removes is named). Routed here once for every test that
    // doesn't say otherwise: nothing on the invoice, so nothing stale and nothing removed.
    if (r === undefined && q.table === "invoice_items" && q.verb === "select" && q.cols === "id, import_key, description, line_total") r = { data: [] };
    // The job's takes from stock (Shop Stock, Phase 3): an empty shelf, as every org is today,
    // unless a test routes its own.
    if (r === undefined && q.table === "stock_moves" && q.verb === "select") r = { data: [] };
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
function costsImportRoute(opts: {
  bills: any[];
  lines: any[];
  landedAfter: string[];
  rpcError?: any;
  onInvoice?: any[];
  /** What the invoice holds BEFORE the import (the room a return has), and what landed before it. */
  existing?: any[];
  landedBefore?: string[];
  /** The source_ids this invoice's own materials lines already carry (returns credited HERE). */
  heldHere?: string[][];
  heldHereError?: any;
}) {
  return (q: Q): Reply => {
    if (q.table === "invoices" && q.verb === "select") {
      if (q.cols === "dismissed_import_keys") return { data: { dismissed_import_keys: [] } };   // returnsThatFit's room
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
        const ids = seen === 0 ? opts.landedBefore ?? [] : opts.landedAfter;
        return { data: ids.map((id) => ({ import_key: `bill:${id}`, edited: false, source_ids: [id] })) };
      }
      if (q.cols === "import_source, import_key, line_total, edited") return { data: opts.existing ?? [] }; // returnsThatFit's room
      if (q.cols === "line_total") return { data: [] };                       // recalcInvoice
      if (q.cols === "import_key, line_total, edited") return { data: opts.onInvoice ?? [] }; // edited tax rows
      if (q.cols === "source_ids") {                                           // returns credited on THIS invoice (DB3)
        return opts.heldHereError ? { error: opts.heldHereError } : { data: (opts.heldHere ?? []).map((s) => ({ source_ids: s })) };
      }
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

describe("importCostsIntoInvoice — a supplier return reaches the invoice (INV-078)", () => {
  /** The return as filed: four LED housings back to CED, -$51.58, every figure negative. */
  const RET = { id: "2f328286-b134-428f-a8b5-ad7702c15453", supplier: "Consolidated Electrical Dist.", bill_number: null, amount: "-51.58", po_id: null, pricing_provisional: false };
  const RET_LINES = (billable: boolean) => [
    { id: "8a5a091c", bill_id: RET.id, description: "H245ICAT 4 in LED Shallow IC HSG", quantity: "-4.00", unit_price: "-11.83", amount: "-47.32", category: "Electrical", sort_order: 0, billable, billed_amount: null },
    { id: "5f575ae5", bill_id: RET.id, description: "Sales Tax", quantity: "1.00", unit_price: "-4.26", amount: "-4.26", category: "Tax", sort_order: 1, billable, billed_amount: null },
  ];
  /** An ordinary receipt on the same job, so the import has something else to carry. */
  const BUY = { id: "c9daf1b8-03fb-4435-a518-24a000d31c3a", supplier: "Consolidated Electrical Dist.", bill_number: null, amount: "103.99", po_id: null, pricing_provisional: false };
  const BUY_LINES = [
    { id: "d26f3d69", bill_id: BUY.id, description: "4 in RL 600/900LM 5CCT D2W", quantity: "4.00", unit_price: "23.85", amount: "95.40", category: "Electrical", sort_order: 0, billable: true, billed_amount: null },
    { id: "5f226fd0", bill_id: BUY.id, description: "Tax @ 9.00000%", quantity: "1.00", unit_price: "8.59", amount: "8.59", category: "Tax", sort_order: 1, billable: true, billed_amount: null },
  ];
  const offered = () => (calls.find((c) => c.table === "rpc:upsert_imported_invoice_items")?.payload?.p_rows ?? []) as any[];

  it("imports a billable return as credit rows at the job's markup, claimed by the return's id, and says so", async () => {
    state.client = fakeSupabase(costsImportRoute({ bills: [BUY, RET], lines: [...BUY_LINES, ...RET_LINES(true)], landedAfter: [BUY.id, RET.id] }), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(true);
    const credit = offered().filter((r) => (r.source_ids ?? []).includes(RET.id));
    expect(credit.map((r) => [r.description, r.quantity, r.unit_price])).toEqual([
      ["Returned: H245ICAT 4 in LED Shallow IC HSG", 4, -13.61],
      ["Returned: tax", 1, -4.88],
    ]);
    // Claimed exactly like a purchase: every row carries the bill's id and nothing else.
    for (const r of credit) expect(r.source_ids).toEqual([RET.id]);
    expect(Math.round(credit.reduce((s, r) => s + r.quantity * r.unit_price, 0) * 100) / 100).toBe(-59.32);
    expect(res.stats.summary).toContain("a supplier return credited back to the customer: -$59.32");
  });

  it("never credits a return twice: one another invoice holds is skipped, and named", async () => {
    const base = costsImportRoute({ bills: [RET], lines: RET_LINES(true), landedAfter: [] });
    state.client = fakeSupabase((q) => {
      if (q.table === "invoice_items" && q.verb === "select" && q.cols.includes("invoices!inner")) {
        return {
          data: [
            {
              import_key: `bill:${RET.id}:remainder`,
              source_ids: [RET.id],
              invoices: { id: "inv-077", invoice_number: "INV-077", status: "sent", created_at: "2026-09-20T00:00:00Z", job_id: JOB, jobs: { job_number: "J-050" } },
            },
          ],
        };
      }
      return base(q);
    }, calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(false);
    expect(res.empty).toBe(true);
    expect(res.error).toContain("already on INV-077");
    expect(calls.some((c) => c.table === "rpc:upsert_imported_invoice_items")).toBe(false);
  });

  it("credits nothing for the INV-078 return as Erik left it (every line switched off), and says why", async () => {
    state.client = fakeSupabase(costsImportRoute({ bills: [BUY, RET], lines: [...BUY_LINES, ...RET_LINES(false)], landedAfter: [BUY.id] }), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(true);
    // Nothing new appears for the return: the rows offered are exactly the purchase's.
    expect(offered().every((r) => (r.source_ids ?? []).includes(BUY.id))).toBe(true);
    expect(offered().some((r) => r.unit_price < 0)).toBe(false);
    expect(res.stats.summary).toContain(
      "the Consolidated Electrical Dist. return of $51.58 not credited — none of what went back was billed to the customer",
    );
    expect(res.stats.summary).not.toContain("credited back");
  });

  it("a non-billable return alone is a sentence with the reason, not \"no bills yet\"", async () => {
    state.client = fakeSupabase(costsImportRoute({ bills: [RET], lines: RET_LINES(false), landedAfter: [] }), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(false);
    expect(res.empty).toBe(true);
    expect(res.error).toContain("return of $51.58 not credited");
    expect(res.error).not.toContain("No purchase orders or bills");
  });

  it("does not say \"credited back\" again on a re-import of a draft that already holds the credit", async () => {
    state.client = fakeSupabase(
      costsImportRoute({ bills: [BUY, RET], lines: [...BUY_LINES, ...RET_LINES(true)], landedBefore: [BUY.id, RET.id], landedAfter: [BUY.id, RET.id] }),
      calls,
    );
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(true);
    expect(offered().some((r) => (r.source_ids ?? []).includes(RET.id))).toBe(true); // still refreshed
    expect(res.stats.summary).not.toContain("credited back");
  });

  it("holds a return bigger than the invoice: no credit rows, no claim, and the summary says why", async () => {
    // The return alone, on an empty draft: crediting it would put the invoice at -$59.32, which
    // settles as paid the moment it is sent and loses the credit.
    state.client = fakeSupabase(costsImportRoute({ bills: [RET], lines: RET_LINES(true), landedAfter: [] }), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(false);
    expect(res.empty).toBe(true);
    expect(res.error).toContain("return ($59.32 back to the customer) held");
    expect(res.error).toContain("next invoice on this job that bills more than it");
    expect(calls.some((c) => c.table === "rpc:upsert_imported_invoice_items")).toBe(false);
  });

  it("lands the return when the invoice's own lines already bill more than it", async () => {
    // $95 of labor already on the draft: room for the $59.32 credit.
    state.client = fakeSupabase(
      costsImportRoute({
        bills: [RET],
        lines: RET_LINES(true),
        landedAfter: [RET.id],
        existing: [{ import_source: "labor", import_key: "labor:p-1", line_total: 95, edited: false }],
      }),
      calls,
    );
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(true);
    expect(offered().every((r) => (r.source_ids ?? []).includes(RET.id))).toBe(true);
    expect(res.stats.summary).toContain("credited back to the customer: -$59.32");
  });

  it("credits only what the customer was billed for the purchase: a box billed in part, then returned", async () => {
    // A $108.36 Twister box, billed to this job at $13.00 (0272), then the box goes back. The
    // return line carries no split of its own - the app cannot set one there - so the cap comes
    // from the purchase: $13.00 + its tax share, marked up, never the whole box.
    const BOX = { id: "11111111-0000-4000-8000-000000000001", supplier: "CED", bill_number: null, amount: "118.11", po_id: null, pricing_provisional: false };
    const BOX_LINES = [
      { id: "b1", bill_id: BOX.id, description: "IDEAL 30641 Twister 341-Tan 500", quantity: "1", unit_price: "108.36", amount: "108.36", category: "Electrical", sort_order: 0, billable: true, billed_amount: "13.00" },
      { id: "b2", bill_id: BOX.id, description: "Tax", quantity: "1", unit_price: "9.75", amount: "9.75", category: "Tax", sort_order: 1, billable: true, billed_amount: null },
    ];
    const BACK = { id: "22222222-0000-4000-8000-000000000002", supplier: "CED", bill_number: null, amount: "-118.11", po_id: null, pricing_provisional: false };
    const BACK_LINES = [
      { id: "r1", bill_id: BACK.id, description: "IDEAL 30641 Twister 341-Tan 500", quantity: "-1", unit_price: "-108.36", amount: "-108.36", category: "Electrical", sort_order: 0, billable: true, billed_amount: null },
      { id: "r2", bill_id: BACK.id, description: "Tax", quantity: "1", unit_price: "-9.75", amount: "-9.75", category: "Tax", sort_order: 1, billable: true, billed_amount: null },
    ];
    state.client = fakeSupabase(
      costsImportRoute({ bills: [BOX, BACK], lines: [...BOX_LINES, ...BACK_LINES], landedAfter: [BOX.id, BACK.id] }),
      calls,
    );
    const res: any = await importCostsIntoInvoice(INV, 25);
    expect(res.ok).toBe(true);
    const sumOf = (id: string) => Math.round(offered().filter((r) => (r.source_ids ?? []).includes(id)).reduce((t, r) => t + r.quantity * r.unit_price, 0) * 100) / 100;
    // The purchase bills $13.00 + $1.17 tax share = $14.17 × 1.25 = $17.71; the return credits
    // exactly that back, and not the $147.64 the whole box would be.
    expect(sumOf(BOX.id)).toBe(17.71);
    expect(sumOf(BACK.id)).toBe(-17.71);
    expect(offered().find((r) => r.import_key === "bli:r1")?.description).toBe("Returned: IDEAL 30641 Twister 341-Tan 500 (the part this job was billed)");
  });

  /**
   * A CREDITED RETURN SPENDS THE PURCHASE FIRST (audit v994, DB3). Four housings billed $100. R1
   * (all four) is credited on INV-077 and its uuid sorts LAST; R2 (two more, a later paper) sorts
   * first. In uuid order R2 took the whole $100 and this import credited Andrew $57.50 more.
   */
  describe("the budget a credited return already spent is never spent again (DB3)", () => {
    const HOUSINGS = { id: "55555555-0000-4000-8000-000000000005", supplier: "CED", bill_number: null, amount: "100.00", po_id: null, pricing_provisional: false, created_at: "2026-09-01T10:00:00Z" };
    const HOUSING_LINES = [
      { id: "h1", bill_id: HOUSINGS.id, description: "4 in LED SHALLOW IC HSG", quantity: "4", unit_price: "25", amount: "100", category: "Electrical", sort_order: 0, billable: true, billed_amount: null },
    ];
    const back = (id: string, count: number, created_at: string) => ({
      bill: { id, supplier: "CED", bill_number: null, amount: String(-25 * count), po_id: null, pricing_provisional: false, created_at },
      lines: [{ id: `${id.slice(0, 4)}-l`, bill_id: id, description: "H245ICAT 4 in LED Shallow IC HSG", quantity: String(-count), unit_price: "-25", amount: String(-25 * count), category: "Electrical", sort_order: 0, billable: true, billed_amount: null }],
    });
    const R1 = back("ffffffff-0000-4000-8000-00000000000f", 4, "2026-09-05T10:00:00Z");
    const R2 = back("00000000-0000-4000-8000-000000000002", 2, "2026-09-20T10:00:00Z");
    const LABOR = [{ import_source: "labor", import_key: "labor:p-1", line_total: 500, edited: false }];

    it("a later return whose uuid sorts first credits nothing once the earlier return, credited elsewhere, used the purchase up", async () => {
      const base = costsImportRoute({ bills: [HOUSINGS, R2.bill, R1.bill], lines: [...HOUSING_LINES, ...R2.lines, ...R1.lines], landedAfter: [HOUSINGS.id], existing: LABOR });
      state.client = fakeSupabase((q) => {
        if (q.table === "invoice_items" && q.verb === "select" && q.cols.includes("invoices!inner")) {
          return {
            data: [{ import_key: `bli:${R1.lines[0].id}`, source_ids: [R1.bill.id], invoices: { id: "inv-077", invoice_number: "INV-077", status: "sent", created_at: "2026-09-06T00:00:00Z", job_id: JOB, jobs: { job_number: "J-050" } } }],
          };
        }
        return base(q);
      }, calls);
      const res: any = await importCostsIntoInvoice(INV, 15);
      expect(res.ok).toBe(true);
      expect(offered().some((r) => (r.source_ids ?? []).includes(R2.bill.id))).toBe(false);
      expect(offered().some((r) => r.unit_price < 0)).toBe(false);
      expect(res.stats.summary).toContain("the CED return of $50.00 not credited");
    });

    it("a re-import of a draft that already credits R1 keeps R1's credit whole, even when R2 was filed earlier", async () => {
      const early = back("00000000-0000-4000-8000-000000000003", 2, "2026-09-02T10:00:00Z");
      state.client = fakeSupabase(
        costsImportRoute({
          bills: [HOUSINGS, early.bill, R1.bill],
          lines: [...HOUSING_LINES, ...early.lines, ...R1.lines],
          landedBefore: [HOUSINGS.id, R1.bill.id],
          landedAfter: [HOUSINGS.id, R1.bill.id],
          existing: LABOR,
          heldHere: [[HOUSINGS.id], [R1.bill.id]],
        }),
        calls,
      );
      const res: any = await importCostsIntoInvoice(INV, 0);
      expect(res.ok).toBe(true);
      const sumOf = (id: string) => Math.round(offered().filter((r) => (r.source_ids ?? []).includes(id)).reduce((t, r) => t + r.quantity * r.unit_price, 0) * 100) / 100;
      expect(sumOf(R1.bill.id)).toBe(-100);
      expect(sumOf(early.bill.id)).toBe(0);
    });

    it("a lost read of this invoice's own lines refuses, nothing written", async () => {
      state.client = fakeSupabase(
        costsImportRoute({ bills: [HOUSINGS, R2.bill], lines: [...HOUSING_LINES, ...R2.lines], landedAfter: [], existing: LABOR, heldHereError: { message: "timeout" } }),
        calls,
      );
      const res: any = await importCostsIntoInvoice(INV, 15);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("nothing was imported");
      expect(calls.some((c) => c.table === "rpc:upsert_imported_invoice_items")).toBe(false);
    });

    it("asks the bills read for created_at, so filing order can be read at all", async () => {
      state.client = fakeSupabase(costsImportRoute({ bills: [HOUSINGS, R2.bill], lines: [...HOUSING_LINES, ...R2.lines], landedAfter: [HOUSINGS.id, R2.bill.id], existing: LABOR }), calls);
      await importCostsIntoInvoice(INV, 15);
      expect(calls.find((c) => c.table === "bills" && c.verb === "select")?.cols).toContain("created_at");
    });
  });

  it("still skips a zero bill: it is neither a cost nor a credit", async () => {
    const zero = { ...RET, id: "57118d9f-c69e-4d32-9747-dca98d162771", amount: "0.00" };
    state.client = fakeSupabase(costsImportRoute({ bills: [zero], lines: [], landedAfter: [] }), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("No purchase orders or bills on this job yet.");
  });
});

// ── Finding 2: the draw must not swallow a real import failure ────────────────────────────────

const NEW_DRAW = "0dda0000-0000-4000-8000-00000000000d";

/** Everything createProgressReportInvoice reads before it writes a row. `rpcError` fails the
 *  labor import the way 0260's guard_invoice_item_claim does — a genuine concurrent claim. */
function drawRoute(opts: { laborRpcError?: any; costsRpcError?: any; bills?: any[]; lump?: number }) {
  return (q: Q): Reply => {
    if (q.table === "jobs" && q.cols.includes("customer_id")) return { data: { customer_id: "cust-1", name: "Jason Waldow" } };
    if (q.table === "jobs") return { data: null }; // customerLaborRate / customerMaterialMarkup
    if (q.table === "organizations") return { data: { settings: { default_labor_rate: 95, material_markup_percent: 20, invoice_due_days: 30 } } };
    if (q.table === "payment_milestones") return { data: null };
    if (q.table === "invoices" && q.verb === "select") {
      if (q.cols === "invoice_number") return { data: null };                       // no open draft draw
      if (q.cols.includes("invoice_items(import_source")) {                         // fixedBillingsNotYetNetted
        return { data: opts.lump ? [{ id: "dep-1", status: "paid", invoice_kind: "deposit", invoice_items: [{ import_source: null, line_total: opts.lump }] }] : [] };
      }
      if (q.cols.includes("invoice_items(import_key")) return { data: [] };         // claimedSourcesOnJob
      if (q.cols.includes("total, invoice_kind")) return { data: [] };              // standardBillingBlockerOnJob
      if (q.cols.includes("invoice_kind") && q.cols.includes("job_id") && q.single) return { data: { id: NEW_DRAW, job_id: JOB, invoice_kind: "progress" } };
      if (q.cols.includes("invoice_number")) return { data: [] };                   // activeDrawOnJob
      if (q.cols === "status") return { data: { status: "draft" } };
      if (q.cols === "subtotal") return { data: { subtotal: 665 } }; // the 7 hr the labor import landed
      if (q.cols === "dismissed_import_keys") return { data: { dismissed_import_keys: [] } };
      if (q.cols.includes("sent_at")) return { data: { sent_at: null } };
      if (q.cols.includes("tax_rate")) return { data: { tax_rate: 0, status: "draft" } };
    }
    if (q.table === "invoices" && q.verb === "insert") return { data: { id: NEW_DRAW, invoice_number: "INV-081" } };
    if (q.table === "invoice_items" && q.verb === "insert") return { data: null }; // the draw_credit line
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
      if (q.cols === "source_ids") return { data: [] }; // returns credited on this new draw (none)
      if (q.cols === "line_total") return { data: [] };
      if (q.cols === "import_key, line_total, edited") return { data: [] };
      // The draw's labor, already landed when the costs import measures a return's room.
      if (q.cols === "import_source, import_key, line_total, edited") return { data: [{ import_source: "labor", import_key: "labor:p-1", line_total: 665, edited: false }] };
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

describe("createProgressReportInvoice — a deposit that covers the work is said before a number is taken", () => {
  it("refuses with no insert when the un-netted deposit covers all the new work", async () => {
    spies.reportError = () => {};
    state.client = fakeSupabase(drawRoute({ lump: 1000 }), calls); // 7 hr = $665 of work
    const res: any = await createProgressReportInvoice(JOB, "progress");
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/already covers the \$665\.00/);
    expect(calls.some((c) => c.table === "invoices" && (c.verb === "insert" || c.verb === "delete"))).toBe(false);
  });

  it("a partly covered report says the deposit came off", async () => {
    spies.reportError = () => {};
    state.client = fakeSupabase(drawRoute({ lump: 200 }), calls);
    const res: any = await createProgressReportInvoice(JOB, "progress");
    expect(res.ok).toBe(true);
    expect(res.note).toBe("Started INV-081 for the work not yet billed, less the $200.00 deposit not yet taken off a bill.");
  });
});

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

  it("bills the new labor when a pending supplier return outweighs it, and holds the return", async () => {
    spies.reportError = () => {};
    // 7 hr ($665) of unclaimed labor and a $1,000 return ($1,200 at 20%): the net is below zero,
    // but the labor is real and unbilled. The gate reads the WORK, not the net; the return is held
    // by the costs import because it would take the draw below zero.
    state.client = fakeSupabase(
      drawRoute({ bills: [{ id: "b-ret", supplier: "CED", bill_number: null, amount: "-1000.00", po_id: null, pricing_provisional: false }] }),
      calls,
    );
    const res: any = await createProgressReportInvoice(JOB, "progress");
    expect(res.ok).toBe(true);
    expect(res.id).toBe(NEW_DRAW);
    const costs = calls.filter((c) => c.table === "rpc:upsert_imported_invoice_items" && c.payload?.p_source === "costs");
    expect(costs.length).toBe(0); // the return was held, so nothing negative was written
    expect(calls.some((c) => c.table === "invoices" && c.verb === "delete")).toBe(false);
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

// ── J-011: a draw built from actuals is refreshed like an invoice; a contract draw refuses ──────

const OPEN_DRAW = "0dda0000-0000-4000-8000-000000000078"; // INV-078
const CONTRACT_DRAW = "0dda0000-0000-4000-8000-000000000080"; // INV-080, "50% of remaining estimate"
const TE_OLD = "7e000000-0000-4000-8000-000000000001";
const TE_NEW = "7e000000-0000-4000-8000-000000000002";
const B_OLD = "b1000000-0000-4000-8000-000000000001";
const B_NEW = "b1000000-0000-4000-8000-000000000002";

/**
 * A job with ONE open draft draw. `actuals`: INV-078 — an edited labor line (Andrew's rate) holding
 * last month's shift and a materials line holding last month's bill; since then a new 6-hour shift
 * and a new $323.71 bill. Otherwise INV-080, a contract draw with one hand line. `schedule` puts a
 * payment schedule on the job. The claims move as the RPC writes, so the before/after measure is real.
 */
function openDrawRoute(opts: { actuals: boolean; schedule?: boolean; lump?: number; oldBillLine?: number; laborQty?: string }) {
  const drawId = opts.actuals ? OPEN_DRAW : CONTRACT_DRAW;
  const number = opts.actuals ? "INV-078" : "INV-080";
  const landed = new Set<string>();
  const drawItems = () =>
    opts.actuals
      ? [
          { import_key: "labor:p-1", source_ids: [TE_OLD] },
          { import_key: `bill:${B_OLD}`, source_ids: [B_OLD] },
          ...[...landed].map((id) => ({ import_key: `landed:${id}`, source_ids: [id] })),
        ]
      : [{ import_key: null, source_ids: null }];
  return (q: Q): Reply => {
    if (q.table === "jobs" && q.cols.includes("customer_id")) return { data: { customer_id: "cust-1", name: "13897 Herringbone" } };
    if (q.table === "jobs") return { data: { customers: { pricing_levels: { markup_pct: 15, labor_rate: null } } } };
    if (q.table === "organizations") return { data: { settings: { default_labor_rate: 95, material_markup_percent: 25, invoice_due_days: 30 } } };
    if (q.table === "payment_milestones") return { data: opts.schedule ? (q.single ? { id: "m-1" } : [{ id: "m-1" }]) : q.single ? null : [] };
    if (q.table === "invoices" && q.verb === "select") {
      if (q.cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) {
        return { data: [{ id: drawId, invoice_number: number, invoice_kind: "progress", dismissed_import_keys: [] }] }; // openDraftOnJob
      }
      // fixedBillingsNotYetNetted: a $X deposit sent after this report was made, never netted.
      if (q.cols.includes("invoice_items(import_source")) {
        return { data: opts.lump ? [{ id: "dep-1", status: "sent", invoice_kind: "deposit", invoice_items: [{ import_source: null, line_total: opts.lump }] }] : [] };
      }
      if (q.cols.includes("invoice_items(import_key")) {
        return { data: [{ id: drawId, invoice_number: number, status: "draft", created_at: "2026-08-02T00:00:00Z", job_id: JOB, invoice_items: drawItems() }] };
      }
      if (q.cols.includes("invoice_kind") && q.cols.includes("job_id") && q.single) {
        return { data: { id: drawId, job_id: JOB, invoice_kind: "progress", invoice_number: number, quote_id: null } };
      }
      if (q.cols === "status") return { data: { status: "draft" } };
      if (q.cols === "dismissed_import_keys") return { data: { dismissed_import_keys: [] } };
      if (q.cols.includes("sent_at")) return { data: { sent_at: null } };
      if (q.cols.includes("tax_rate")) return { data: { tax_rate: 0, status: "draft" } };
    }
    if (q.table === "invoices" && q.verb === "update") return { data: null };
    if (q.table === "time_entries") {
      return {
        data: [
          { id: TE_OLD, clock_in: "2026-08-01T15:00:00Z", clock_out: "2026-08-01T23:00:00Z", lunch_minutes: 0, job_code: null, profiles: { id: "p-1", full_name: "Erik" } },
          { id: TE_NEW, clock_in: "2026-09-22T15:00:00Z", clock_out: "2026-09-22T21:00:00Z", lunch_minutes: 0, job_code: null, profiles: { id: "p-1", full_name: "Erik" } },
        ],
      };
    }
    if (q.table === "job_codes") return { data: [] };
    if (q.table === "profile_pay") return { data: [{ id: "p-1", hourly_rate: 45, bill_rate: 115 }] };
    if (q.table === "purchase_orders") return { data: [] };
    if (q.table === "bills") {
      return {
        data: [
          { id: B_OLD, supplier: "CED", bill_number: "1", amount: "100.00", po_id: null, pricing_provisional: false, bill_line_items: [] },
          { id: B_NEW, supplier: "CED", bill_number: "2", amount: "323.71", po_id: null, pricing_provisional: false, bill_line_items: [] },
        ],
      };
    }
    if (q.table === "bill_line_items") return { data: [] };
    if (q.table === "invoice_items" && q.verb === "select") {
      if (q.cols === "import_source") return { data: opts.actuals ? [{ import_source: "labor" }, { import_source: "costs" }] : [{ import_source: null }] };
      if (q.cols === "id, source_ids, import_key, edited, quantity, unit_price, unit, description") {
        return { data: opts.actuals ? [{ id: "li-1", import_key: "labor:p-1", edited: true, source_ids: [TE_OLD], quantity: opts.laborQty ?? "8.00", unit_price: "100.00", unit: "hr", description: "Labor - Erik" }] : [] };
      }
      if (q.cols.includes("invoices!inner")) return { data: [] };
      if (q.cols.includes("import_key, edited")) return { data: drawItems().map((i) => ({ ...i, edited: false })) };
      if (q.cols === "line_total") return { data: [] };
      if (q.cols === "import_key, line_total, edited") return { data: [] };
      if (q.cols === "import_source, import_key, line_total, edited") return { data: [] };
      // The draw's own materials lines, for the markup it is already priced at (lib/invoice-markup):
      // last month's $100 bill, at 15% unless the test says the office re-priced it.
      if (q.cols === "import_key, source_ids, line_total, edited") {
        return { data: opts.actuals ? [{ import_key: `bill:${B_OLD}`, source_ids: [B_OLD], line_total: opts.oldBillLine ?? 115, edited: false }] : [] };
      }
    }
    // THE JOIN (Erik's INV-078 rule): the new hours onto the edited line, checked.
    if (q.table === "invoice_items" && q.verb === "update") {
      for (const id of q.payload?.source_ids ?? []) landed.add(id);
      return { data: [{ id: "li-1" }] };
    }
    if (q.table === "payments") return { data: [] };
    if (q.table === "customer_credits") return { data: [] };
    if (q.table === "rpc:upsert_imported_invoice_items") {
      // The RPC keeps an edited line as it is, claims included: only the costs offer lands here.
      if (q.payload?.p_source !== "labor") for (const r of q.payload?.p_rows ?? []) for (const id of r.source_ids ?? []) landed.add(id);
      return { data: { inserted: 1, updated: 0, kept_edited: q.payload?.p_source === "labor" ? 1 : 0, removed: 0 } };
    }
    return undefined;
  };
}

describe("J-011 — a draw built from actuals takes new work; a contract draw refuses it (server)", () => {
  it("Progress Payment → Actual T&M with INV-078 open lands on INV-078: no second draw, new hours JOIN the negotiated line, says what it pulled", async () => {
    spies.reportError = () => {};
    state.client = fakeSupabase(openDrawRoute({ actuals: true }), calls);
    const res = await createProgressReportInvoice(JOB, "progress");
    expect(res.ok).toBe(true);
    expect(res.id).toBe(OPEN_DRAW);
    // No new draw was minted and nothing was deleted or promoted.
    expect(calls.some((c) => c.table === "invoices" && c.verb === "insert")).toBe(false);
    expect(calls.some((c) => c.table === "invoices" && c.verb === "delete")).toBe(false);
    // recalc rewrites the totals; the status it writes back is the draft's own.
    const statuses = calls.filter((c) => c.table === "invoices" && c.verb === "update" && c.payload && "status" in c.payload).map((c) => c.payload.status);
    expect(statuses.every((s) => s === "draft")).toBe(true);
    const rpcs = calls.filter((c) => c.table === "rpc:upsert_imported_invoice_items");
    expect(rpcs.every((c) => c.payload.p_invoice_id === OPEN_DRAW)).toBe(true);
    const labor = rpcs.find((c) => c.payload.p_source === "labor")!;
    // No second line for Erik: the new 6-hour shift JOINS his edited line, at its own $100.
    expect(labor.payload.p_rows.map((r: any) => r.import_key)).toEqual(["labor:p-1"]);
    const join = calls.find((c) => c.table === "invoice_items" && c.verb === "update");
    expect(join?.payload).toEqual({ quantity: 14, source_ids: [TE_OLD, TE_NEW] });
    const costs = rpcs.find((c) => c.payload.p_source === "costs")!;
    expect(costs.payload.p_rows.flatMap((r: any) => r.source_ids)).toEqual([B_NEW]); // the old bill is not offered again
    expect(costs.payload.p_rows[0].unit_price).toBe(372.27); // $323.71 at the customer's 15%
    expect(res.note).toBe("Pulled 6 hours and 1 bill into INV-078. Added 6 h to Labor - Erik at $100.");
  });

  it("a labor line bumped by hand past its entries takes no new hours: nothing joins, and the office is told (decision 1)", async () => {
    spies.reportError = () => {};
    // The line reads 11 h over the 8 h shift it holds - 3 h hand-set, like INV-069's "Labor - Erik".
    state.client = fakeSupabase(openDrawRoute({ actuals: true, laborQty: "11.00" }), calls);
    const res = await importLaborIntoInvoice(OPEN_DRAW);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.table === "invoice_items" && c.verb === "update")).toBe(false);
    expect((res as any).stats.warnings).toContain(
      "Labor - Erik shows 3 h more than the time entries it holds, so Erik's new 6 h were not added. They stay unbilled on the job - check the line's hours, then Labor from Timecards again",
    );
  });

  it("an open CONTRACT draw is named with its door, not a dead end, and nothing is written", async () => {
    state.client = fakeSupabase(openDrawRoute({ actuals: false }), calls);
    const res = await createProgressReportInvoice(JOB, "progress");
    expect(res.ok).toBe(false);
    expect(res.openDraft).toEqual({ id: CONTRACT_DRAW, number: "INV-080" });
    expect(String(res.error)).toContain("INV-080");
    expect(calls.some((c) => c.table === "rpc:upsert_imported_invoice_items" || c.verb === "insert")).toBe(false);
  });

  it("the importers themselves refuse actuals on a contract draw (H4 held on the server, not by a hidden button)", async () => {
    state.client = fakeSupabase(openDrawRoute({ actuals: false }), calls);
    const lab: any = await importLaborIntoInvoice(CONTRACT_DRAW);
    const cos: any = await importCostsIntoInvoice(CONTRACT_DRAW, 15);
    for (const r of [lab, cos]) {
      expect(r.ok).toBe(false);
      expect(r.empty).toBeUndefined();
      expect(String(r.error)).toMatch(/INV-080 bills a set part of the contract/);
    }
    expect(calls.some((c) => c.table === "rpc:upsert_imported_invoice_items")).toBe(false);
  });

  it("…and on a draw on a SCHEDULED job, even one carrying labor lines", async () => {
    state.client = fakeSupabase(openDrawRoute({ actuals: true, schedule: true }), calls);
    const lab: any = await importLaborIntoInvoice(OPEN_DRAW);
    expect(lab.ok).toBe(false);
    expect(calls.some((c) => c.table === "rpc:upsert_imported_invoice_items")).toBe(false);
  });

  it("the invoice page's Materials from Costs on INV-078 imports (the markup box reaches a draw built from actuals)", async () => {
    spies.reportError = () => {};
    state.client = fakeSupabase(openDrawRoute({ actuals: true }), calls);
    const cos: any = await importCostsIntoInvoice(OPEN_DRAW, 20);
    expect(cos.ok).toBe(true);
    const rpc = calls.find((c) => c.table === "rpc:upsert_imported_invoice_items")!;
    expect(rpc.payload.p_invoice_id).toBe(OPEN_DRAW);
    expect(rpc.payload.p_rows[0].unit_price).toBe(388.45); // $323.71 at the box's 20%
  });

  it("'Add to INV-078' keeps the markup the office typed on the draw (20%), not the customer's 15%", async () => {
    spies.reportError = () => {};
    // Last month's $100 bill sits on INV-078 at $120: Erik used the % box. The refresh reads that
    // back from the lines and prices the new $323.71 bill at 20% too - and says so.
    state.client = fakeSupabase(openDrawRoute({ actuals: true, oldBillLine: 120 }), calls);
    const res = await createProgressReportInvoice(JOB, "progress");
    expect(res.ok).toBe(true);
    const costs = calls.find((c) => c.table === "rpc:upsert_imported_invoice_items" && c.payload.p_source === "costs")!;
    expect(costs.payload.p_rows[0].unit_price).toBe(388.45);
    expect(res.note).toContain("20% markup already on this invoice");
  });

  it("the invoice's own % box still sets the markup (it is the office choosing it)", async () => {
    spies.reportError = () => {};
    state.client = fakeSupabase(openDrawRoute({ actuals: true, oldBillLine: 120 }), calls);
    const cos: any = await importCostsIntoInvoice(OPEN_DRAW, 10);
    expect(cos.ok).toBe(true);
    const rpc = calls.find((c) => c.table === "rpc:upsert_imported_invoice_items")!;
    expect(rpc.payload.p_rows[0].unit_price).toBe(356.08); // $323.71 at 10%
  });

  it("an actuals draw refuses new work while a later deposit is un-netted (it would bill on top of it)", async () => {
    spies.reportError = () => {};
    state.client = fakeSupabase(openDrawRoute({ actuals: true, lump: 2000 }), calls);
    const lab: any = await importLaborIntoInvoice(OPEN_DRAW);
    expect(lab.ok).toBe(false);
    expect(String(lab.error)).toMatch(/\$2,000\.00 of deposit/);
    expect(String(lab.error)).toMatch(/next progress payment/);
    expect(calls.some((c) => c.table === "rpc:upsert_imported_invoice_items")).toBe(false);
  });

  it("From Estimate never lands on a draw", async () => {
    state.client = fakeSupabase(openDrawRoute({ actuals: true }), calls);
    const res: any = await importQuoteItemsIntoInvoice(OPEN_DRAW);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/estimate/);
  });
});

/**
 * THE SAME TAP, TWICE, IS ONE PAYMENT (review of Connected North Phase 1).
 *
 * J-052: INV-074 sent weeks ago, open for $624.49. The job header's Record Payment lands the cash on
 * it; the answer is lost on truck LTE and the tech taps again. INV-074 is paid now, so it is no
 * longer "open" - without the guard the retry minted a second $624.49 bill and recorded the cash
 * twice. And a $300 part payment retried would put $300 on INV-074 twice.
 */
describe("settleUp — a retried Record Payment on the job's open bill records once, mints nothing", () => {
  const J052 = "0520aaaa-0000-4000-8000-000000000052";
  const INV074 = "0740aaaa-0000-4000-8000-000000000074";
  function jobPayRoute() {
    const payments: any[] = [];
    const paid = () => payments.reduce((s, p) => s + p.amount, 0);
    const route = (q: Q): Reply => {
      if (q.table === "jobs") return { data: { id: J052, name: "Panel swap", job_number: "J-052", customer_id: "cust-1", inquiry_id: null } };
      if (q.table === "invoices" && q.verb === "select") {
        if (q.cols === "id, created_at, total, amount_paid") return { data: null }; // INV-074 is weeks old
        if (q.cols === "id, invoice_number, status, total, amount_paid") {
          return { data: [{ id: INV074, invoice_number: "INV-074", status: paid() >= 624.49 ? "paid" : "sent", total: 624.49, amount_paid: paid() }] };
        }
        if (q.cols.startsWith("id, org_id, invoice_number, total, amount_paid")) {
          return { data: { id: INV074, org_id: "org-1", invoice_number: "INV-074", total: 624.49, amount_paid: paid(), customers: { name: "J" } } };
        }
      }
      if (q.table === "payments" && q.verb === "select" && q.cols === "id, invoice_id") {
        return { data: payments.length ? { id: "pay-1", invoice_id: INV074 } : null }; // same person, amount, method, <5 min
      }
      if (q.table === "payments" && q.verb === "insert") { payments.push(q.payload); return { data: null }; }
      return undefined;
    };
    return { route, payments };
  }

  it("full payment: the retry is answered as done, nothing minted, one payment", async () => {
    const { route, payments } = jobPayRoute();
    const fallback = (q: Q): Reply => route(q) ?? { data: q.single ? null : [] };
    state.client = fakeSupabase(fallback, calls);
    const input = { source: "job" as const, id: J052, amount: 624.49, method: "Cash" };
    const first = await settleUp(input);
    const second = await settleUp(input);
    expect(first).toMatchObject({ ok: true, invoiceId: INV074 });
    expect(second).toMatchObject({ ok: true, invoiceId: INV074 });
    expect(payments).toHaveLength(1);
    expect(calls.some((c) => c.table === "invoices" && c.verb === "insert")).toBe(false);
  });

  it("part payment: $300 retried is $300 once", async () => {
    const { route, payments } = jobPayRoute();
    state.client = fakeSupabase((q) => route(q) ?? { data: q.single ? null : [] }, calls);
    const input = { source: "job" as const, id: J052, amount: 300, method: "Cash" };
    await settleUp(input);
    const again = await settleUp(input);
    expect(again).toMatchObject({ ok: true, invoiceId: INV074 });
    expect(payments.map((p) => p.amount)).toEqual([300]);
  });

  it("a lost payments read records nothing and says so", async () => {
    const { route, payments } = jobPayRoute();
    state.client = fakeSupabase(
      (q) => (q.table === "payments" && q.verb === "select" && q.cols === "id, invoice_id" ? { error: { message: "timeout" } } : route(q) ?? { data: q.single ? null : [] }),
      calls,
    );
    const res = await settleUp({ source: "job", id: J052, amount: 300, method: "Cash" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing was recorded/);
    expect(payments).toHaveLength(0);
  });
});

describe("importCostsIntoInvoice — pieces taken from stock are billed once, one line per take (Shop Stock, Phase 3)", () => {
  const G1 = "a1111111-0000-4000-8000-000000000001";
  const G2 = "a2222222-0000-4000-8000-000000000002";
  const G3 = "a3333333-0000-4000-8000-000000000003";
  const M1 = "b1111111-0000-4000-8000-000000000001";
  const M2 = "b2222222-0000-4000-8000-000000000002";
  const M3 = "b3333333-0000-4000-8000-000000000003";
  const S1 = "c1111111-0000-4000-8000-000000000001";
  const moves = [
    { id: M1, item_id: "item-122", draw_group: G1, kind: "draw", qty: "60.000", cost: "43.24", created_at: "2026-09-24T16:00:00Z", returns_move_id: null, settled_by: null },
    { id: M2, item_id: "item-122", draw_group: G2, kind: "draw", qty: "20.000", cost: "14.41", created_at: "2026-09-25T16:00:00Z", returns_move_id: null, settled_by: null },
    { id: M3, item_id: "item-nut", draw_group: G3, kind: "draw", qty: "25.000", cost: "4.35", created_at: "2026-09-25T17:00:00Z", returns_move_id: null, settled_by: null },
    { id: S1, item_id: "item-122", draw_group: G3, kind: "short", qty: "15.000", cost: "0", created_at: "2026-09-25T17:00:00Z", returns_move_id: null, settled_by: null },
  ];
  const items = [
    { id: "item-122", name: "12/2 NM-B", unit: "ft" },
    { id: "item-nut", name: "Twister wire nut", unit: "ea" },
  ];
  /** The Waldow receipt plus three takes and a short; `heldElsewhere` = move ids another live invoice claims. */
  const route = (landedAfter: string[], heldElsewhere: string[] = []) => {
    const base = costsImportRoute({ bills: [{ ...WALDOW_BILL, pricing_provisional: false }], lines: WALDOW_LINES, landedAfter });
    return (q: Q): Reply => {
      if (q.table === "stock_moves" && q.verb === "select") return { data: moves };
      if (q.table === "inventory_items" && q.verb === "select") return { data: items };
      if (q.table === "invoice_items" && q.verb === "select" && q.cols.includes("invoices!inner"))
        return {
          data: heldElsewhere.length
            ? [{ import_key: `stock:${G2}`, source_ids: heldElsewhere, invoices: { id: "inv-other", invoice_number: "INV-080", status: "sent", created_at: "2026-09-25", job_id: JOB, jobs: null } }]
            : [],
        };
      if (q.table === "invoice_items" && q.verb === "update") return { data: [{ id: "x" }] };
      return base(q);
    };
  };

  it("adds one line per take after the bill rows, at the same markup, claimed by the moves, never the short", async () => {
    state.client = fakeSupabase(route([WALDOW_BILL.id, M1, M2, M3]), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(true);
    const rows = (calls.find((c) => c.table === "rpc:upsert_imported_invoice_items")?.payload?.p_rows ?? []) as any[];
    const stock = rows.filter((r) => String(r.import_key).startsWith("stock:"));
    // After every bill row, in the order the pieces were taken.
    expect(rows.findIndex((r) => String(r.import_key).startsWith("stock:"))).toBe(rows.length - stock.length);
    expect(stock).toEqual([
      { import_key: `stock:${G1}`, description: "12/2 NM-B, 60 ft", quantity: 1, unit: "ea", unit_price: 49.73, source_ids: [M1] },
      { import_key: `stock:${G2}`, description: "12/2 NM-B, 20 ft", quantity: 1, unit: "ea", unit_price: 16.57, source_ids: [M2] },
      { import_key: `stock:${G3}`, description: "Twister wire nut, 25 ea", quantity: 25, unit: "ea", unit_price: 0.2, source_ids: [M3] },
    ]);
    expect(rows.some((r) => (r.source_ids ?? []).includes(S1))).toBe(false);
    // The words a customer reads never say where a piece sat.
    for (const r of stock) expect(String(r.description)).not.toMatch(/shelf|stock|lot|roll|CED|supplier/i);
    // The bills are untouched by it: the receipt still bills 467.87 x 1.15 on its own rows.
    const billRows = rows.filter((r) => !String(r.import_key).startsWith("stock:"));
    expect(Math.round(billRows.reduce((s, r) => s + r.quantity * r.unit_price, 0) * 100) / 100).toBe(538.05);
    // Said: the takes that landed, and the short that did not, as a warning to read before sending.
    expect(res.stats.summary).toContain("3 takes from stock pulled in");
    expect(res.stats.stock_pulled_in).toBe(3);
    expect(res.stats.pulled_in).toBe(1); // the one bill, in its own noun
    expect(res.stats.warnings.join(" ")).toContain("15 ft of 12/2 NM-B was taken from stock with no roll behind it yet");
    // Stored as materials (0342), only where no kind is set.
    const kind = calls.find((c) => c.table === "invoice_items" && c.verb === "update");
    expect(kind?.payload).toEqual({ line_kind: "materials" });
  });

  it("a take another invoice already bills stays there, whole, and is named", async () => {
    state.client = fakeSupabase(route([WALDOW_BILL.id, M1, M3], [M2]), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(true);
    const rows = (calls.find((c) => c.table === "rpc:upsert_imported_invoice_items")?.payload?.p_rows ?? []) as any[];
    expect(rows.map((r) => r.import_key).filter((k: string) => k.startsWith("stock:"))).toEqual([`stock:${G1}`, `stock:${G3}`]);
    expect(res.stats.summary).toContain("1 take from stock already on INV-080 skipped");
    expect(res.stats.claimed_on).toContain("INV-080");
  });

  it("a take the office deleted from the invoice stays off, and is said with the door out", async () => {
    state.client = fakeSupabase(route([WALDOW_BILL.id, M1, M2]), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.stats.summary).toContain("2 takes from stock pulled in");
    expect(res.stats.summary).toContain("1 take from stock not added — on a line you edited or deleted (Start It Over rebuilds it)");
  });

  it("a lost read of the takes imports nothing and says so", async () => {
    const base = route([]);
    state.client = fakeSupabase((q) => (q.table === "stock_moves" ? { error: { code: "57014", message: "canceling statement" } } : base(q)), calls);
    const res: any = await importCostsIntoInvoice(INV, 15);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("pieces taken from stock");
    expect(calls.some((c) => c.table === "rpc:upsert_imported_invoice_items")).toBe(false);
  });
});
