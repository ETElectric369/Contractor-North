import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * INK ON THE PAPER, FROM THE READER TO THE BILL (cn-v1181, lane P).
 *
 * The owner scans supplier tickets he marked up by hand (lines crossed out that went back, quantities
 * written over). Pinned here, on the server path only:
 *   P1  both readers (the tray's paperReaderSystem, the job page's billJobReceipt) carry ONE rule and
 *       ask for the pen fields;
 *   P3  what the reader saw is kept on the row's proposal (penMarks, and a credit memo's `reverses`);
 *   P5  the bill is written whole at the PRINTED total, its marked lines carry pen_mark / returned
 *       (returned only where a credit is expected), and an ordinary line's insert names exactly the
 *       columns it always named;
 *   P6  an Undo carries what a person answered back onto the paper, and File It writes it again;
 *   P7  the doors that file a paper say what ink was read.
 *
 * THE STAND-IN HONOURS THE SELECT LIST: a read hands back only the columns (and the nested columns)
 * its select names, so a read that forgot pen_mark / returned sees none, the way PostgREST would.
 * It records each write's payload (an insert's column list is its keys) and every .eq().
 * Stand-ins only: supplier Northline Supply, job J-901 "Larkspur", numbers INV-900.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/job-in-org", () => ({ jobInOrg: vi.fn(async (_s: unknown, _o: unknown, id: unknown) => !!id) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const ai = vi.hoisted(() => ({ parsed: {} as any, systems: [] as string[] }));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({
    messages: {
      create: async (args: { system?: string }) => {
        ai.systems.push(String(args?.system ?? ""));
        return { model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: {} };
      },
    },
  }),
}));
vi.mock("@/lib/ai-json", () => ({ parseAiJson: async () => ai.parsed }));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: async () => {}, modelFor: () => "test-model", aiAllowed: async () => ({ ok: true }), fallbacksFor: () => ({}) }));
vi.mock("@/lib/analytics/job-profitability", () => ({ listJobScopes: async () => [] }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));

import { billJobReceipt, fileItem, undoPaperwork } from "./actions";
import { insertItemizedBill, paperReaderSystem, readerFields } from "./paperwork-core";
import { PEN_MARKS_PROMPT_RULE } from "@/app/(app)/bills/receipt-billing";

type Call = { table: string; verb: string; payload?: any; columns?: string; eqs: [string, unknown][] };

/** "a, b, c(d, e)" -> the select's shape; "*" -> null (everything). */
type Shape = { name: string; children: Shape[] | null }[] | null;
function parseSelect(s: string): Shape {
  if (!s || s.trim() === "*") return null;
  const out: { name: string; children: Shape[] | null }[] = [];
  let depth = 0;
  let cur = "";
  const parts: string[] = [];
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    const open = p.indexOf("(");
    if (open < 0) out.push({ name: p.split(":").pop()!.trim(), children: null });
    else out.push({ name: p.slice(0, open).split(":").pop()!.trim(), children: [parseSelect(p.slice(open + 1, p.lastIndexOf(")")))] });
  }
  return out;
}
function project(data: any, shape: Shape): any {
  if (!shape || data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map((d) => project(d, shape));
  if (typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const f of shape) {
    if (!(f.name in data)) continue;
    out[f.name] = f.children ? project(data[f.name], f.children[0]) : data[f.name];
  }
  return out;
}

function fakeSupabase(script: Record<string, any[]>, calls: Call[]) {
  const next = (key: string) => {
    const q = script[key];
    if ((!q || q.length === 0) && (key === "job_shared_documents.select" || key === "job_panels.select")) return { data: [], error: null };
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    storage: {
      from: () => ({
        remove: async () => ({ data: null, error: null }),
        copy: async (_f: string, to: string) => ({ data: { path: to }, error: null }),
        download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(16) }, error: null }),
      }),
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
      const answer = () => {
        const r = next(`${table}.${verb}`);
        // A read answers only what it asked for.
        return verb === "select" && r && !r.error ? { ...r, data: project(r.data, parseSelect(mine.columns ?? "*")) } : r;
      };
      const chain: any = {
        insert(payload: any) { verb = "insert"; mine.verb = verb; mine.payload = payload; push(); return chain; },
        update(payload: any) { verb = "update"; mine.verb = verb; mine.payload = payload; push(); return chain; },
        delete() { verb = "delete"; mine.verb = verb; push(); return chain; },
        select(cols?: string) {
          if (verb === "select") {
            mine.columns = cols ?? "*";
            push();
          }
          return chain;
        },
        eq(col: string, val: unknown) { mine.eqs.push([col, val]); return chain; },
        order() { return chain; },
        not() { return chain; },
        or() { return chain; },
        is() { return chain; },
        limit() { return chain; },
        neq() { return chain; },
        in() { return chain; },
        single: () => Promise.resolve(answer()),
        maybeSingle: () => Promise.resolve(answer()),
        then(resolve: any, reject: any) {
          try { resolve(answer()); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

let calls: Call[];
beforeEach(() => {
  calls = [];
  ai.systems = [];
  ai.parsed = {};
});
const did = (table: string, verb: string) => calls.find((c) => c.table === table && c.verb === verb);

/** Northline Supply's ticket as printed: $100 + $50 + $12 tax = $162, two lines marked by hand. */
const TICKET_LINES = [
  { description: "3/4 in EMT, 10 ft", quantity: 10, unit_price: 10, amount: 100, category: "Materials", pen: "quantity", hand_quantity: 6 },
  { description: "Weatherproof box", quantity: 5, unit_price: 10, amount: 50, category: "Materials", pen: "struck", hand_quantity: null },
  { description: "Sales tax", quantity: 1, unit_price: 12, amount: 12, category: "Tax", pen: null, hand_quantity: null },
];
const ORDINARY_KEYS = ["amount", "bill_id", "billable", "category", "description", "quantity", "sort_order", "unit_price"];
/** The data API's rule for a many-row insert: a column one row leaves out is sent as NULL, never as
 *  the column's default. So every row of one insert names the same columns. */
const sameColumnsOnEveryRow = (rows: Record<string, unknown>[]) => {
  const shape = (r: Record<string, unknown>) => Object.keys(r).sort().join(",");
  return rows.every((r) => shape(r) === shape(rows[0]));
};

describe("P1: both readers learn ONE rule for ink", () => {
  it("the rule says to transcribe what is PRINTED and never to lower anything for a pen mark", () => {
    for (const words of [
      "Always transcribe what is PRINTED",
      "even when a pen line runs through it",
      "the printed total as \"amount\", even when it is crossed out or rewritten by hand",
      "Never drop a line, never set a struck line to 0, never recalculate the tax or the total for a pen mark",
      "never write about a pen mark inside \"description\"",
      "\"struck\"",
      "\"quantity\"",
      "\"unclear\"",
      "the amount KEPT",
      "a price or total changed by hand with the quantity untouched",
      "a line written entirely by hand",
      "A tick, check mark, circle, highlight, underline, initials, a signature, a margin note or a \"received\" stamp is NOT a pen mark",
      "\"hand_total\"",
    ])
      expect(PEN_MARKS_PROMPT_RULE).toContain(words);
  });

  it("the tray's reader carries the rule and asks for pen, hand_quantity, hand_total and a credit memo's reverses_number", () => {
    const sys = paperReaderSystem("electrical contractor");
    expect(sys).toContain(PEN_MARKS_PROMPT_RULE);
    expect(sys).toContain('"pen": "struck" | "quantity" | "unclear" | null, "hand_quantity": number | null}]');
    expect(sys).toContain('"hand_total": a total written by hand on the paper (a number), or null');
    expect(sys).toContain('"reverses_number": credit memos ONLY');
  });

  it("the job page's reader (Snap the Bill, Record as Cost) carries the same rule and asks for the same fields", async () => {
    ai.parsed = { vendor: "Northline Supply", amount: 162, line_items: [] };
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: { id: "doc-7", name: "t.jpg", file_url: "org-1/x/t.jpg", size_bytes: 10, job_id: "job-901" }, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bills.insert": [{ data: { id: "bill-9" }, error: null }],
        "organized_items.insert": [{ data: [{ id: "oi" }], error: null }],
      },
      calls,
    );
    await billJobReceipt("doc-7");
    const sys = ai.systems[0];
    expect(sys).toContain(PEN_MARKS_PROMPT_RULE);
    expect(sys).toContain('"pen": "struck" | "quantity" | "unclear" | null, "hand_quantity": number | null}]');
    expect(sys).toContain('"hand_total": a total written by hand on the paper (a number), or null');
  });
});

describe("P3: what the reader saw is kept on the row", () => {
  it("penMarks counts the marks and keeps a handwritten total; the lines carry each mark at the printed total", () => {
    const f = readerFields({ paper_type: "bill", kind: "receipt", amount: 162, hand_total: "123.40", line_items: TICKET_LINES, payment: "on_account" }, "t");
    expect(f.amount).toBe(162);
    expect(f.line_items).toHaveLength(4);
    expect(f.line_items!.reduce((s, l) => s + l.amount, 0)).toBe(162);
    expect(f.proposal.penMarks).toEqual({ struck: 1, quantity: 1, unclear: 0, returnedLines: 2, returnedAmount: 90, any: true, handTotal: 123.4 });
  });

  it("a paper with no pen mark carries no penMarks at all", () => {
    const f = readerFields({ paper_type: "receipt", kind: "receipt", amount: 12, line_items: [{ description: "Tape", quantity: 1, unit_price: 12, amount: 12 }] }, "t");
    expect("penMarks" in f.proposal).toBe(false);
  });

  it("a credit memo keeps the number it reverses, cleaned; any other paper never does", () => {
    const memo = readerFields({ paper_type: "credit_memo", amount: 50, reverses_number: " INV-900 ", line_items: [{ description: "Weatherproof box", quantity: 5, unit_price: -10, amount: -50 }] }, "m");
    expect(memo.proposal.reverses).toBe("INV-900");
    const bill = readerFields({ paper_type: "bill", kind: "receipt", amount: 50, reverses_number: "INV-900", line_items: [] }, "b");
    expect("reverses" in bill.proposal).toBe(false);
  });
});

describe("P5: the bill is written whole, its marked lines carry the pen (0417)", () => {
  const BILL = { job_id: "job-901", supplier: "Northline Supply", amount: 162, bill_date: null, category: "Bill", scope: { kind: "notAsked" } as const, notes: "", created_by: "user-1" };
  const lines = () => readerFields({ paper_type: "bill", kind: "receipt", amount: 162, line_items: TICKET_LINES }, "t").line_items!;

  it("ON ACCOUNT: the struck and returned lines say returned (a credit is expected); the total is the printed one", async () => {
    state.client = fakeSupabase({ "bills.insert": [{ data: { id: "bill-a" }, error: null }], "bill_line_items.insert": [{ data: [{ id: "l" }], error: null }] }, calls);
    expect(await insertItemizedBill(state.client, BILL, lines(), "unpaid")).toEqual({ id: "bill-a", refusal: null });
    expect(did("bills", "insert")!.payload.amount).toBe(162);
    const rows = did("bill_line_items", "insert")!.payload as any[];
    expect(rows.map((r) => [r.description, r.amount, r.billable, r.pen_mark, r.returned])).toEqual([
      ["3/4 in EMT, 10 ft", 60, true, "quantity", false],
      ["3/4 in EMT, 10 ft", 40, false, "quantity", true],
      ["Weatherproof box", 50, false, "struck", true],
      // THE ORDINARY LINE BESIDE A MARKED ONE SAYS WHAT THE DEFAULTS SAY (cn-v1182). This test used
      // to pin `undefined, undefined` here and call it a virtue ("names exactly the columns it always
      // named"). On the database that shape is `returned = NULL` in a NOT NULL column: the data API
      // fills a column one row leaves out with NULL, never the default, and refuses the whole insert.
      ["Sales tax", 12, true, null, false],
    ]);
    // ONE SHAPE FOR EVERY ROW OF ONE INSERT.
    expect(sameColumnsOnEveryRow(rows)).toBe(true);
    expect(Object.keys(rows[3]).sort()).toEqual([...ORDINARY_KEYS, "pen_mark", "returned"].sort());
    // 0417's checks hold on every row this writes, and so does its NOT NULL.
    for (const r of rows) {
      if (r.returned) expect(r.billable).toBe(false);
      expect(typeof r.returned).toBe("boolean");
    }
  });

  it("PAID AT PURCHASE: the same marks come off the customer's bill, and nothing is tracked as returned", async () => {
    state.client = fakeSupabase({ "bills.insert": [{ data: { id: "bill-p" }, error: null }], "bill_line_items.insert": [{ data: [{ id: "l" }], error: null }] }, calls);
    await insertItemizedBill(state.client, BILL, lines(), "paid");
    const rows = did("bill_line_items", "insert")!.payload as any[];
    expect(rows.map((r) => [r.amount, r.billable, r.pen_mark, r.returned])).toEqual([
      [60, true, "quantity", false],
      [40, false, "quantity", false],
      [50, false, "struck", false],
      [12, true, null, false],
    ]);
    expect(sameColumnsOnEveryRow(rows)).toBe(true);
    expect(did("bills", "insert")!.payload.amount).toBe(162);
  });

  it("an unclear line is written like any other, held off the bill and asked: nothing refuses it", async () => {
    state.client = fakeSupabase({ "bills.insert": [{ data: { id: "bill-u" }, error: null }], "bill_line_items.insert": [{ data: [{ id: "l" }], error: null }] }, calls);
    const unclear = readerFields({ paper_type: "bill", kind: "receipt", amount: 50, line_items: [{ ...TICKET_LINES[1], pen: "unclear" }] }, "t").line_items!;
    expect((await insertItemizedBill(state.client, BILL, unclear, "unpaid")).id).toBe("bill-u");
    expect((did("bill_line_items", "insert")!.payload as any[])[0]).toMatchObject({ billable: false, pen_mark: "unclear", returned: false });
  });

  it("a part-used amount on ONE line is named on every row of that insert (null where there is none)", async () => {
    state.client = fakeSupabase({ "bills.insert": [{ data: { id: "bill-h" }, error: null }], "bill_line_items.insert": [{ data: [{ id: "l" }], error: null }] }, calls);
    const two = [
      { description: "Wire, 250 ft", quantity: 1, unit_price: 180, amount: 180, category: "Materials", billable: true, billed_amount: 90 },
      { description: "Tape", quantity: 1, unit_price: 12, amount: 12, category: "Materials", billable: true },
    ];
    await insertItemizedBill(state.client, BILL, two as any, "unpaid");
    const rows = did("bill_line_items", "insert")!.payload as any[];
    expect(rows.map((r) => r.billed_amount)).toEqual([90, null]);
    expect(sameColumnsOnEveryRow(rows)).toBe(true);
    // No ink on this bill: the pen columns are named on no row.
    expect(rows.some((r) => "returned" in r || "pen_mark" in r)).toBe(false);
  });

  it("every mix of marked and ordinary lines goes in as ONE shape, with `returned` a real boolean on every row that names it", async () => {
    const kinds = [
      { description: "ordinary", quantity: 1, unit_price: 5, amount: 5, category: "Materials", billable: true },
      { description: "own cost", quantity: 1, unit_price: 5, amount: 5, category: "Materials", billable: false },
      { description: "struck", quantity: 1, unit_price: 5, amount: 5, category: "Materials", billable: false, pen: "struck", returned: true },
      { description: "unclear", quantity: 1, unit_price: 5, amount: 5, category: "Materials", billable: false, pen: "unclear" },
      { description: "returned by hand", quantity: 1, unit_price: 5, amount: 5, category: "Materials", billable: false, returned: true },
      { description: "part used", quantity: 1, unit_price: 5, amount: 5, category: "Materials", billable: true, billed_amount: 2 },
    ];
    // Every non-empty subset of the six kinds, on account and paid at purchase.
    for (let mask = 1; mask < 1 << kinds.length; mask++) {
      for (const status of ["unpaid", "paid"] as const) {
        calls.length = 0;
        state.client = fakeSupabase({ "bills.insert": [{ data: { id: "bill-m" }, error: null }], "bill_line_items.insert": [{ data: [{ id: "l" }], error: null }] }, calls);
        const batch = kinds.filter((_, i) => mask & (1 << i));
        await insertItemizedBill(state.client, BILL, batch as any, status);
        const rows = did("bill_line_items", "insert")!.payload as any[];
        expect(sameColumnsOnEveryRow(rows), `mask ${mask} ${status}`).toBe(true);
        for (const r of rows) {
          if ("returned" in r) expect(typeof r.returned, `mask ${mask} ${status}`).toBe("boolean");
          expect(typeof r.billable, `mask ${mask} ${status}`).toBe("boolean");
          if (r.returned) expect(r.billable).toBe(false);
        }
      }
    }
  });

  it("a bill with no pen mark writes byte-for-byte what it always wrote", async () => {
    state.client = fakeSupabase({ "bills.insert": [{ data: { id: "bill-o" }, error: null }], "bill_line_items.insert": [{ data: [{ id: "l" }], error: null }] }, calls);
    const plain = readerFields({ paper_type: "bill", kind: "receipt", amount: 12, line_items: [{ description: "Tape", quantity: 1, unit_price: 12, amount: 12, category: "Materials" }] }, "t").line_items!;
    await insertItemizedBill(state.client, BILL, plain, "unpaid");
    expect(did("bill_line_items", "insert")!.payload).toEqual([
      { bill_id: "bill-o", description: "Tape", quantity: 1, unit_price: 12, amount: 12, category: "Materials", billable: true, sort_order: 0 },
    ]);
  });
});

/** A tray paper, filed on job J-901, its bill's lines as a person left them. */
const PAPER = {
  id: "oi-1",
  kind: "receipt",
  status: "needs_review",
  doc_type: "bill",
  doc_number: null,
  title: "Northline Supply ticket",
  vendor: "Northline Supply",
  amount: 162,
  item_date: "2026-11-20",
  category: "Bill",
  payment: "on_account",
  pricing_provisional: false,
  proposal: {},
  job_id: null,
  document_id: null,
  bill_id: null,
  petty_cash_id: null,
  tied_bill_id: null,
  tied_supplier_invoice_id: null,
  file_url: "org-1/organize/ticket.jpg",
  line_items: TICKET_LINES,
};
const FILED = { ...PAPER, status: "filed", bill_id: "bill-2", document_id: "doc-1", job_id: "job-901", created_at: "2026-11-20T10:00:00Z" };
const OWN_DOC = { data: { id: "doc-1", created_at: "2026-11-20T10:05:00Z", file_url: "org-1/organize/ticket.jpg" }, error: null };
const stored = (o: Record<string, unknown>): Record<string, any> => ({ quantity: 1, unit_price: 0, category: "Materials", billed_amount: null, is_stock: false, returned_credit_bill_id: null, ...o });

describe("P6: an Undo carries the answers back onto the paper, and File It writes them again", () => {
  const ANSWERED = [
    // The split, as read.
    stored({ description: "3/4 in EMT, 10 ft", quantity: 6, unit_price: 10, amount: 60, billable: true, pen_mark: "quantity", returned: false, sort_order: 0 }),
    stored({ description: "3/4 in EMT, 10 ft", quantity: 4, unit_price: 10, amount: 40, billable: false, pen_mark: "quantity", returned: true, sort_order: 1 }),
    // A person answered KEPT on a struck line: it bills again.
    stored({ description: "Weatherproof box", quantity: 5, unit_price: 10, amount: 50, billable: true, pen_mark: "struck", returned: false, sort_order: 2 }),
    // A mark still unanswered.
    stored({ description: "Cover plate", amount: 3, billable: false, pen_mark: "unclear", returned: false, sort_order: 3 }),
    stored({ description: "Sales tax", amount: 9, category: "Tax", billable: true, pen_mark: null, returned: false, sort_order: 4 }),
  ];

  it("Undo reads the pen columns and keeps a Kept, a Returned and an open question; File It writes each again", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: FILED, error: null }, { data: [], error: null }],
        "bills.select": [{ data: { id: "bill-2", amount: 162, on_shelf: false, bill_line_items: ANSWERED }, error: null }, { data: [], error: null }],
        "documents.select": [OWN_DOC],
        "bills.delete": [{ data: [{ id: "bill-2" }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-1" }], error: null }],
      },
      calls,
    );
    const res = await undoPaperwork("oi-1");
    expect(res.ok).toBe(true);
    // The read names the three columns (the stand-in answers only what is asked for).
    const read = calls.find((c) => c.table === "bills" && c.verb === "select")!;
    expect(read.columns).toContain("pen_mark, returned, returned_credit_bill_id");
    expect(read.eqs).toContainEqual(["org_id", "org-1"]);
    const back = did("organized_items", "update")!.payload;
    expect(back.amount).toBe(162);
    expect(back.line_items.map((l: any) => [l.description, l.amount, l.billable, l.pen, l.returned])).toEqual([
      ["3/4 in EMT, 10 ft", 60, true, "quantity", false],
      ["3/4 in EMT, 10 ft", 40, false, "quantity", true],
      ["Weatherproof box", 50, true, "struck", false],
      ["Cover plate", 3, false, "unclear", undefined],
      ["Sales tax", 9, true, undefined, undefined],
    ]);

    // ...and filed again, the bill's lines carry the same answers.
    calls = [];
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, line_items: back.line_items }, error: null }],
        "bills.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [], error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-1" }], error: null }, { data: [{ id: "oi-1" }], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-3" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "l1" }], error: null }],
      },
      calls,
    );
    const filed = await fileItem("oi-1", { type: "job", jobId: "job-901" });
    expect(filed.ok).toBe(true);
    const rows = did("bill_line_items", "insert")!.payload as any[];
    expect(rows.map((r) => [r.amount, r.billable, r.pen_mark, r.returned])).toEqual([
      [60, true, "quantity", false],
      [40, false, "quantity", true],
      [50, true, "struck", false],
      [3, false, "unclear", false],
      // The ordinary line beside the marked ones names the same columns, at their defaults (cn-v1182).
      [9, true, null, false],
    ]);
    expect(sameColumnsOnEveryRow(rows)).toBe(true);
  });

  it("before 0417 is on the database the read is asked again without the pen columns, and Undo still works", async () => {
    const plain = ANSWERED.map(({ pen_mark: _p, returned: _r, returned_credit_bill_id: _c, ...rest }) => rest);
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: FILED, error: null }, { data: [], error: null }],
        "bills.select": [
          { data: null, error: { code: "42703", message: 'column bill_line_items_1.pen_mark does not exist' } },
          { data: [], error: null },
          { data: { id: "bill-2", amount: 162, on_shelf: false, bill_line_items: plain }, error: null },
        ],
        "documents.select": [OWN_DOC],
        "bills.delete": [{ data: [{ id: "bill-2" }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-1" }], error: null }],
      },
      calls,
    );
    const res = await undoPaperwork("oi-1");
    expect(res.ok).toBe(true);
    const reads = calls.filter((c) => c.table === "bills" && c.verb === "select" && String(c.columns).includes("bill_line_items("));
    expect(reads).toHaveLength(2);
    expect(reads[1].columns).not.toContain("pen_mark");
    expect(did("organized_items", "update")!.payload.line_items).toHaveLength(5);
  });
});

describe("P7: the doors that file a paper say what ink was read", () => {
  it("Snap the Bill / Record as Cost: the pen sentence rides on its own `pen` field, never on `warning` (skeptic #84, S7)", async () => {
    ai.parsed = { vendor: "Northline Supply", amount: 162, hand_total: 99.36, line_items: TICKET_LINES, payment: "on_account", confidence: "high" };
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: { id: "doc-7", name: "t.jpg", file_url: "org-1/x/t.jpg", size_bytes: 10, job_id: "job-901" }, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bills.insert": [{ data: { id: "bill-9" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli" }], error: null }],
        "organized_items.insert": [{ data: [{ id: "oi" }], error: null }],
      },
      calls,
    );
    const res = await billJobReceipt("doc-7");
    expect(res.ok).toBe(true);
    expect(res.amount).toBe(162);
    // $90 of goods back plus its share of the $12 tax ($90/$150 = $7.20): $97.20 off; $64.80 kept.
    expect(res.warning).toBeUndefined();
    expect(res.pen).toBe(
      "Pen marks read: 1 line crossed out, 1 quantity changed. $97.20 is marked returned: off the customer's bill, with a credit expected from the supplier. The total is kept as printed. Your handwritten total says $99.36; the lines read as kept come to $64.80.",
    );
    expect((did("bill_line_items", "insert")!.payload as any[]).filter((r) => r.returned === true)).toHaveLength(2);
  });

  it("an ordinary receipt says nothing new", async () => {
    ai.parsed = { vendor: "Northline Supply", amount: 12, line_items: [{ description: "Tape", quantity: 1, unit_price: 12, amount: 12 }], payment: "paid_at_purchase" };
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: { id: "doc-7", name: "t.jpg", file_url: "org-1/x/t.jpg", size_bytes: 10, job_id: "job-901" }, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "organizations.select": [{ data: { settings: {} }, error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "bills.insert": [{ data: { id: "bill-9" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli" }], error: null }],
        "organized_items.insert": [{ data: [{ id: "oi" }], error: null }],
      },
      calls,
    );
    const plain = await billJobReceipt("doc-7");
    expect(plain.warning).toBeUndefined();
    expect(plain.pen).toBeUndefined();
  });

  it("File It from the tray: the pen sentence rides on `message`, after where it went", async () => {
    const lines = readerFields({ paper_type: "bill", kind: "receipt", amount: 162, line_items: TICKET_LINES }, "t").line_items;
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...PAPER, payment: "paid_at_purchase", line_items: lines, proposal: { penMarks: { handTotal: 64.8 } } }, error: null }],
        "bills.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [], error: null }],
        "supplier_aliases.select": [{ data: [], error: null }],
        "organized_items.update": [{ data: [{ id: "oi-1" }], error: null }, { data: [{ id: "oi-1" }], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-3" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "l1" }], error: null }],
      },
      calls,
    );
    const res = await fileItem("oi-1", { type: "job", jobId: "job-901" });
    expect(res).toEqual({
      ok: true,
      message:
        "Filed. Pen marks read: 1 line crossed out, 1 quantity changed. $97.20 comes off the customer's bill. The total is kept as printed. That matches your handwritten total.",
    });
    expect(did("bills", "insert")!.payload).toMatchObject({ amount: 162, status: "paid" });
  });
});
