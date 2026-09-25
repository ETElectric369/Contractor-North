import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { readInvoiceMarkup } from "./invoice-markup-read";
import { markupBoxSeed, markupBoxStart, markupBoxWords } from "./invoice-markup";

/**
 * THE ONE READ BEHIND "WHAT IS THIS INVOICE PRICED AT" (2026-09-25). The importer's
 * keepInvoiceMarkup and the invoice page's % box both call readInvoiceMarkup, so a draft the
 * importer keeps at 11% is a draft the box shows at 11%.
 */

type Row = Record<string, unknown>;

/** A supabase-shaped fake over plain tables: select/eq/is/in/order/maybeSingle, and a log of
 *  which tables were read. */
function fakeDb(tables: Record<string, Row[]>, fail: Partial<Record<string, boolean>> = {}) {
  const reads: string[] = [];
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let single = false;
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
      order: () => q,
      maybeSingle: () => ((single = true), q),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        reads.push(table);
        if (fail[table]) return Promise.resolve({ data: null, error: { message: `${table} read failed` } }).then(ok, bad);
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(ok, bad);
      },
    };
    return q;
  };
  return { db: { from }, reads };
}

const INV = "09ff65de-2ec8-4884-a31f-583a8943b09a";
const JOB = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";

/**
 * INV-078 AS IT STANDS IN ERIK'S DATABASE ON 2026-09-25 (read-only), after he moved it to 11%:
 * every untouched CED bill bills exactly cost x 1.11 across its item rows and remainder; three bills
 * carry an edited remainder (no vote); one receipt line was switched off and its row deleted
 * (tombstoned); a supplier return with nothing on the invoice. Amounts are the live ones.
 */
const BILLS: { id: string; amount: string; lines: [number, boolean, string][]; inv: [number, boolean][] }[] = [
  { id: "387341c7", amount: "477.40", lines: [[44.22, true, "Electrical"], [13.57, true, "Electrical"], [25.8, true, "Electrical"], [29.68, true, "Electrical"], [35.49, true, "Electrical"], [12.33, true, "Electrical"], [165.29, true, "Electrical"], [111.6, true, "Electrical"], [39.42, true, "Tax"]], inv: [[49.17, false], [15.06, false], [28.6, false], [32.96, false], [39.39, false], [13.69, false], [183.47, false], [33.84, true]] },
  { id: "11e96fc3", amount: "199.48", lines: [[8.82, true, "Electrical"], [165.29, true, "Electrical"], [8.9, true, "Electrical"], [16.47, true, "Tax"]], inv: [[9.79, false], [183.47, false], [9.88, false], [18.28, false]] },
  { id: "15b0e967", amount: "150.27", lines: [[80.4, true, "Electrical"], [52.95, true, "Electrical"], [4.51, true, "Electrical"], [12.41, true, "Tax"]], inv: [[89, false], [58.8, false], [5.01, false], [13.99, false]] },
  { id: "0c93fb13", amount: "873.66", lines: [[66.03, true, "Electrical"], [385.77, true, "Electrical"], [79.52, true, "Electrical"], [5.64, true, "Electrical"], [100.98, true, "Electrical"], [47.32, false, "Electrical"], [88.06, true, "Electrical"], [11.7, true, "Electrical"], [16.5, true, "Electrical"], [72.14, true, "Tax"]], inv: [[73.16, false], [428.23, false], [88.28, false], [6.26, false], [112.08, false], [97.75, false], [12.96, false], [18.48, false], [78.17, true]] },
  { id: "a7a224ba", amount: "297.66", lines: [[65, true, "Electrical"], [168, true, "Electrical"], [41.94, true, "Electrical"], [22.72, true, "Tax"]], inv: [[72.15, false], [186.48, false], [46.56, false], [26.12, true]] },
  { id: "c9daf1b8", amount: "103.99", lines: [[95.4, true, "Electrical"], [8.59, true, "Tax"]], inv: [[105.88, false], [9.55, false]] },
  { id: "2f328286", amount: "-51.58", lines: [[-47.32, false, "Electrical"], [-4.26, false, "Tax"]], inv: [] },
  { id: "e2380fc9", amount: "323.71", lines: [[32.46, true, "Electrical"], [6.92, true, "Electrical"], [4.22, true, "Electrical"], [184.88, true, "Electrical"], [58.79, true, "Electrical"], [6.64, true, "Electrical"], [3.07, true, "Electrical"], [26.73, true, "Tax"]], inv: [[36.03, false], [7.68, false], [4.68, false], [205.2, false], [65.26, false], [7.37, false], [3.41, false], [29.69, false]] },
];

function inv078(overrides: { inv?: (b: (typeof BILLS)[number]) => [number, boolean][] } = {}) {
  const bills: Row[] = [];
  const bill_line_items: Row[] = [];
  const invoice_items: Row[] = [];
  for (const b of BILLS) {
    bills.push({ id: b.id, amount: b.amount, job_id: JOB, superseded_by_bill_id: null });
    b.lines.forEach(([amount, billable, category], i) =>
      bill_line_items.push({ id: `${b.id}-l${i}`, bill_id: b.id, amount, billable, billed_amount: null, category, sort_order: i }),
    );
    const rows = overrides.inv ? overrides.inv(b) : b.inv;
    rows.forEach(([line_total, edited], i) =>
      invoice_items.push({ invoice_id: INV, import_source: "costs", import_key: i === rows.length - 1 ? `bill:${b.id}:remainder` : `bli:${b.id}-l${i}`, source_ids: [b.id], line_total, edited }),
    );
  }
  // A set-aside duplicate is not a cost (0271): the importer's filter, so the box's too.
  bills.push({ id: "dup-1", amount: "500.00", job_id: JOB, superseded_by_bill_id: "11e96fc3" });
  invoice_items.push({ invoice_id: INV, import_source: "labor", import_key: "labor:x", source_ids: ["t-1"], line_total: 1000, edited: false });
  return {
    invoices: [{ id: INV, dismissed_import_keys: ["labor:07b85435:2", "bli:0c93fb13-l5", "bli:387341c7-l7"] }],
    invoice_items,
    bills,
    purchase_orders: [] as Row[],
    bill_line_items,
  };
}

describe("readInvoiceMarkup — the importer's read, shared with the % box", () => {
  it("INV-078 at 11%: the helper says 11, and the box starts at 11 beside 'Priced at 11%'", async () => {
    const { db, reads } = fakeDb(inv078());
    const read = await readInvoiceMarkup(db, INV, JOB);
    expect(read).toEqual({ ok: true, reading: { kind: "one", pct: 11 } });
    const seed = markupBoxSeed(read.ok ? read.reading : "unread", "15.00");
    expect(markupBoxStart(seed)).toEqual({ value: 11, applied: 11, appliedHere: false });
    expect(markupBoxWords(seed, "Andrew Cohen")).toEqual({ main: "Priced at 11%", usual: "Andrew Cohen's usual is 15%" });
    expect(reads.sort()).toEqual(["bill_line_items", "bills", "invoice_items", "invoices", "purchase_orders"]);
  });

  it("a fresh invoice (no materials lines): nothing to read, the job's receipts are not even opened, the box starts at the customer's level", async () => {
    const t = inv078();
    t.invoice_items = t.invoice_items.filter((r) => r.import_source !== "costs");
    const { db, reads } = fakeDb(t);
    const read = await readInvoiceMarkup(db, INV, JOB);
    expect(read).toEqual({ ok: true, reading: { kind: "none" } });
    expect(reads.sort()).toEqual(["invoice_items", "invoices"]);
    expect(markupBoxSeed(read.ok ? read.reading : "unread", 15)).toEqual({ pct: 15, source: "usual", usualPct: 15 });
  });

  it("bills at different markups: no single answer - the box says so and starts at the customer's level", async () => {
    // Half the untouched bills put back to 15%, half left at 11%.
    const at15 = new Set(["11e96fc3", "15b0e967"]);
    const { db } = fakeDb(
      inv078({
        inv: (b) =>
          at15.has(b.id)
            ? [[Math.round(Number(b.amount) * 1.15 * 100) / 100, false]]
            : b.inv,
      }),
    );
    const read = await readInvoiceMarkup(db, INV, JOB);
    expect(read).toEqual({ ok: true, reading: { kind: "mixed" } });
    const seed = markupBoxSeed(read.ok ? read.reading : "unread", 15);
    expect(seed).toEqual({ pct: 15, source: "mixed", usualPct: 15 });
    expect(markupBoxWords(seed, "Andrew Cohen").main).toBe("Lines are at different markups");
  });

  it("a lost read is a refusal, never 'no lines'", async () => {
    for (const table of ["invoice_items", "invoices", "bills", "purchase_orders", "bill_line_items"]) {
      const { db } = fakeDb(inv078(), { [table]: true });
      const read = await readInvoiceMarkup(db, INV, JOB);
      expect(read.ok, table).toBe(false);
    }
  });

  it("the importer hands over what it already read: only the invoice's own rows are fetched, and the answer is the same", async () => {
    const t = inv078();
    const { db, reads } = fakeDb(t);
    const live = t.bills.filter((b) => b.superseded_by_bill_id === null);
    const linesByBill = new Map<string, any[]>();
    for (const l of t.bill_line_items) {
      const k = String(l.bill_id);
      if (!linesByBill.has(k)) linesByBill.set(k, []);
      linesByBill.get(k)!.push(l);
    }
    const read = await readInvoiceMarkup(db, INV, JOB, {
      bills: live.map((b) => ({ id: String(b.id), amount: b.amount })),
      pos: [],
      linesByBill,
    });
    expect(read).toEqual({ ok: true, reading: { kind: "one", pct: 11 } });
    expect(reads.sort()).toEqual(["invoice_items", "invoices"]);
  });
});
