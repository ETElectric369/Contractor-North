import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE THREE DOORS THAT PUT THINGS ON THE SHELF, PINNED (Shop Stock, Phase 2): File It to Shop Stock
 * from the tray, Put The Rest On The Shelf on a job's receipt line, and Record To Shelf on a CED
 * document. The database half (shelve_bill_lines, 0328) is proven in shelf-phase2.db-suite.ts; these
 * pin what the server writes, in what order, what it refuses before writing anything, and what it
 * takes back when the shelf refuses. Unscripted calls throw, so every statement is accounted for.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/anthropic", () => ({ DEFAULT_MODEL: "test-model", getAnthropic: () => ({}) }));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: async () => {}, modelFor: () => "test-model" }));
vi.mock("@/lib/analytics/job-profitability", () => ({ listJobScopes: async () => [] }));

import { fileItem } from "./actions";
import { putRestOnShelf } from "@/app/(app)/bills/receipt-billing-actions";
import { recordSupplierInvoiceToShelf } from "@/app/(app)/bills/supplier-actions";
import { SHELF_NEEDS_LINES } from "@/lib/shelf-plan";

type Call = { table: string; verb: string; payload?: any; eqs: [string, unknown][] };
type RpcCall = { fn: string; args: any };

function fakeSupabase(script: Record<string, any[]>, calls: Call[], rpcs: RpcCall[]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc: async (fn: string, args: any) => {
      rpcs.push({ fn, args });
      return next(`rpc.${fn}`);
    },
    from(table: string) {
      let verb = "select";
      const mine: Call = { table, verb, eqs: [] };
      let pushed = false;
      const push = () => {
        if (!pushed) {
          calls.push(mine);
          pushed = true;
        }
      };
      const chain: any = {
        insert(payload: any) { verb = "insert"; mine.verb = verb; mine.payload = payload; push(); return chain; },
        update(payload: any) { verb = "update"; mine.verb = verb; mine.payload = payload; push(); return chain; },
        delete() { verb = "delete"; mine.verb = verb; push(); return chain; },
        select() { if (verb === "select") push(); return chain; },
        eq(col: string, val: unknown) { mine.eqs.push([col, val]); return chain; },
        order() { return chain; },
        not() { return chain; },
        or() { return chain; },
        is() { return chain; },
        limit() { return chain; },
        neq() { return chain; },
        in() { return chain; },
        contains() { return chain; },
        single: () => Promise.resolve(next(`${table}.${verb}`)),
        maybeSingle: () => Promise.resolve(next(`${table}.${verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

let calls: Call[];
let rpcs: RpcCall[];
beforeEach(() => {
  calls = [];
  rpcs = [];
});
const did = (table: string, verb: string) => calls.find((c) => c.table === table && c.verb === verb);
const lastDid = (table: string, verb: string) => [...calls].reverse().find((c) => c.table === table && c.verb === verb);

// CED 8802-1103061, the STOCK document, as a photographed ticket in the tray.
const LINES = [
  { description: "RED/YELLOW CONN", quantity: 500, unit_price: 0.1697, amount: 84.85, category: "Materials" },
  { description: "PLSTC TAPE", quantity: 2, unit_price: 10.05, amount: 20.1, category: "Materials" },
  { description: "Sales Tax", quantity: 1, unit_price: 9.45, amount: 9.45, category: "Tax" },
];
const PAPER = {
  id: "oi-s",
  org_id: "org-1",
  kind: "receipt",
  status: "needs_review",
  doc_type: "bill",
  category: "Bill",
  title: "CED — $114.40",
  vendor: "CED",
  amount: 114.4,
  item_date: "2026-07-13",
  doc_number: null,
  payment: "on_account",
  line_items: LINES,
  proposal: { po: "STOCK", companyUse: { bucket: null, from: "po", words: "STOCK", shelf: true } },
  bill_id: null,
  document_id: null,
  petty_cash_id: null,
};
const CHOICES = [
  { index: 0, notStock: false as const, pieces: 500, unit: "ea", bought: 500, newItemName: "Red/Yellow connectors" },
  { index: 1, notStock: true as const },
];
const WRITTEN = [
  { id: "l0", sort_order: 0 },
  { id: "l1", sort_order: 1 },
  { id: "l2", sort_order: 2 },
];
const MONEY_LINES = [
  { id: "l0", description: "RED/YELLOW CONN", quantity: 500, unit_price: 0.17, amount: 84.85, category: "Materials", billable: true, billed_amount: null },
  { id: "l1", description: "PLSTC TAPE", quantity: 2, unit_price: 10.05, amount: 20.1, category: "Materials", billable: true, billed_amount: null },
  { id: "l2", description: "Sales Tax", quantity: 1, unit_price: 9.45, amount: 9.45, category: "Tax", billable: true, billed_amount: null },
];

describe("File It to Shop Stock (the tray)", () => {
  it("refuses a lineless ticket before claiming anything, in the plan's words", async () => {
    state.client = fakeSupabase({ "organized_items.select": [{ data: { ...PAPER, line_items: [] }, error: null }] }, calls, rpcs);
    const res = await fileItem("oi-s", { type: "stock", lines: [] });
    expect(res).toEqual({ ok: false, error: SHELF_NEEDS_LINES });
    expect(calls.filter((c) => c.verb !== "select")).toEqual([]);
  });

  it("refuses a ticket with a line nobody answered, before claiming anything", async () => {
    state.client = fakeSupabase({ "organized_items.select": [{ data: PAPER, error: null }] }, calls, rpcs);
    const res = await fileItem("oi-s", { type: "stock", lines: [CHOICES[0]] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("1 line is still open");
    expect(calls.filter((c) => c.verb !== "select")).toEqual([]);
  });

  it("files a shelf ticket: no job, on_shelf, Shop Stock; the counted line a roll at its full share; Not Stock left on the ticket", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: PAPER, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-s" }], error: null }, // the claim
          { data: [{ id: "oi-s" }], error: null }, // where it went
        ],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bills.insert": [{ data: { id: "bill-s" }, error: null }],
        "bill_line_items.insert": [{ data: WRITTEN, error: null }],
        "bill_line_items.select": [
          { data: WRITTEN, error: null }, // read back by sort_order
          { data: MONEY_LINES, error: null }, // shelveLines: the ticket's lines
        ],
        "stock_lot_balance.select": [
          { data: [], error: null }, // no rolls on it yet
          { data: [], error: null }, // restampLotsForBill after
        ],
        "inventory_items.select": [{ data: [], error: null }],
        "rpc.shelve_bill_lines": [{ data: { lots: [{ lot_id: "lot-1", item_id: "item-1", line_id: "l0" }] }, error: null }],
      },
      calls,
      rpcs,
    );
    const res = await fileItem("oi-s", { type: "stock", lines: CHOICES });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Filed on the shop shelf.");
    expect(res.message).toContain("500 ea ($92.49) on the shelf");
    expect(res.message).toContain("1 line marked Not Stock");
    expect(did("bills", "insert")!.payload).toMatchObject({ job_id: null, on_shelf: true, category: "Shop Stock", amount: 114.4 });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].args.p_bill).toBe("bill-s");
    expect(rpcs[0].args.p_lines).toEqual([
      { line_id: "l0", billed_amount: 0, pieces: 500, unit: "ea", cost: 92.49, item_id: null, item_name: "Red/Yellow connectors", key_part: null },
    ]);
    expect(lastDid("organized_items", "update")!.payload).toMatchObject({ status: "filed", bill_id: "bill-s", category: "Shop Stock", job_id: null });
  });

  it("the shelf refused: the bill comes back down and the paper goes back to the tray, holding nothing", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: PAPER, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-s" }], error: null },
          { data: [{ id: "oi-s" }], error: null },
        ],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bills.insert": [{ data: { id: "bill-s" }, error: null }],
        "bill_line_items.insert": [{ data: WRITTEN, error: null }],
        "bill_line_items.select": [
          { data: WRITTEN, error: null },
          { data: MONEY_LINES, error: null },
        ],
        "stock_lot_balance.select": [{ data: [], error: null }],
        "inventory_items.select": [{ data: [], error: null }],
        "rpc.shelve_bill_lines": [{ data: null, error: { code: "P0001", message: "A roll can't be worth more than its receipt." } }],
        "bills.delete": [{ data: [{ id: "bill-s" }], error: null }],
      },
      calls,
      rpcs,
    );
    const res = await fileItem("oi-s", { type: "stock", lines: CHOICES });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("A roll can't be worth more than its receipt.");
    expect(res.error).toContain("back in the tray");
    expect(did("bills", "delete")).toBeTruthy();
    expect(lastDid("organized_items", "update")!.payload).toMatchObject({ status: "needs_review", bill_id: null });
  });

  it("before 0328 is applied, it says so in words and files nothing", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: PAPER, error: null }],
        "organized_items.update": [
          { data: [{ id: "oi-s" }], error: null },
          { data: [{ id: "oi-s" }], error: null },
        ],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bills.insert": [{ data: { id: "bill-s" }, error: null }],
        "bill_line_items.insert": [{ data: WRITTEN, error: null }],
        "bill_line_items.select": [
          { data: WRITTEN, error: null },
          { data: MONEY_LINES, error: null },
        ],
        "stock_lot_balance.select": [{ data: [], error: null }],
        "inventory_items.select": [{ data: [], error: null }],
        "rpc.shelve_bill_lines": [{ data: null, error: { code: "PGRST202", message: "Could not find the function public.shelve_bill_lines" } }],
        "bills.delete": [{ data: [{ id: "bill-s" }], error: null }],
      },
      calls,
      rpcs,
    );
    const res = await fileItem("oi-s", { type: "stock", lines: CHOICES });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("one more database update (0328)");
  });
});

describe("Put The Rest On The Shelf (a job's receipt line)", () => {
  const COIL_LINES = [
    { id: "l0", description: "Flexbox BH bar hanger ground", quantity: 1, unit_price: 8.82, amount: 8.82, category: "Electrical", billable: true, billed_amount: null },
    { id: "l1", description: "NMB 12/2 w/gnd wire 250 ft coil", quantity: 250, unit_price: 0.66, amount: 165.29, category: "Electrical", billable: true, billed_amount: null },
    { id: "l2", description: "Flexbox single gang 16 cu in", quantity: 2, unit_price: 4.45, amount: 8.9, category: "Electrical", billable: true, billed_amount: null },
    { id: "l3", description: "Tax at 9.000 percent", quantity: 1, unit_price: 16.47, amount: 16.47, category: "Tax", billable: true, billed_amount: null },
  ];
  it("Herringbone 8/19, 0 used: one RPC, billed $0, 250 ft at $180.17, and the draft that still bills it is named", async () => {
    state.client = fakeSupabase(
      {
        "bill_line_items.select": [
          { data: { id: "l1", bill_id: "11e96fc3", bills: { job_id: "j011", jobs: { name: "13897 Herringbone" } } }, error: null }, // the card's read
          { data: { id: "l1", bill_id: "11e96fc3" }, error: null }, // putOnShelf: which bill
          { data: COIL_LINES, error: null }, // shelveLines: the ticket
        ],
        "stock_lot_balance.select": [
          { data: [], error: null },
          { data: [], error: null },
        ],
        "inventory_items.select": [{ data: [], error: null }],
        "rpc.shelve_bill_lines": [{ data: { lots: [{ lot_id: "lot-1", item_id: "item-1", line_id: "l1" }] }, error: null }],
        "invoice_items.select": [{ data: [{ invoices: { invoice_number: "INV-078", status: "draft" } }], error: null }],
      },
      calls,
      rpcs,
    );
    const res = await putRestOnShelf({ lineId: "l1", pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "12/2 NM-B" });
    expect(res.ok).toBe(true);
    expect(res.message).toBe(
      "250 ft is on the shelf at $180.17 (about 72¢ a foot). 13897 Herringbone's cost drops by $180.17. INV-078 is still a draft that bills this line: pull its materials in again and it follows.",
    );
    expect(rpcs[0].args.p_lines).toEqual([
      { line_id: "l1", billed_amount: 0, pieces: 250, unit: "ft", cost: 180.17, item_id: null, item_name: "12/2 NM-B", key_part: null },
    ]);
    // Nothing else was written: the RPC is the one write.
    expect(calls.filter((c) => c.verb !== "select")).toEqual([]);
  });

  it("a line with a roll already on it is refused before any write", async () => {
    state.client = fakeSupabase(
      {
        "bill_line_items.select": [
          { data: { id: "l1", bill_id: "b", bills: { job_id: "j011", jobs: { name: "Herringbone" } } }, error: null },
          { data: { id: "l1", bill_id: "b" }, error: null },
          { data: COIL_LINES, error: null },
        ],
        "stock_lot_balance.select": [{ data: [{ lot_id: "lot-1", bill_line_id: "l1", cost: 180.17, live: true, live_moves: 0 }], error: null }],
      },
      calls,
      rpcs,
    );
    const res = await putRestOnShelf({ lineId: "l1", pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "12/2" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already on the shelf");
    expect(rpcs).toEqual([]);
  });

  it("the second coil of 12/2 lands on the SAME item (exact name), and a match in another unit is refused", async () => {
    const items = [{ id: "item-122", name: "12/2 NM-B", unit: "ft", key_part: null, part_number: null, price_item_id: null, created_at: "2026-09-01" }];
    const script = (itemRows: any[]) => ({
      "bill_line_items.select": [
        { data: { id: "l1", bill_id: "b", bills: { job_id: "j011", jobs: { name: "Herringbone" } } }, error: null },
        { data: { id: "l1", bill_id: "b" }, error: null },
        { data: COIL_LINES, error: null },
      ],
      "stock_lot_balance.select": [
        { data: [], error: null },
        { data: [], error: null },
      ],
      "inventory_items.select": [{ data: itemRows, error: null }],
      "rpc.shelve_bill_lines": [{ data: { lots: [{ lot_id: "lot-2", item_id: "item-122", line_id: "l1" }] }, error: null }],
      "invoice_items.select": [{ data: [], error: null }],
    });
    state.client = fakeSupabase(script(items), calls, rpcs);
    const ok = await putRestOnShelf({ lineId: "l1", pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "12/2 NM-B" });
    expect(ok.ok).toBe(true);
    expect(rpcs[0].args.p_lines[0]).toMatchObject({ item_id: "item-122", item_name: null });

    rpcs = [];
    state.client = fakeSupabase(script([{ ...items[0], unit: "roll" }]), calls, rpcs);
    const no = await putRestOnShelf({ lineId: "l1", pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "12/2 NM-B" });
    expect(no.ok).toBe(false);
    expect(no.error).toContain("counted in roll");
    expect(rpcs).toEqual([]);
  });
});

describe("Record To Shelf (a CED document)", () => {
  const STAFF = { data: { role: "owner", org_id: "org-1", active: true }, error: null };
  const INV = {
    data: {
      id: "si-stock",
      invoice_number: "8802-1103061",
      kind: "invoice",
      invoice_date: "2026-07-13",
      job_id: "job-picked-by-ced",
      supplier_account_id: "acct-ced",
      tax: "9.45",
      shipping: "0",
      total: "114.40",
      open_balance: "0",
      closed: true,
      supplier_accounts: { name: "CED Truckee" },
      jobs: { name: "Somebody's job", job_number: "J-099" },
    },
    error: null,
  };
  const SI_LINES = [
    { description: "RED/YELLOW CONN", part_number: "R/Y+JUG", quantity: "500.000", unit_price: "16.9700", extension: "84.85", sort_order: 0 },
    { description: "PLSTC TAPE", part_number: "33+", quantity: "2.000", unit_price: "1005.1700", extension: "20.10", sort_order: 1 },
  ];
  const reads = (over: Record<string, any[]> = {}) => ({
    "profiles.select": [STAFF],
    "supplier_invoices.select": [
      INV,
      { data: [{ id: "si-stock", kind: "invoice", total: "114.40", open_balance: "0", closed: true }], error: null },
      { data: [], error: null },
    ],
    "bill_supplier_invoices.select": [{ data: [], error: null }, { data: [], error: null }],
    "bills.select": [{ data: [], error: null }],
    "supplier_aliases.select": [{ data: [], error: null }],
    "supplier_invoice_lines.select": [{ data: SI_LINES, error: null }],
    ...over,
  });

  it("refuses before writing when a line has no answer", async () => {
    // requireStaff is mocked in this file; the supplier door reads its own staff row through it.
    state.client = fakeSupabase(reads(), calls, rpcs);
    const res = await recordSupplierInvoiceToShelf({ invoiceId: "si-stock", toShelf: [{ index: 0, notStock: false, pieces: 500, unit: "ea", newItemName: "R/Y" }] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("1 line is still open");
    expect(calls.filter((c) => c.verb !== "select")).toEqual([]);
  });

  it("records it as a shelf ticket whatever job CED put on it, with the part number carried as the item's key", async () => {
    state.client = fakeSupabase(
      reads({
        "bills.insert": [{ data: [{ id: "bill-new" }], error: null }],
        "bill_supplier_invoices.insert": [{ data: [{ id: "link-1" }], error: null }],
        "bill_line_items.insert": [{ data: [{ id: "l0" }, { id: "l1" }, { id: "l2" }], error: null }],
        "bill_line_items.select": [
          { data: WRITTEN, error: null },
          { data: MONEY_LINES, error: null },
        ],
        "stock_lot_balance.select": [
          { data: [], error: null },
          { data: [], error: null },
        ],
        "inventory_items.select": [{ data: [], error: null }],
        "rpc.shelve_bill_lines": [{ data: { lots: [{ lot_id: "lot-1", item_id: "item-1", line_id: "l0" }] }, error: null }],
      }),
      calls,
      rpcs,
    );
    const res = await recordSupplierInvoiceToShelf({
      invoiceId: "si-stock",
      toShelf: [
        { index: 0, notStock: false, pieces: 500, unit: "ea", bought: 500, newItemName: "Red/Yellow connectors", keyPart: "R/Y+JUG" },
        { index: 1, notStock: true },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("8802-1103061 is on the shop shelf now: $114.40, which the supplier already shows as paid.");
    expect(did("bills", "insert")!.payload).toMatchObject({ job_id: null, on_shelf: true, category: "Shop Stock", amount: 114.4 });
    expect(rpcs[0].args.p_lines).toEqual([
      { line_id: "l0", billed_amount: 0, pieces: 500, unit: "ea", cost: 92.49, item_id: null, item_name: "Red/Yellow connectors", key_part: "RYJUG" },
    ]);
  });

  it("the shelf refused: the bill it just wrote comes back out, and the document is still not in the books", async () => {
    state.client = fakeSupabase(
      reads({
        "bills.insert": [{ data: [{ id: "bill-new" }], error: null }],
        "bill_supplier_invoices.insert": [{ data: [{ id: "link-1" }], error: null }],
        "bill_line_items.insert": [{ data: [{ id: "l0" }, { id: "l1" }, { id: "l2" }], error: null }],
        "bill_line_items.select": [
          { data: WRITTEN, error: null },
          { data: MONEY_LINES, error: null },
        ],
        "stock_lot_balance.select": [{ data: [], error: null }],
        "inventory_items.select": [{ data: [], error: null }],
        "rpc.shelve_bill_lines": [{ data: null, error: { code: "42501", message: "Only the office puts things on this company's shelf." } }],
        "bills.delete": [{ data: [{ id: "bill-new" }], error: null }],
      }),
      calls,
      rpcs,
    );
    const res = await recordSupplierInvoiceToShelf({
      invoiceId: "si-stock",
      toShelf: [
        { index: 0, notStock: false, pieces: 500, unit: "ea", bought: 500, newItemName: "R/Y" },
        { index: 1, notStock: true },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("8802-1103061 is still not in your books.");
    expect(did("bills", "delete")).toBeTruthy();
  });
});
