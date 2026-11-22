import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * KEPT OR RETURNED ON A BILL'S LINE (cn-v1181, setReceiptLineReturned). The door runs on a stand-in
 * that HONOURS what a real read honours: every eq/is filter, and the select list (a column the read
 * did not name is not on the row it gets back; a column the table has not got is an error, as
 * PostgREST's 42703 is). Two companies share it; the other company's line must never move.
 */
type Row = Record<string, any>;
const ORG = "org-a";
const OTHER = "org-b";

/** Split a select list on its top-level commas; `name!inner(a, b)` or `name(a, b)` is an embed. */
function parseSelect(list: string): { cols: string[]; embeds: { name: string; cols: string[] }[] } {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const cols: string[] = [];
  const embeds: { name: string; cols: string[] }[] = [];
  for (const p of parts) {
    const m = /^([a-z_]+)(?:!inner)?\((.*)\)$/.exec(p);
    if (m) embeds.push({ name: m[1], cols: m[2].split(",").map((c) => c.trim()).filter(Boolean) });
    else cols.push(p);
  }
  return { cols, embeds };
}
/** An embed is found by the row's own `<singular>_id` (bills -> bill_id, invoices -> invoice_id). */
const FK: Record<string, string> = { bills: "bill_id", invoices: "invoice_id" };

function standIn(tables: Record<string, Row[]>, columns: Record<string, string[]>) {
  const writes: { table: string; patch: Row; filters: string[] }[] = [];
  const from = (table: string) => {
    const filters: { col: string; test: (r: Row) => boolean }[] = [];
    let pick: ReturnType<typeof parseSelect> | null = null;
    let patch: Row | null = null;
    let single = false;
    let lim: number | null = null;
    const embedOf = (r: Row, name: string) => (tables[name] ?? []).find((x) => x.id === r[FK[name]]) ?? null;
    const valueOf = (r: Row, col: string) => {
      if (!col.includes(".")) return r[col];
      const [name, c] = col.split(".");
      return embedOf(r, name)?.[c];
    };
    const b: any = {
      select(list: string) {
        pick = parseSelect(list);
        return b;
      },
      eq(col: string, v: unknown) {
        filters.push({ col, test: (r) => valueOf(r, col) === v });
        return b;
      },
      neq(col: string, v: unknown) {
        filters.push({ col, test: (r) => valueOf(r, col) !== v });
        return b;
      },
      is(col: string, v: unknown) {
        filters.push({ col, test: (r) => (valueOf(r, col) ?? null) === v });
        return b;
      },
      contains(col: string, v: unknown[]) {
        filters.push({ col, test: (r) => Array.isArray(r[col]) && v.every((x) => r[col].includes(x)) });
        return b;
      },
      like(col: string, pattern: string) {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        filters.push({ col, test: (r) => re.test(String(r[col] ?? "")) });
        return b;
      },
      limit(n: number) {
        lim = n;
        return b;
      },
      update(p: Row) {
        patch = p;
        return b;
      },
      maybeSingle() {
        single = true;
        return b;
      },
      then(resolve: (v: unknown) => void) {
        const known = columns[table] ?? [];
        const own = [...(pick?.cols ?? []), ...filters.map((f) => f.col).filter((c) => !c.includes(".")), ...Object.keys(patch ?? {})];
        for (const c of own)
          if (c !== "id" && !known.includes(c)) return resolve({ data: null, error: { code: "42703", message: `column ${table}.${c} does not exist` } });
        for (const e of pick?.embeds ?? [])
          for (const c of e.cols)
            if (c !== "id" && !(columns[e.name] ?? []).includes(c))
              return resolve({ data: null, error: { code: "42703", message: `column ${e.name}.${c} does not exist` } });
        let hit = (tables[table] ?? []).filter((r) => filters.every((f) => f.test(r)));
        if (patch) {
          writes.push({ table, patch: { ...patch }, filters: filters.map((f) => f.col) });
          for (const r of hit) Object.assign(r, patch);
        }
        if (lim != null) hit = hit.slice(0, lim);
        const shaped = hit.map((r) => {
          const out: Row = Object.fromEntries((pick?.cols ?? Object.keys(r)).map((c) => [c, r[c]]));
          for (const e of pick?.embeds ?? []) {
            const x = embedOf(r, e.name);
            out[e.name] = x ? Object.fromEntries(e.cols.map((c) => [c, x[c]])) : null;
          }
          return out;
        });
        resolve({ data: single ? (shaped[0] ?? null) : shaped, error: null });
      },
    };
    return b;
  };
  return { sb: { from } as any, writes };
}

const LINE_COLS = ["id", "org_id", "bill_id", "description", "category", "billable", "billed_amount", "pen_mark", "returned", "returned_credit_bill_id"];
const COLUMNS = {
  bill_line_items: LINE_COLS,
  bills: ["id", "org_id", "job_id", "po_id", "status", "supplier_account_id"],
  invoice_items: ["id", "invoice_id", "edited", "source_ids", "import_key"],
  invoices: ["id", "invoice_number", "status"],
  organized_items: ["id", "org_id", "bill_id", "payment"],
  stock_lots: ["id", "org_id", "bill_line_id", "unshelved_at"],
};

let db: ReturnType<typeof standIn>;
let tables: Record<string, Row[]>;
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: db.sb, orgId: ORG }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/stock-ledger", () => ({
  restampLotsForBill: vi.fn(async () => ({ ok: true, unshelved: 0, restamped: 0 })),
  putOnShelf: vi.fn(),
  unshelveLot: vi.fn(),
}));
vi.mock("@/app/(app)/billing/actions", () => ({ importCostsIntoInvoice: vi.fn() }));
vi.mock("@/lib/actuals-draw", () => ({ BRING_IN_NEW_WORK: "Bring In New Work" }));

const { setReceiptLineReturned, setReceiptLineBillable } = await import("./receipt-billing-actions");

function seed(o: { payment?: string | null; status?: string; account?: string | null; line?: Row } = {}) {
  tables = {
    bills: [
      { id: "bill-1", org_id: ORG, job_id: "job-larkspur", status: o.status ?? "unpaid", supplier_account_id: o.account === undefined ? "acct-northline" : o.account },
      { id: "bill-9", org_id: OTHER, job_id: "job-other", status: "unpaid", supplier_account_id: null },
    ],
    bill_line_items: [
      { id: "l-1", org_id: ORG, bill_id: "bill-1", description: "20A breaker", category: "Electrical", billable: false, billed_amount: null, pen_mark: "unclear", returned: false, returned_credit_bill_id: null, ...o.line },
      { id: "l-9", org_id: OTHER, bill_id: "bill-9", description: "20A breaker", category: "Electrical", billable: false, billed_amount: null, pen_mark: "unclear", returned: false, returned_credit_bill_id: null },
    ],
    organized_items: o.payment === undefined ? [] : [{ id: "p-1", org_id: ORG, bill_id: "bill-1", payment: o.payment }],
    stock_lots: [],
    invoice_items: [],
    invoices: [],
  };
  db = standIn(tables, COLUMNS);
}
const line = (id = "l-1") => tables.bill_line_items.find((r) => r.id === id)!;

beforeEach(() => seed());

describe("Returned", () => {
  it("on account: returned with a credit tracked, off the bill, an unclear mark becomes struck", async () => {
    seed({ payment: "on_account", line: { billed_amount: 4.5 } });
    expect(await setReceiptLineReturned("l-1", true)).toEqual({ ok: true });
    expect(line()).toMatchObject({ returned: true, billable: false, billed_amount: null, pen_mark: "struck" });
  });

  it("a receipt paid at purchase (the paper says so): off the bill, no credit tracked", async () => {
    seed({ payment: "paid_at_purchase" });
    expect((await setReceiptLineReturned("l-1", true)).ok).toBe(true);
    expect(line()).toMatchObject({ returned: false, billable: false, pen_mark: "struck" });
  });

  it("the paper's tender wins over the bill: paid with no account, but the paper says on account", async () => {
    seed({ payment: "on_account", status: "paid", account: null });
    await setReceiptLineReturned("l-1", true);
    expect(line().returned).toBe(true);
  });

  it("no paper: a paid bill with no supplier account is a counter sale, nothing tracked", async () => {
    seed({ status: "paid", account: null });
    await setReceiptLineReturned("l-1", true);
    expect(line().returned).toBe(false);
    expect(line().billable).toBe(false);
  });
});

describe("Kept", () => {
  it("an unclear mark is cleared and the line bills again", async () => {
    seed({ payment: "on_account" });
    expect((await setReceiptLineReturned("l-1", false)).ok).toBe(true);
    expect(line()).toMatchObject({ returned: false, pen_mark: null, billable: true });
  });

  it("a returned struck line comes back on the bill and keeps its mark", async () => {
    seed({ payment: "on_account", line: { pen_mark: "struck", returned: true } });
    await setReceiptLineReturned("l-1", false);
    expect(line()).toMatchObject({ returned: false, pen_mark: "struck", billable: true });
  });

  it("a snack stays off: billable is what the line would be with nothing stored", async () => {
    seed({ payment: "paid_at_purchase", line: { description: "Sports drink 20oz", category: "Food & Drink" } });
    await setReceiptLineReturned("l-1", false);
    expect(line()).toMatchObject({ billable: false, pen_mark: null, returned: false });
  });
});

describe("refusals", () => {
  it("a line whose credit is already filed is never changed, and the sentence names the one action", async () => {
    seed({ payment: "on_account", line: { pen_mark: "struck", returned: true, returned_credit_bill_id: "bill-credit" } });
    const res = await setReceiptLineReturned("l-1", false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already filed.*delete that credit memo's bill first/);
    expect(line()).toMatchObject({ returned: true, billable: false });
    expect(db.writes).toHaveLength(0);
  });

  it("the write itself repeats the credit filter (a credit filed between read and write)", async () => {
    seed({ payment: "on_account" });
    await setReceiptLineReturned("l-1", true);
    const w = db.writes.find((x) => x.table === "bill_line_items")!;
    expect(w.filters).toEqual(expect.arrayContaining(["id", "org_id", "returned_credit_bill_id"]));
  });

  it("a roll in stock on the line refuses, as setReceiptLineBillable does", async () => {
    seed({ payment: "on_account" });
    tables.stock_lots.push({ id: "lot-1", org_id: ORG, bill_line_id: "l-1", unshelved_at: null });
    const res = await setReceiptLineReturned("l-1", true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Take It Out of Stock first/);
    expect(line().pen_mark).toBe("unclear");
  });

  it("another company's line is never read or written", async () => {
    seed({ payment: "on_account" });
    const res = await setReceiptLineReturned("l-9", true);
    expect(res.ok).toBe(false);
    expect(line("l-9")).toMatchObject({ pen_mark: "unclear", returned: false });
  });

  it("a failed read of the paper is said, never taken for no paper", async () => {
    seed({ payment: "on_account" });
    db = standIn(tables, { ...COLUMNS, organized_items: ["id", "org_id", "bill_id"] });
    const res = await setReceiptLineReturned("l-1", true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Couldn't read the paper/);
    expect(line().pen_mark).toBe("unclear");
  });

  it("a database without 0417 refuses in words, writes nothing", async () => {
    seed({ payment: "on_account" });
    db = standIn(tables, { ...COLUMNS, bill_line_items: LINE_COLS.filter((c) => !["pen_mark", "returned", "returned_credit_bill_id"].includes(c)) });
    const res = await setReceiptLineReturned("l-1", true);
    expect(res.ok).toBe(false);
    expect(db.writes).toHaveLength(0);
  });
});

describe("a line the customer was already billed for (skeptic #84, S2): both doors refuse before any write", () => {
  const claim = (status: string, by: "source" | "key" | "po" = "source") => {
    tables.invoices.push({ id: "inv-1", invoice_number: "INV-900", status });
    tables.invoice_items.push({
      id: "ii-1",
      invoice_id: "inv-1",
      edited: false,
      source_ids: by === "source" ? ["bill-1"] : by === "po" ? ["po-1"] : [],
      import_key: by === "key" ? "bill:bill-1:l-1" : null,
    });
  };

  it("Returned on a bill a sent invoice claims: one sentence naming the invoice and the credit memo, nothing written", async () => {
    seed({ payment: "on_account", line: { pen_mark: null, billable: true } });
    claim("sent");
    const res = await setReceiptLineReturned("l-1", true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^INV-900 has gone to the customer.*credit memo.*file it with this bill.*customer's next invoice/);
    expect(db.writes).toHaveLength(0);
    expect(line()).toMatchObject({ returned: false, billable: true });
  });

  it("Kept is refused the same way, and an older import key counts as a claim", async () => {
    seed({ payment: "on_account", line: { pen_mark: "struck", returned: true } });
    claim("paid", "key");
    expect((await setReceiptLineReturned("l-1", false)).error).toMatch(/INV-900 has gone to the customer/);
    expect(db.writes).toHaveLength(0);
  });

  it("the Bill switch refuses on a bill whose ORDER a sent invoice bills", async () => {
    seed({ payment: "on_account", line: { pen_mark: null, billable: true } });
    tables.bills[0].po_id = "po-1";
    claim("sent", "po");
    const res = await setReceiptLineBillable("l-1", false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/INV-900 has gone to the customer and already bills the order this receipt delivered/);
    expect(db.writes).toHaveLength(0);
  });

  it("a draft claimant is not a wall: both doors still write", async () => {
    seed({ payment: "on_account", line: { pen_mark: null, billable: true } });
    claim("draft");
    expect((await setReceiptLineBillable("l-1", false)).ok).toBe(true);
    expect((await setReceiptLineReturned("l-1", true)).ok).toBe(true);
  });

  it("a voided invoice is no claim", async () => {
    seed({ payment: "on_account", line: { pen_mark: null, billable: true } });
    claim("void");
    expect((await setReceiptLineReturned("l-1", true)).ok).toBe(true);
  });

  it("a failed claims read refuses in both doors, nothing written", async () => {
    seed({ payment: "on_account", line: { pen_mark: null, billable: true } });
    db = standIn(tables, { ...COLUMNS, invoice_items: ["id", "invoice_id", "edited"] });
    expect((await setReceiptLineReturned("l-1", true)).error).toMatch(/Couldn't check which invoices already bill this receipt, so nothing was changed/);
    expect((await setReceiptLineBillable("l-1", false)).error).toMatch(/Couldn't check which invoices already bill this receipt, so nothing was changed/);
    expect(db.writes).toHaveLength(0);
  });
});

describe("the Bill switch on a returned line (skeptic #84, M3)", () => {
  it("answers in one sentence naming Kept, never the database's check, and writes nothing", async () => {
    seed({ payment: "on_account", line: { pen_mark: "struck", returned: true, billable: false } });
    const res = await setReceiptLineBillable("l-1", true);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/went back to the supplier.*Press Kept/) });
    expect(db.writes).toHaveLength(0);
  });

  it("switching a returned line OFF is not refused by it", async () => {
    seed({ payment: "on_account", line: { pen_mark: "struck", returned: true, billable: false } });
    expect((await setReceiptLineBillable("l-1", false)).ok).toBe(true);
  });

  it("a database before 0417 has no returned line: the switch goes on as it always did", async () => {
    seed({ payment: "on_account", line: { pen_mark: null, billable: false } });
    db = standIn(tables, { ...COLUMNS, bill_line_items: LINE_COLS.filter((c) => !["pen_mark", "returned", "returned_credit_bill_id"].includes(c)) });
    expect((await setReceiptLineBillable("l-1", true)).ok).toBe(true);
    expect(line().billable).toBe(true);
  });
});
