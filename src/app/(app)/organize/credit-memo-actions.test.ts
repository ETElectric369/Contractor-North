import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A CREDIT MEMO FILES WITH ITS BILL (cn-v1181, lane M), on a stand-in database that HONOURS what a
 * query says: every eq / is / in / neq / contains / like filter (an embedded `x.col` filter too, with
 * !inner dropping the row), the SELECT LIST (a column the table does not have is an error, as
 * PostgREST's 42703 is, and only the named columns come back), and each INSERT's and UPDATE's column
 * list (a column the table does not have is an error; 0417's two checks refuse what they must). The
 * correction door is the REAL one (jobs/actions correctBill). Three companies share the database:
 * org-2's rows sit beside org-1's in every table, and are never matched, read or written.
 *
 * The money is proven with the real pure functions over the rows the stand-in ends with
 * (billItemisation, returnLinesAgainstPurchases, returnCreditRows).
 */

type Row = Record<string, any>;
const SCHEMA: Record<string, string[]> = {
  organized_items: ["id", "org_id", "status", "kind", "doc_type", "category", "vendor", "doc_number", "amount", "item_date", "line_items", "proposal", "bill_id", "job_id", "title", "payment"],
  supplier_aliases: ["id", "org_id", "alias", "supplier_account_id"],
  bills: [
    "id", "org_id", "job_id", "supplier", "supplier_account_id", "category", "scope_category", "status", "amount", "bill_number", "supplier_invoice_number",
    "bill_date", "corrects_bill_id", "superseded_by_bill_id", "on_shelf", "notes", "created_by", "created_at", "po_id",
  ],
  bill_line_items: [
    "id", "org_id", "bill_id", "description", "quantity", "unit_price", "amount", "category", "billable", "billed_amount", "is_stock", "returned",
    "returned_credit_bill_id", "pen_mark", "sort_order",
  ],
  jobs: ["id", "org_id", "job_number", "name"],
  invoices: ["id", "org_id", "invoice_number", "status"],
  invoice_items: ["id", "invoice_id", "edited", "source_ids", "import_key"],
  stock_lot_balance: ["lot_id", "org_id", "bill_id", "bill_line_id", "cost", "live", "live_moves"],
  organizations: ["id", "settings"],
};
// An embed, and the column that joins it: many-to-one (an object) or one-to-many (an array).
const EMBEDS: Record<string, Record<string, { table: string; key: string; many: boolean }>> = {
  bills: { jobs: { table: "jobs", key: "job_id", many: false }, bill_line_items: { table: "bill_line_items", key: "bill_id", many: true } },
  invoice_items: { invoices: { table: "invoices", key: "invoice_id", many: false } },
};
const DEFAULTS: Record<string, Row> = {
  bills: { superseded_by_bill_id: null, corrects_bill_id: null, supplier_invoice_number: null, po_id: null },
  bill_line_items: { billable: true, billed_amount: null, is_stock: false, returned: false, returned_credit_bill_id: null, pen_mark: null, sort_order: 0 },
};

function parseSelect(cols: string): { plain: string[]; embeds: { name: string; inner: boolean; cols: string }[] } {
  const plain: string[] = [];
  const embeds: { name: string; inner: boolean; cols: string }[] = [];
  let depth = 0;
  let cur = "";
  const parts: string[] = [];
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  for (const p of parts) {
    const m = p.match(/^([a-z_]+)(!inner)?\((.*)\)$/s);
    if (m) embeds.push({ name: m[1], inner: !!m[2], cols: m[3] });
    else plain.push(p);
  }
  return { plain, embeds };
}

type Hooks = {
  /** Fail a read of this table (a lost read is never "nothing there"). */
  failRead?: Set<string>;
  /** Called before an update lands: a test can change a row under the door. */
  beforeUpdate?: (table: string, patch: Row) => void;
};

function fakeDb(tables: Record<string, Row[]>, hooks: Hooks = {}) {
  let seq = 0;
  const writes: { table: string; verb: string; cols: string[]; filters: string[] }[] = [];
  const err = (message: string, code = "42703") => ({ data: null, error: { message, code } });
  const project = (table: string, row: Row, cols: string): Row | { bad: string } => {
    const { plain, embeds } = parseSelect(cols);
    const out: Row = {};
    for (const c of plain) {
      if (c === "*") Object.assign(out, row);
      else if (!SCHEMA[table].includes(c)) return { bad: `column ${table}.${c} does not exist` };
      else out[c] = row[c] ?? null;
    }
    for (const e of embeds) {
      const rel = EMBEDS[table]?.[e.name];
      if (!rel) return { bad: `no relation ${table}.${e.name}` };
      const kids = rel.many ? (tables[rel.table] ?? []).filter((k) => k[rel.key] === row.id) : (tables[rel.table] ?? []).filter((k) => k.id === row[rel.key]);
      const shaped: Row[] = [];
      for (const k of kids) {
        const s = project(rel.table, k, e.cols);
        if ("bad" in s) return s;
        shaped.push(s as Row);
      }
      out[e.name] = rel.many ? shaped : (shaped[0] ?? null);
    }
    return out;
  };
  const from = (table: string) => {
    if (!SCHEMA[table]) throw new Error(`no table ${table}`);
    const filters: { col: string; f: (v: any) => boolean; label: string }[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let selectCols: string | null = null;
    let single = false;
    let lim: number | null = null;
    let pending: Row[] = [];
    let patch: Row = {};
    const at = (r: Row, col: string) => {
      if (!col.includes(".")) return r[col];
      const [embed, c] = col.split(".");
      const rel = EMBEDS[table]?.[embed];
      const parent = rel ? (tables[rel.table] ?? []).find((k) => k.id === r[rel.key]) : null;
      return parent ? parent[c] : undefined;
    };
    const add = (col: string, label: string, f: (v: any) => boolean) => {
      const top = col.split(".")[0];
      if (!col.includes(".") && !SCHEMA[table].includes(top)) throw new Error(`filter on missing column ${table}.${col}`);
      filters.push({ col, f, label: `${label}:${col}` });
      return b;
    };
    const hits = () => (tables[table] ?? []).filter((r) => filters.every((x) => x.f(at(r, x.col))));
    const b: any = {
      select(cols?: string) {
        if (mode === "select") selectCols = cols ?? "*";
        else selectCols = cols ?? "*";
        return b;
      },
      order: () => b,
      // A read's cap is honoured (order is not: the books are seeded newest first where it matters).
      limit: (n: number) => {
        lim = n;
        return b;
      },
      eq: (c: string, v: unknown) => add(c, "eq", (x) => x === v),
      neq: (c: string, v: unknown) => add(c, "neq", (x) => x != null && x !== v),
      is: (c: string, v: unknown) => add(c, "is", (x) => (x ?? null) === v),
      in: (c: string, vs: unknown[]) => add(c, "in", (x) => vs.includes(x)),
      contains: (c: string, vs: unknown[]) => add(c, "contains", (x) => Array.isArray(x) && vs.every((v) => x.includes(v))),
      like: (c: string, pat: string) => add(c, "like", (x) => typeof x === "string" && x.startsWith(pat.replace(/%$/, ""))),
      insert(rows: Row | Row[]) {
        mode = "insert";
        pending = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
        return b;
      },
      update(p: Row) {
        mode = "update";
        patch = p;
        return b;
      },
      delete() {
        mode = "delete";
        return b;
      },
      maybeSingle() {
        single = true;
        return b;
      },
      single() {
        single = true;
        return b;
      },
      then(resolve: (v: unknown) => void) {
        resolve(run());
      },
    };
    const checks = (r: Row): string | null => {
      if (table !== "bill_line_items") return null;
      if (r.returned && r.billable !== false) return "bill_line_items_returned_not_billed";
      if (r.returned_credit_bill_id && !r.returned) return "bill_line_items_credit_needs_return";
      return null;
    };
    const run = () => {
      const shape = (rows: Row[]) => {
        const cols = selectCols ?? "*";
        const out: Row[] = [];
        for (const r of rows) {
          const s = project(table, r, cols);
          if ("bad" in s) return { bad: s.bad };
          out.push(s as Row);
        }
        return { rows: out };
      };
      if (mode === "select") {
        if (hooks.failRead?.has(table)) return err(`read of ${table} failed`, "08006");
        // An embedded !inner filter drops the row whose embed fails it (the filter above already did).
        const s = shape(lim != null ? hits().slice(0, lim) : hits());
        if ("bad" in s) return err(s.bad!);
        return { data: single ? (s.rows![0] ?? null) : s.rows, error: null };
      }
      if (mode === "insert") {
        for (const r of pending) {
          const bad = Object.keys(r).find((k) => !SCHEMA[table].includes(k));
          if (bad) return err(`column ${table}.${bad} does not exist`);
        }
        writes.push({ table, verb: "insert", cols: [...new Set(pending.flatMap((r) => Object.keys(r)))].sort(), filters: [] });
        const made = pending.map((r) => {
          const row: Row = { ...(DEFAULTS[table] ?? {}), ...r, id: r.id ?? `${table}-${++seq}`, created_at: r.created_at ?? `2026-11-22T00:00:${String(seq).padStart(2, "0")}Z` };
          if (!SCHEMA[table].includes("created_at")) delete row.created_at;
          // 0043's stamp_org trigger, and 0381's guard: a correction takes its original's job and state.
          if (table === "bill_line_items" && !row.org_id) row.org_id = (tables.bills ?? []).find((x) => x.id === row.bill_id)?.org_id ?? null;
          if (table === "bills" && row.corrects_bill_id) {
            const o = (tables.bills ?? []).find((x) => x.id === row.corrects_bill_id);
            if (o) Object.assign(row, { job_id: o.job_id, status: o.status });
          }
          return row;
        });
        for (const r of made) {
          const c = checks(r);
          if (c) return err(`new row violates check constraint "${c}"`, "23514");
        }
        tables[table] = [...(tables[table] ?? []), ...made];
        const s = selectCols ? shape(made) : { rows: made.map((r) => ({ id: r.id })) };
        return { data: single ? s.rows![0] : s.rows, error: null };
      }
      if (mode === "update") {
        const bad = Object.keys(patch).find((k) => !SCHEMA[table].includes(k));
        if (bad) return err(`column ${table}.${bad} does not exist`);
        hooks.beforeUpdate?.(table, patch);
        writes.push({ table, verb: "update", cols: Object.keys(patch).sort(), filters: filters.map((x) => x.label) });
        const hit = hits();
        for (const r of hit) {
          const c = checks({ ...r, ...patch });
          if (c) return err(`new row violates check constraint "${c}"`, "23514");
        }
        for (const r of hit) Object.assign(r, patch);
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      const hit = hits();
      tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r));
      writes.push({ table, verb: "delete", cols: [], filters: filters.map((x) => x.label) });
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    };
    return b;
  };
  return { sb: { from, auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } } as any, writes, tables };
}

const state = vi.hoisted(() => ({ client: null as any, orgId: "org-1" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: state.orgId, role: "owner" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
const importCosts = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: true as boolean, error: undefined as string | undefined })));
vi.mock("@/app/(app)/billing/actions", async (orig) => ({ ...(await orig<Record<string, unknown>>()), importCostsIntoInvoice: importCosts }));

import { creditMemoHome, fileCreditMemoWithItsBill, fileReturnBillWithItsBill, returnBillHome } from "./credit-memo-actions";
import { billItemisation, type BillForItemisation, type BillLine } from "@/lib/bill-itemisation";
import { returnCreditRows, returnLinesAgainstPurchases } from "@/lib/supplier-returns";

// ── THE BOOKS: Northline Supply's INV-900 on J-901 Larkspur, and org-2's look-alike ──────────────
function books() {
  const L = (id: string, bill: string, org: string, sort: number, over: Row) => ({
    id, org_id: org, bill_id: bill, quantity: 1, unit_price: 0, amount: 0, category: null, billable: true, billed_amount: null, is_stock: false,
    returned: false, returned_credit_bill_id: null, pen_mark: null, sort_order: sort, ...over,
  });
  return {
    organizations: [{ id: "org-1", settings: {} }],
    jobs: [
      { id: "job-1", org_id: "org-1", job_number: "J-901", name: "Larkspur" },
      { id: "job-9", org_id: "org-2", job_number: "J-902", name: "Snowbell" },
    ],
    supplier_aliases: [],
    bills: [
      { id: "bill-1", org_id: "org-1", job_id: "job-1", supplier: "Northline Supply", supplier_account_id: null, category: "Bill", scope_category: null, status: "unpaid", amount: 244.31, bill_number: "INV-900", supplier_invoice_number: null, bill_date: "2026-11-01", corrects_bill_id: null, superseded_by_bill_id: null, on_shelf: false, created_at: "2026-11-01T00:00:00Z", po_id: null },
      { id: "bill-2", org_id: "org-1", job_id: "job-1", supplier: "Northline Supply", supplier_account_id: null, category: "Bill", scope_category: null, status: "unpaid", amount: 30, bill_number: "INV-901", supplier_invoice_number: null, bill_date: "2026-11-02", corrects_bill_id: null, superseded_by_bill_id: null, on_shelf: false, created_at: "2026-11-02T00:00:00Z", po_id: null },
      // ANOTHER COMPANY: the same supplier, the same number, the same lines.
      { id: "bill-x", org_id: "org-2", job_id: "job-9", supplier: "Northline Supply", supplier_account_id: null, category: "Bill", scope_category: null, status: "unpaid", amount: 244.31, bill_number: "INV-900", supplier_invoice_number: null, bill_date: "2026-11-01", corrects_bill_id: null, superseded_by_bill_id: null, on_shelf: false, created_at: "2026-11-01T00:00:00Z", po_id: null },
    ],
    bill_line_items: [
      // A housing crossed out on the ticket: returned, a credit expected.
      L("l-house", "bill-1", "org-1", 0, { description: "4 in LED Shallow IC Housing", quantity: 4, unit_price: 11.83, amount: 47.32, billable: false, returned: true, pen_mark: "struck" }),
      L("l-wire", "bill-1", "org-1", 1, { description: "12/2 NM-B Cable 250 ft", quantity: 10, unit_price: 12.345, amount: 123.45 }),
      L("l-switch", "bill-1", "org-1", 2, { description: "Single Pole Switch White", quantity: 5, unit_price: 9.9, amount: 49.5 }),
      L("l-tax", "bill-1", "org-1", 3, { description: "Sales Tax", category: "Tax", unit_price: 24.04, amount: 24.04 }),
      L("l-other", "bill-2", "org-1", 0, { description: "Duplex Receptacle White", quantity: 10, unit_price: 3, amount: 30 }),
      L("x-house", "bill-x", "org-2", 0, { description: "4 in LED Shallow IC Housing", quantity: 4, unit_price: 11.83, amount: 47.32, billable: false, returned: true }),
      L("x-wire", "bill-x", "org-2", 1, { description: "12/2 NM-B Cable 250 ft", quantity: 10, unit_price: 12.345, amount: 123.45 }),
    ],
    organized_items: [
      {
        id: "memo-1", org_id: "org-1", status: "needs_review", kind: "document", doc_type: "credit_memo", category: "Credit Memo", vendor: "Northline Supply",
        doc_number: "CM-900", amount: -103.7, item_date: "2026-11-20", bill_id: null, job_id: null, title: "credit memo", payment: "on_account",
        proposal: { reverses: "INV-900" },
        line_items: [
          { description: "H245 4 in LED Shallow IC Housing", quantity: 4, unit_price: -11.83, amount: -47.32 },
          { description: "12/2 NM-B Cable 250 ft", quantity: 4, unit_price: -12.345, amount: -49.38 },
          { description: "Sales Tax", category: "Tax", quantity: 1, unit_price: -12, amount: -12 },
          { description: "Restocking Fee", quantity: 1, unit_price: 5, amount: 5 },
        ],
      },
      { id: "memo-x", org_id: "org-2", status: "needs_review", kind: "document", doc_type: "credit_memo", vendor: "Northline Supply", doc_number: "CM-901", amount: -47.32, item_date: "2026-11-20", bill_id: null, proposal: {}, line_items: [{ description: "4 in LED Shallow IC Housing", quantity: 4, amount: -47.32 }] },
    ],
    invoices: [] as Row[],
    invoice_items: [] as Row[],
    stock_lot_balance: [],
  } as Record<string, Row[]>;
}

let db: ReturnType<typeof fakeDb>;
const use = (t: Record<string, Row[]>, hooks?: Hooks) => {
  db = fakeDb(t, hooks);
  state.client = db.sb;
};
const linesOf = (billId: string) => db.tables.bill_line_items.filter((l) => l.bill_id === billId).sort((a, b) => a.sort_order - b.sort_order);
const credits = () => db.tables.bills.filter((b) => b.corrects_bill_id) as (Row & BillForItemisation)[];

beforeEach(() => {
  state.orgId = "org-1";
  importCosts.mockClear();
});

describe("creditMemoHome: the purchase this credit reverses", () => {
  it("(a) the number the memo says it reverses, when it names exactly one of this supplier's live bills", async () => {
    use(books());
    expect(await creditMemoHome("memo-1")).toEqual({ ok: true, kind: "one", by: "number", candidate: { billId: "bill-1", label: "Northline Supply #INV-900, $244.31, 2026-11-01, on J-901 Larkspur" } });
  });

  it("(b) with no number, the supplier's bill whose lines the memo names best", async () => {
    const t = books();
    t.organized_items[0].proposal = {};
    use(t);
    // Found by words: the door names it on a button and files on that tap (skeptic #84, M7).
    expect(await creditMemoHome("memo-1")).toMatchObject({ ok: true, kind: "one", by: "words", candidate: { billId: "bill-1" } });
  });

  it("several equally good: each, labelled, for a person to pick", async () => {
    const t = books();
    t.organized_items[0].proposal = {};
    t.organized_items[0].line_items = [{ description: "Duplex Receptacle White", quantity: 10, amount: -30 }];
    t.organized_items[0].amount = -30;
    t.bill_line_items.push({ ...t.bill_line_items.find((l) => l.id === "l-other")!, id: "l-other-1", bill_id: "bill-1", sort_order: 4 });
    use(t);
    const r = await creditMemoHome("memo-1");
    expect(r).toMatchObject({ ok: true, kind: "several" });
    if (r.ok && r.kind === "several") expect(r.candidates.map((c) => c.billId).sort()).toEqual(["bill-1", "bill-2"]);
  });

  it("none: one sentence, and Fix Details as before", async () => {
    const t = books();
    t.organized_items[0].proposal = {};
    t.organized_items[0].line_items = [{ description: "Three Way Switch Ivory", amount: -103.7 }];
    use(t);
    expect(await creditMemoHome("memo-1")).toEqual({
      ok: true,
      kind: "none",
      sentence: "No bill from Northline Supply carries the lines this credit memo returns, so it has no bill to file with. Fix Details can still file it on a job, as before.",
    });
  });

  it("another company's bill never matches, by number or by lines; another company's memo is not here", async () => {
    const t = books();
    t.bills = t.bills.filter((b) => b.org_id === "org-2" || b.id === "bill-2");
    use(t);
    expect(await creditMemoHome("memo-1")).toMatchObject({ ok: true, kind: "none" });
    use(books());
    expect(await creditMemoHome("memo-x")).toEqual({ ok: false, error: "That paper isn't here any more. Reload the page." });
  });

  it("a read that fails is said, never 'no bill'", async () => {
    use(books(), { failRead: new Set(["bills"]) });
    const r = await creditMemoHome("memo-1");
    expect(r.ok).toBe(false);
    use(books(), { failRead: new Set(["bill_line_items"]) });
    const t = await creditMemoHome("memo-1");
    expect(t.ok).toBe(true); // (a) answered from the number, before any line is read
    const n = books();
    n.organized_items[0].proposal = {};
    use(n, { failRead: new Set(["bill_line_items"]) });
    expect((await creditMemoHome("memo-1")).ok).toBe(false);
  });
});

describe("fileCreditMemoWithItsBill: filed as a correction, and what it returns is closed", () => {
  it("closes the open returned line, splits the part of the cable, keeps the switch, and the memo's own lines bill nothing", async () => {
    use(books());
    const r = await fileCreditMemoWithItsBill("memo-1", "bill-1");
    expect(r.ok).toBe(true);
    const [credit] = credits();
    expect(credit).toMatchObject({ org_id: "org-1", corrects_bill_id: "bill-1", amount: -103.7, bill_number: "CM-900", job_id: "job-1" });
    // THE PURCHASE'S LINES
    expect(linesOf("bill-1").map((l) => [l.id.startsWith("l-") ? l.id : "half", l.sort_order, l.quantity, l.amount, l.billable, l.returned, l.returned_credit_bill_id])).toEqual([
      ["l-house", 0, 4, 47.32, false, true, credit.id],
      ["l-wire", 1, 6, 74.07, true, false, null],
      ["half", 2, 4, 49.38, false, true, credit.id],
      ["l-switch", 3, 5, 49.5, true, false, null],
      ["l-tax", 4, 1, 24.04, true, false, null],
    ]);
    // THE MEMO'S OWN LINES: the two returns and the fee off the customer's bill; the tax follows the bill's tax line.
    expect(linesOf(String(credit.id)).map((l) => [l.description, l.amount, l.billable])).toEqual([
      ["4 in LED Shallow IC Housing", -47.32, false],
      ["12/2 NM-B Cable 250 ft", -49.38, false],
      ["Sales Tax", -12, true],
      ["Restocking Fee", 5, false],
    ]);
    // THE TRAY ROW, filed the way File It files one.
    expect(db.tables.organized_items[0]).toMatchObject({ status: "filed", bill_id: credit.id, job_id: "job-1", proposal: { reverses: "INV-900", filed: { how: "bill" } } });
    expect(r.message).toContain("CM-900 is filed under INV-900: $103.70 back from the supplier.");
    expect(r.message).toContain("12/2 NM-B Cable 250 ft was split: 6 kept ($74.07), 4 returned ($49.38).");
    expect(r.message).toContain("Restocking Fee ($5.00) is the company's cost, not billed to the customer.");
    // ANOTHER COMPANY'S ROWS: untouched.
    expect(db.tables.bill_line_items.filter((l) => l.org_id === "org-2").map((l) => [l.amount, l.returned_credit_bill_id])).toEqual([
      [47.32, null],
      [123.45, null],
    ]);
    // EVERY WRITE NAMES THE COMPANY (an insert by its column; an update or delete by its filter).
    for (const w of db.writes.filter((x) => x.table !== "bills" && x.verb !== "insert")) expect(w.filters).toContain("eq:org_id");
    const half = db.writes.find((w) => w.table === "bill_line_items" && w.verb === "insert" && w.cols.includes("returned_credit_bill_id"));
    expect(half?.cols).toEqual(["amount", "bill_id", "billable", "category", "description", "org_id", "quantity", "returned", "returned_credit_bill_id", "sort_order", "unit_price"]);
  });

  it("PROVES THE MONEY: closed lines credit and bill nothing, the part bills only what was kept, job cost nets once", async () => {
    use(books());
    await fileCreditMemoWithItsBill("memo-1", "bill-1");
    const bill = db.tables.bills.find((b) => b.id === "bill-1")! as Row & BillForItemisation;
    const [credit] = credits();
    const purchase = linesOf("bill-1") as BillLine[];
    const memo = linesOf(String(credit.id)) as BillLine[];
    // The customer's invoice, purchase side: the kept cable and the switch, with their share of tax.
    const rows = billItemisation(bill, purchase, 0);
    const billed = Math.round(rows.reduce((s, r) => s + r.quantity * r.unit_price, 0) * 100) / 100;
    const keptGoods = 74.07 + 49.5;
    const taxShare = Math.round(((24.04 * keptGoods) / (47.32 + 123.45 + 49.5)) * 100) / 100;
    expect(billed).toBeCloseTo(keptGoods + taxShare, 2);
    expect(rows.some((r) => /housing/i.test(r.description))).toBe(false);
    // The return side: the memo credits the customer nothing (its goods never reached them); the fee is not billed either.
    const capped = returnLinesAgainstPurchases([bill, credit], (b) => (b.id === "bill-1" ? purchase : memo));
    const creditRows = returnCreditRows(credit, capped.get(credit) ?? memo, 0);
    expect(creditRows.reduce((s, r) => s + r.quantity * r.unit_price, 0)).toBe(0);
    // Job cost reads the headers: the purchase and its correction net once.
    const jobCost = db.tables.bills.filter((b) => b.org_id === "org-1" && b.job_id === "job-1" && !b.superseded_by_bill_id && b.id !== "bill-2").reduce((s, b) => s + Math.round(b.amount * 100), 0) / 100;
    expect(jobCost).toBe(140.61);
  });

  it("an invoice that went out already bills the purchase: the open return still closes, the cable stays a credit to the customer", async () => {
    const t = books();
    t.invoices.push({ id: "inv-1", org_id: "org-1", invoice_number: "INV-0900", status: "sent" });
    t.invoice_items.push({ id: "ii-1", invoice_id: "inv-1", edited: false, source_ids: ["bill-1"], import_key: "bli:l-wire" });
    use(t);
    const r = await fileCreditMemoWithItsBill("memo-1", "bill-1");
    expect(r.ok).toBe(true);
    const [credit] = credits();
    expect(linesOf("bill-1").map((l) => [l.id, l.amount, l.returned_credit_bill_id])).toEqual([
      ["l-house", 47.32, credit.id],
      ["l-wire", 123.45, null],
      ["l-switch", 49.5, null],
      ["l-tax", 24.04, null],
    ]);
    const memo = linesOf(String(credit.id));
    expect(memo.map((l) => l.billable)).toEqual([false, true, true, false]);
    expect(r.message).toContain("12/2 NM-B Cable 250 ft stays a credit to the customer, as before: an invoice that went out already billed it.");
    // The customer is credited for the cable they were billed, never for the housing.
    const bill = db.tables.bills.find((b) => b.id === "bill-1")! as Row & BillForItemisation;
    const capped = returnLinesAgainstPurchases([bill, credit], (b) => (b.id === "bill-1" ? (linesOf("bill-1") as BillLine[]) : (memo as BillLine[])));
    const rows = returnCreditRows(credit, capped.get(credit)!, 0);
    expect(rows.some((x) => /housing/i.test(x.description))).toBe(false);
    expect(rows.some((x) => /cable/i.test(x.description) && x.unit_price < 0)).toBe(true);
  });

  it("a draft that lists the purchase is brought up to date and named; one changed by hand is told its one action", async () => {
    const t = books();
    t.invoices.push({ id: "inv-d", org_id: "org-1", invoice_number: "INV-0901", status: "draft" });
    t.invoice_items.push({ id: "ii-d", invoice_id: "inv-d", edited: false, source_ids: ["bill-1"], import_key: "bli:l-wire" });
    use(t);
    importCosts.mockResolvedValueOnce({ ok: true, error: undefined, stats: { pulled_in: 2, stock_pulled_in: 1 } } as any);
    const r = await fileCreditMemoWithItsBill("memo-1", "bill-1");
    expect(importCosts).toHaveBeenCalledWith("inv-d", undefined, { keepInvoiceMarkup: true });
    // Everything the refresh did, from the import's own count (skeptic #84, M4).
    expect(r.message).toContain("INV-0901 (a draft) now leaves the returned goods off, and it brought in 3 other new costs from the job.");
    // The split happened: a draft is not an invoice that went out.
    expect(linesOf("bill-1").find((l) => l.id === "l-wire")?.amount).toBe(74.07);

    const e = books();
    e.invoices.push({ id: "inv-d", org_id: "org-1", invoice_number: "INV-0901", status: "draft" });
    e.invoice_items.push({ id: "ii-d", invoice_id: "inv-d", edited: true, source_ids: ["bill-1"], import_key: "bli:l-wire" });
    use(e);
    importCosts.mockClear();
    const r2 = await fileCreditMemoWithItsBill("memo-1", "bill-1");
    expect(importCosts).not.toHaveBeenCalled();
    expect(r2.message).toContain("use Start It Over for Materials on INV-0901 before you send it.");
  });

  it("a line changed under the door is not closed, said, and its memo line keeps crediting as before", async () => {
    let once = false;
    use(books(), {
      beforeUpdate: (table, patch) => {
        if (table === "bill_line_items" && "returned_credit_bill_id" in patch && !("billable" in patch) && !once) {
          once = true;
          const house = db.tables.bill_line_items.find((l) => l.id === "l-house")!;
          house.returned_credit_bill_id = "someone-else";
        }
      },
    });
    const r = await fileCreditMemoWithItsBill("memo-1", "bill-1");
    expect(r.ok).toBe(true);
    const [credit] = credits();
    expect(db.tables.bill_line_items.find((l) => l.id === "l-house")?.returned_credit_bill_id).toBe("someone-else");
    expect(linesOf(String(credit.id))[0].billable).toBe(false); // follows the purchase line (off), as the door writes it
    expect(r.message).toContain("4 in LED Shallow IC Housing changed on the bill just now, so it was not closed.");
  });

  it("refuses, writing nothing: another company's bill; a line that isn't on the bill; lines that don't add up; no number; a lost read", async () => {
    const before = () => JSON.stringify(db.tables);
    use(books());
    let snap = before();
    expect((await fileCreditMemoWithItsBill("memo-1", "bill-x")).error).toBe("That bill isn't here any more. Reload the page. Nothing was filed.");
    expect(before()).toBe(snap);

    const s = books();
    s.bills.find((b) => b.id === "bill-1")!.supplier = "Another Supply";
    use(s);
    snap = before();
    expect((await fileCreditMemoWithItsBill("memo-1", "bill-1")).error).toBe("INV-900 isn't from Northline Supply, so the memo can't reverse it. Nothing was filed.");
    expect(before()).toBe(snap);

    const u = books();
    u.organized_items[0].line_items = [{ description: "Three Way Switch Ivory", amount: -103.7 }];
    use(u);
    snap = before();
    expect((await fileCreditMemoWithItsBill("memo-1", "bill-1")).error).toBe(
      "Three Way Switch Ivory isn't a line on INV-900, so the memo wasn't filed there. Fix Details can still file it on a job, as before.",
    );
    expect(before()).toBe(snap);

    const g = books();
    g.organized_items[0].amount = -110;
    use(g);
    snap = before();
    expect((await fileCreditMemoWithItsBill("memo-1", "bill-1")).error).toContain("so it wasn't filed.");
    expect(before()).toBe(snap);

    const n = books();
    n.organized_items[0].doc_number = null;
    use(n);
    expect((await fileCreditMemoWithItsBill("memo-1", "bill-1")).error).toContain("has no number on it");

    use(books(), { failRead: new Set(["invoice_items"]) });
    snap = before();
    expect((await fileCreditMemoWithItsBill("memo-1", "bill-1")).error).toContain("Couldn't check which invoices already bill that purchase");
    expect(before()).toBe(snap);
  });

  it("filed once: a second press is the correction door's own refusal, and nothing closes twice", async () => {
    use(books());
    await fileCreditMemoWithItsBill("memo-1", "bill-1");
    db.tables.organized_items[0].status = "needs_review";
    db.tables.organized_items[0].bill_id = null;
    const r = await fileCreditMemoWithItsBill("memo-1", "bill-1");
    expect(r.ok).toBe(false);
    expect(credits()).toHaveLength(1);
  });
});

describe("cn-v1181 fixer: what the memo door says", () => {
  const withDraft = () => {
    const t = books();
    t.invoices.push({ id: "inv-d", org_id: "org-1", invoice_number: "INV-0901", status: "draft" });
    t.invoice_items.push({ id: "ii-d", invoice_id: "inv-d", edited: false, source_ids: ["bill-1"], import_key: "bli:l-wire" });
    return t;
  };

  it("a refresh that brought nothing else says so (skeptic #84, M4)", async () => {
    use(withDraft());
    importCosts.mockResolvedValueOnce({ ok: true, error: undefined, stats: { pulled_in: 0 } } as any);
    expect((await fileCreditMemoWithItsBill("memo-1", "bill-1")).message).toContain("INV-0901 (a draft) now leaves the returned goods off, and it brought in no other new costs.");
  });

  it("a refresh with no count back says to look before sending", async () => {
    use(withDraft());
    importCosts.mockResolvedValueOnce({ ok: true, error: undefined } as any);
    expect((await fileCreditMemoWithItsBill("memo-1", "bill-1")).message).toContain("may have brought in other new costs on the job: look it over before you send it.");
  });

  const noneMemo = (t: Record<string, Row[]>) => {
    t.organized_items[0].proposal = {};
    t.organized_items[0].line_items = [{ description: "Weatherproof Box Cover", quantity: 1, amount: -9 }];
    t.organized_items[0].amount = -9;
    return t;
  };

  it("none, read in full: the plain sentence", async () => {
    use(noneMemo(books()));
    const r = await creditMemoHome("memo-1");
    expect(r).toMatchObject({ ok: true, kind: "none" });
    if (r.ok && r.kind === "none") expect(r.sentence).not.toMatch(/newest/);
  });

  it("none, but the bills read hit its cap: says the search was cut to the newest bills, with Fix Details (skeptic #84, M6)", async () => {
    const t = noneMemo(books());
    for (let i = 0; i < 2000; i++)
      t.bills.push({ ...t.bills[1], id: `filler-${i}`, supplier: "Bayberry Lumber", bill_number: `F-${i}`, created_at: "2026-10-01T00:00:00Z" });
    use(t);
    const r = await creditMemoHome("memo-1");
    expect(r).toMatchObject({ ok: true, kind: "none" });
    if (r.ok && r.kind === "none") {
      expect(r.sentence).toMatch(/Only your newest 2,000 bills were searched/);
      expect(r.sentence).toMatch(/Fix Details/);
    }
  });
});

// ── cn-v1184: FILE WITH ITS BILL ON A CREDIT ALREADY ON A JOB ────────────────────────────────────
// The credit was recorded from the job page (a bill below zero on J-901). Its slip covers goods from
// THREE invoices on the job: one line returned whole (T-543), one of three pieces of another (T-576),
// one already marked returned (T-677), and the tax. Never attached: it stays a bill of its own.
function slip() {
  const t = books();
  const L = (id: string, bill: string, org: string, sort: number, over: Row) => ({
    id, org_id: org, bill_id: bill, quantity: 1, unit_price: 0, amount: 0, category: null, billable: true, billed_amount: null, is_stock: false,
    returned: false, returned_credit_bill_id: null, pen_mark: null, sort_order: sort, ...over,
  });
  const B = (id: string, number: string, date: string, amount: number, over: Row = {}) => ({
    id, org_id: "org-1", job_id: "job-1", supplier: "Northline Supply", supplier_account_id: null, category: "Bill", scope_category: null, status: "unpaid",
    amount, bill_number: number, supplier_invoice_number: null, bill_date: date, corrects_bill_id: null, superseded_by_bill_id: null, on_shelf: false,
    created_at: `${date}T00:00:00Z`, po_id: null, ...over,
  });
  t.jobs.push({ id: "job-2", org_id: "org-1", job_number: "J-903", name: "Foxglove" });
  t.bills.push(
    B("bill-p1", "T-543", "2026-11-03", 11.34),
    B("bill-p2", "T-576", "2026-11-05", 39.2),
    B("bill-p3", "T-677", "2026-11-07", 9.9),
    B("bill-c", "CM-445", "2026-11-18", -29.7),
    // Earlier, and with the same lines: another job's bill, and another supplier's on this job. Never touched.
    B("bill-o", "T-411", "2026-11-01", 10.5, { job_id: "job-2" }),
    B("bill-y", "T-412", "2026-11-01", 10.5, { supplier: "Bayberry Lumber" }),
    B("bill-xp", "T-543", "2026-11-03", 11.34, { org_id: "org-2", job_id: "job-9" }),
  );
  const emt = (id: string, bill: string, org = "org-1") => L(id, bill, org, 0, { description: "1/2 in EMT Connector Steel", quantity: 2, unit_price: 5.25, amount: 10.5 });
  t.bill_line_items.push(
    emt("p1-a", "bill-p1"),
    L("p1-t", "bill-p1", "org-1", 1, { description: "Sales Tax", category: "Tax", unit_price: 0.84, amount: 0.84 }),
    L("p2-b", "bill-p2", "org-1", 0, { description: "3/4 in Rigid Coupling Steel", quantity: 3, unit_price: 7.1, amount: 21.3 }),
    L("p2-c", "bill-p2", "org-1", 1, { description: "Duplex Receptacle Ivory", quantity: 5, unit_price: 3, amount: 15 }),
    // Every ticket taxed evenly at 8% (the credit's tax is 8% of its parts), so filing moves no tax (S1).
    L("p2-t", "bill-p2", "org-1", 2, { description: "Sales Tax", category: "Tax", unit_price: 2.9, amount: 2.9 }),
    L("p3-g", "bill-p3", "org-1", 0, { description: "GFCI Receptacle 20A White", quantity: 1, unit_price: 9.9, amount: 9.9, billable: false, returned: true, pen_mark: "struck" }),
    emt("o-a", "bill-o"),
    emt("y-a", "bill-y"),
    emt("xp-a", "bill-xp", "org-2"),
    L("c-a", "bill-c", "org-1", 0, { description: "1/2 in EMT Connector Steel", quantity: -2, unit_price: 5.25, amount: -10.5 }),
    L("c-b", "bill-c", "org-1", 1, { description: "3/4 in Rigid Coupling Steel", quantity: -1, unit_price: 7.1, amount: -7.1 }),
    L("c-g", "bill-c", "org-1", 2, { description: "GFCI Receptacle 20A White", quantity: -1, unit_price: 9.9, amount: -9.9 }),
    L("c-t", "bill-c", "org-1", 3, { description: "Sales Tax", category: "Tax", unit_price: -2.2, amount: -2.2 }),
  );
  return t;
}
const holds = (t: Record<string, Row[]>, inv: string, status: string, ids: string[], edited = false) => {
  t.invoices.push({ id: inv, org_id: "org-1", invoice_number: inv.toUpperCase(), status });
  ids.forEach((id, k) => t.invoice_items.push({ id: `${inv}-${k}`, invoice_id: inv, edited, source_ids: [id], import_key: `bill:${id}` }));
};

describe("returnBillHome on a credit on a job (cn-v1184)", () => {
  it("names what it would close, on the same job's bills from the same supplier only, and writes nothing", async () => {
    use(slip());
    expect(await returnBillHome("bill-c")).toEqual({ ok: true, kind: "one", by: "words", candidate: { billId: "bill-c", label: "3 lines on T-543, T-576 and T-677" } });
    expect(db.writes).toEqual([]);
  });

  it("nothing would close: the sentence, and it stays a credit on the job", async () => {
    const t = slip();
    t.bills = t.bills.filter((b) => !["bill-p1", "bill-p2", "bill-p3"].includes(b.id));
    use(t);
    expect(await returnBillHome("bill-c")).toEqual({
      ok: true,
      kind: "none",
      sentence: "No bill from Northline Supply on this job carries the lines this credit returns, so nothing was closed. It stays a credit on the job, as before.",
    });
  });
});

describe("the credit, asked by both doors: each refusal one sentence, and NO write", () => {
  const refusals: [string, (t: Record<string, Row[]>) => void, RegExp][] = [
    ["not below zero", (t) => (t.bills.find((b) => b.id === "bill-c")!.amount = 30.23), /isn't a credit\b.*Nothing changed\.$/],
    ["on no job", (t) => (t.bills.find((b) => b.id === "bill-c")!.job_id = null), /isn't on a job.*Nothing changed\.$/],
    ["a correction", (t) => (t.bills.find((b) => b.id === "bill-c")!.corrects_bill_id = "bill-2"), /filed under another bill already.*Nothing changed\.$/],
    ["set aside", (t) => (t.bills.find((b) => b.id === "bill-c")!.superseded_by_bill_id = "bill-2"), /set aside as a duplicate.*Nothing changed\.$/],
    ["something filed under it", (t) => t.bills.push({ ...t.bills.find((b) => b.id === "bill-c")!, id: "bill-u", corrects_bill_id: "bill-c" }), /A correction is filed under this credit.*Nothing changed\.$/],
    ["no lines", (t) => (t.bill_line_items = t.bill_line_items.filter((l) => l.bill_id !== "bill-c")), /has no lines.*Give it its lines with Edit\. Nothing changed\.$/],
    ["lines that don't add up", (t) => (t.bills.find((b) => b.id === "bill-c")!.amount = -40), /lines come to \$29\.70 and its total is \$40\.00\. Give it its lines with Edit so they match\. Nothing changed\.$/],
    ["an invoice that went out holds it", (t) => holds(t, "inv-905", "sent", ["bill-c"]), /^INV-905 already credited this return to the customer, so it stays as it is\. Nothing changed\.$/],
    ["another company's credit", (t) => (t.bills.find((b) => b.id === "bill-c")!.org_id = "org-2"), /^That bill isn't here any more\. Reload the page\. Nothing changed\.$/],
    ["a lost read is said, never 'no bill'", () => {}, /Couldn't/],
  ];
  for (const [what, change, said] of refusals) {
    it(what, async () => {
      const t = slip();
      change(t);
      use(t, what.startsWith("a lost read") ? { failRead: new Set(["invoice_items"]) } : undefined);
      const snap = JSON.stringify(db.tables);
      const home = await returnBillHome("bill-c");
      expect(home.ok).toBe(false);
      if (!home.ok) expect(home.error).toMatch(said);
      const filed = await fileReturnBillWithItsBill("bill-c");
      expect(filed.ok).toBe(false);
      expect(filed.error).toMatch(said);
      expect(db.writes).toEqual([]);
      expect(JSON.stringify(db.tables)).toBe(snap);
    });
  }

  it("a DRAFT holding the credit does not refuse it (the owner's exact case)", async () => {
    const t = slip();
    holds(t, "inv-906", "draft", ["bill-c"]);
    use(t);
    expect(await returnBillHome("bill-c")).toMatchObject({ ok: true, kind: "one" });
  });
});

describe("fileReturnBillWithItsBill: three bills closed in one filing", () => {
  it("closes on each bill, each write read back and pinned; the credit's lines off by id; no bills row written", async () => {
    use(slip());
    const r = await fileReturnBillWithItsBill("bill-c");
    expect(r.ok).toBe(true);
    // NO BILLS ROW IS WRITTEN: the credit stays a bill of its own.
    expect(db.writes.filter((w) => w.table === "bills")).toEqual([]);
    expect(db.tables.bills.find((b) => b.id === "bill-c")).toMatchObject({ corrects_bill_id: null, job_id: "job-1", amount: -29.7 });
    const row = (l: Row) => [l.id.includes("-") && !l.id.startsWith("bill_line_items") ? l.id : "half", l.sort_order, l.quantity, l.amount, l.billable, l.returned, l.returned_credit_bill_id];
    expect(linesOf("bill-p1").map(row)).toEqual([
      ["p1-a", 0, 2, 10.5, false, true, "bill-c"],
      ["p1-t", 1, 1, 0.84, true, false, null],
    ]);
    expect(linesOf("bill-p2").map(row)).toEqual([
      ["p2-b", 0, 2, 14.2, true, false, null],
      ["half", 1, 1, 7.1, false, true, "bill-c"],
      ["p2-c", 2, 5, 15, true, false, null],
      ["p2-t", 3, 1, 2.9, true, false, null],
    ]);
    expect(linesOf("bill-p3").map(row)).toEqual([["p3-g", 0, 1, 9.9, false, true, "bill-c"]]);
    // THE CREDIT'S OWN LINES: the three part lines bill nothing; its tax line exactly as it was.
    expect(linesOf("bill-c").map((l) => [l.id, l.billable])).toEqual([
      ["c-a", false],
      ["c-b", false],
      ["c-g", false],
      ["c-t", true],
    ]);
    // Same job, same supplier, same company only.
    for (const id of ["o-a", "y-a", "xp-a"]) expect(db.tables.bill_line_items.find((l) => l.id === id)).toMatchObject({ returned: false, billable: true, returned_credit_bill_id: null });
    // EVERY WRITE NAMES THE COMPANY, ITS BILL AND ITS LINE (an insert by its columns).
    for (const w of db.writes.filter((x) => x.verb === "update")) expect(w.filters).toEqual(expect.arrayContaining(["eq:org_id", "eq:bill_id", "eq:id"]));
    expect(db.writes.filter((w) => w.verb === "update" && w.cols.join() === "billable")).toHaveLength(3);
    for (const w of db.writes.filter((x) => x.verb === "insert")) expect(w.cols).toEqual(expect.arrayContaining(["org_id", "bill_id"]));
    expect(r.message).toBe(
      "CM-445: $29.70 back from the supplier. 3 returned lines are closed on T-543, T-576 and T-677 (1/2 in EMT Connector Steel; 3/4 in Rigid Coupling Steel; GFCI Receptacle 20A White): off the customer's bill, credit received. " +
        "3/4 in Rigid Coupling Steel was split: 2 kept ($14.20), 1 returned ($7.10).",
    );
  });

  it("a second press says it is already filed, and writes nothing", async () => {
    use(slip());
    await fileReturnBillWithItsBill("bill-c");
    const n = db.writes.length;
    expect(await fileReturnBillWithItsBill("bill-c")).toEqual({ ok: false, error: "This credit is already filed: its lines are off the customer's bill." });
    expect(await returnBillHome("bill-c")).toEqual({ ok: true, kind: "none", sentence: "This credit is already filed: its lines are off the customer's bill." });
    expect(db.writes.length).toBe(n);
  });

  it("one refresh per draft, even when a draft holds the credit and two of the bills; one changed by hand is told its action", async () => {
    const t = slip();
    holds(t, "inv-906", "draft", ["bill-c", "bill-p1", "bill-p2"]);
    holds(t, "inv-907", "draft", ["bill-p3"]);
    use(t);
    importCosts.mockClear();
    importCosts.mockResolvedValue({ ok: true, error: undefined, stats: { pulled_in: 0 } } as any);
    const r = await fileReturnBillWithItsBill("bill-c");
    // Two drafts, two refreshes: INV-906 holds three of the papers and is refreshed once.
    expect(importCosts.mock.calls.map((c) => c[0]).sort()).toEqual(["inv-906", "inv-907"]);
    importCosts.mockReset();
    importCosts.mockImplementation(async () => ({ ok: true, error: undefined }));
    expect(r.message).toContain("INV-906 (a draft) now leaves the returned goods off, and it brought in no other new costs.");
    expect(r.message).toContain("INV-907 (a draft) now leaves the returned goods off");
    expect(r.message!.match(/INV-906 \(a draft\)/g)).toHaveLength(1);

    const e = slip();
    holds(e, "inv-906", "draft", ["bill-p1"], true);
    use(e);
    importCosts.mockClear();
    const r2 = await fileReturnBillWithItsBill("bill-c");
    expect(importCosts).not.toHaveBeenCalled();
    expect(r2.message).toContain("use Start It Over for Materials on INV-906 before you send it.");
  });

  it("a draft that holds ONLY the credit is brought up to date (the owner's exact case)", async () => {
    const t = slip();
    holds(t, "inv-906", "draft", ["bill-c"]);
    use(t);
    importCosts.mockClear();
    const r = await fileReturnBillWithItsBill("bill-c");
    expect(importCosts.mock.calls).toEqual([["inv-906", undefined, { keepInvoiceMarkup: true }]]);
    expect(r.message).toContain("INV-906 (a draft) now leaves the returned goods off");
  });

  it("the import is asked once per draft, with the draft's own markup kept", async () => {
    const t = slip();
    holds(t, "inv-906", "draft", ["bill-c", "bill-p1", "bill-p2"]);
    use(t);
    importCosts.mockClear();
    await fileReturnBillWithItsBill("bill-c");
    expect(importCosts.mock.calls).toEqual([["inv-906", undefined, { keepInvoiceMarkup: true }]]);
  });

  it("a bill an invoice that went out holds: its line stays a credit to the customer, the rest close", async () => {
    const t = slip();
    holds(t, "inv-905", "sent", ["bill-p1"]);
    use(t);
    const r = await fileReturnBillWithItsBill("bill-c");
    expect(r.ok).toBe(true);
    expect(db.tables.bill_line_items.find((l) => l.id === "p1-a")).toMatchObject({ returned: false, billable: true, returned_credit_bill_id: null });
    expect(linesOf("bill-c").map((l) => l.billable)).toEqual([true, false, false, true]);
    expect(r.message).toContain("1/2 in EMT Connector Steel stays a credit to the customer, as before: an invoice that went out already billed it.");
    expect(r.message).toContain("2 returned lines are closed on T-576 and T-677");
  });

  it("a closing write that fails is said, and that credit line keeps crediting; nothing is rolled back", async () => {
    use(slip(), {
      beforeUpdate: (table, patch) => {
        if (table === "bill_line_items" && patch.returned === true && patch.billable === false) db.tables.bill_line_items.find((l) => l.id === "p1-a")!.billed_amount = 4;
      },
    });
    const r = await fileReturnBillWithItsBill("bill-c");
    expect(r.ok).toBe(true);
    expect(linesOf("bill-c").map((l) => [l.id, l.billable])).toEqual([
      ["c-a", true],
      ["c-b", false],
      ["c-g", false],
      ["c-t", true],
    ]);
    expect(r.message).toContain("1/2 in EMT Connector Steel changed on the bill just now, so it was not closed.");
    expect(r.message).toContain("2 returned lines are closed on T-576 and T-677");
  });
});

// ── cn-v1184 fixer (skeptic #86) ──────────────────────────────────────────────────────────────────
describe("skeptic #86: the row's door, put right", () => {
  const snapOf = () => JSON.stringify(db.tables);

  it("S1: a ticket with an untaxed line would change what the customer pays in tax: refused by both doors, nothing written", async () => {
    const t = slip();
    // T-543 also carries an untaxed delivery charge: its $0.84 of tax is on the connectors alone.
    t.bills.find((b) => b.id === "bill-p1")!.amount = 21.84;
    t.bill_line_items.push({ ...t.bill_line_items.find((l) => l.id === "p1-a")!, id: "p1-d", description: "Delivery Charge", quantity: 1, unit_price: 10.5, amount: 10.5, sort_order: 2 });
    use(t);
    const snap = snapOf();
    const said =
      "The tax on this credit ($1.41) is not the tax its lines carry on T-543 and T-576 ($0.99), so filing it would change what the customer pays. It stays a credit on the job, as before. Nothing changed.";
    expect(await returnBillHome("bill-c")).toEqual({ ok: false, error: said });
    expect(await fileReturnBillWithItsBill("bill-c")).toEqual({ ok: false, error: said });
    expect(db.writes).toEqual([]);
    expect(snapOf()).toBe(snap);
  });

  it("S2: a line this credit already closed, its credit line switched back on: found, and taken off again (by id, read back); a draft brought up to date (S8)", async () => {
    use(slip());
    await fileReturnBillWithItsBill("bill-c");
    db.tables.bill_line_items.find((l) => l.id === "c-a")!.billable = true;
    holds(db.tables, "inv-906", "draft", ["bill-c"]);
    const purchase = JSON.stringify(db.tables.bill_line_items.filter((l) => l.bill_id !== "bill-c"));
    expect(await returnBillHome("bill-c")).toEqual({ ok: true, kind: "one", by: "words", candidate: { billId: "bill-c", label: "1 line on T-543" } });
    importCosts.mockClear();
    const n = db.writes.length;
    const r = await fileReturnBillWithItsBill("bill-c");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("1 line this credit had already closed: off the customer's bill now.");
    expect(r.message).not.toContain("nothing was closed");
    expect(db.tables.bill_line_items.find((l) => l.id === "c-a")?.billable).toBe(false);
    // Nothing on the purchases moved; the one write is the credit's own line, by id.
    expect(JSON.stringify(db.tables.bill_line_items.filter((l) => l.bill_id !== "bill-c"))).toBe(purchase);
    expect(db.writes.slice(n).filter((w) => w.table === "bill_line_items").map((w) => [w.cols.join(), w.filters.includes("eq:id")])).toEqual([["billable", true]]);
    // S8: nothing closed, but a credit line came off: the draft holding the credit follows.
    expect(importCosts.mock.calls).toEqual([["inv-906", undefined, { keepInvoiceMarkup: true }]]);
  });

  it("S3: a line somebody else split a moment ago is not split again", async () => {
    let once = false;
    use(slip(), {
      beforeUpdate: (table, patch) => {
        if (table === "bill_line_items" && "quantity" in patch && !once) {
          once = true;
          // Another tab's filing landed first: the coupling is already 2 kept.
          Object.assign(db.tables.bill_line_items.find((l) => l.id === "p2-b")!, { quantity: 2, amount: 14.2 });
        }
      },
    });
    const r = await fileReturnBillWithItsBill("bill-c");
    expect(r.ok).toBe(true);
    expect(db.tables.bill_line_items.filter((l) => l.bill_id === "bill-p2" && l.returned_credit_bill_id === "bill-c")).toEqual([]);
    expect(db.tables.bill_line_items.find((l) => l.id === "p2-b")).toMatchObject({ quantity: 2, amount: 14.2 });
    expect(r.message).toContain("3/4 in Rigid Coupling Steel changed on the bill just now, so it was not closed.");
    expect(linesOf("bill-c").find((l) => l.id === "c-b")?.billable).toBe(true);
  });

  it("S4: nothing closes because an invoice that went out billed it: the sentence says so and names it; with a line no bill carries, both sentences", async () => {
    const only = (extra: Row[] = []) => {
      const t = slip();
      t.bill_line_items = t.bill_line_items.filter((l) => !["c-g", "p3-g"].includes(l.id));
      t.bill_line_items.push(...extra);
      holds(t, "inv-905", "sent", ["bill-p1", "bill-p2"]);
      t.bills.find((b) => b.id === "bill-c")!.amount = -(10.5 + 7.1 + 2.2 + extra.reduce((s, l) => s - l.amount, 0));
      return t;
    };
    const invoiced = "An invoice that went out, INV-905, already billed what this credit returns, so it stays a credit to the customer, as before. Nothing changed.";
    use(only());
    expect(await returnBillHome("bill-c")).toEqual({ ok: true, kind: "none", sentence: invoiced });
    const cover = { ...slip().bill_line_items.find((l) => l.id === "c-g")!, id: "c-w", description: "Weatherproof Box Cover", quantity: -1, unit_price: -9, amount: -9 };
    use(only([cover]));
    expect(await returnBillHome("bill-c")).toEqual({
      ok: true,
      kind: "none",
      sentence: `${invoiced} No bill from Northline Supply on this job carries the lines this credit returns, so nothing was closed. It stays a credit on the job, as before.`,
    });
    expect(db.writes).toEqual([]);
  });

  it("S6: a tax line by its words, not its category, is written category Tax in the same filing, so the tax is never credited twice", async () => {
    const t = slip();
    t.bill_line_items.find((l) => l.id === "c-t")!.category = null;
    use(t);
    const r = await fileReturnBillWithItsBill("bill-c");
    expect(r.ok).toBe(true);
    expect(linesOf("bill-c").find((l) => l.id === "c-t")).toMatchObject({ category: "Tax", billable: true });
    const w = db.writes.find((x) => x.cols.join() === "category");
    expect(w?.filters).toEqual(expect.arrayContaining(["eq:org_id", "eq:bill_id", "eq:id"]));
    // THE MONEY: every part line of the credit is off, so the credit puts nothing in front of the
    // customer; read as a part line, its tax would have credited $2.20 on top of the purchases' own share.
    const credit = db.tables.bills.find((b) => b.id === "bill-c")! as Row & BillForItemisation;
    const rows = billItemisation(credit, linesOf("bill-c") as BillLine[], 0);
    expect(Math.round(rows.reduce((s, x) => s + x.quantity * x.unit_price, 0) * 100)).toBe(0);
  });
});
