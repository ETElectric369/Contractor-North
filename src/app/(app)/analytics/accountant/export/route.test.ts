import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * THE ACCOUNTANT'S CSV IS THE OFFICE'S (Shop Stock, Phase 4). requireStaff is the refusal: a tech (or
 * anyone it turns away) gets a 403 and not one row read. A staff download is a CSV with plain column
 * names, and it is recorded before it is handed over; a download that can't be recorded isn't made.
 */
const state: { staff: boolean; recordError: unknown; inserted: any[]; reads: string[] } = { staff: true, recordError: null, inserted: [], reads: [] };

function client() {
  const q = (table: string) => {
    state.reads.push(table);
    const rows: Record<string, any[]> = {
      organizations: [{ settings: { timezone: "America/Los_Angeles" } }],
      inventory_items: [{ id: "i1", name: "12/2 NM-B", unit: "ft" }],
      stock_lot_balance: [{ lot_id: "L1", item_id: "i1", kind: "line", bill_id: null, pieces: 250, unit: "ft", cost: 180.17, bought_on: "2026-09-02", live: true }],
      stock_lots: [{ id: "L1", note: null }],
      stock_moves: [],
      bills: [],
      jobs: [],
      bill_line_items: [],
      invoice_items: [],
    };
    const b: any = {
      _insert: null as any,
      _from: undefined as number | undefined,
      select: () => b,
      eq: () => b,
      is: () => b,
      in: () => b,
      neq: () => b,
      order: () => b,
      limit: () => b,
      range: (from: number) => {
        b._from = from;
        return b;
      },
      overlaps: () => b,
      insert: (row: any) => {
        b._insert = row;
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: rows[table]?.[0] ?? null, error: null }),
      then: (ok: any, err: any) => {
        if (table === "accountant_exports" && b._insert) {
          state.inserted.push(b._insert);
          return Promise.resolve({ data: state.recordError ? null : [{ id: "e1" }], error: state.recordError }).then(ok, err);
        }
        // Paged reads: the rows once, then an empty page.
        return Promise.resolve({ data: (b._from ?? 0) > 0 ? [] : (rows[table] ?? []), error: null }).then(ok, err);
      },
    };
    return b;
  };
  return { from: q };
}

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (state.staff ? { supabase: client(), userId: "erik", orgId: "org-et" } : { error: "This action is staff-only." })),
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { GET } from "./route";

const req = (qs: string) => new NextRequest(`https://app.contractornorth.com/analytics/accountant/export?${qs}`);

describe("GET /analytics/accountant/export", () => {
  beforeEach(() => {
    state.staff = true;
    state.recordError = null;
    state.inserted = [];
    state.reads = [];
  });

  it("refuses anyone who isn't office staff, before a single row is read", async () => {
    state.staff = false;
    const res = await GET(req("list=stock_bought&from=2026-09-01&to=2026-09-30"));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("staff-only");
    expect(state.reads).toEqual([]);
    expect(state.inserted).toEqual([]);
  });

  it("hands the office a CSV with plain column names, and remembers the download first", async () => {
    const res = await GET(req("list=stock_bought&from=2026-09-01&to=2026-09-30"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="stock-bought-2026-09-01-to-2026-09-30.csv"');
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe("Date Bought,Item,Quantity,Unit,Cost,Supplier,Ticket Number,Bought On Job,How It Came In,Note");
    expect(text).toContain("2026-09-02,12/2 NM-B,250,ft,180.17");
    expect(state.inserted).toEqual([{ org_id: "org-et", list: "stock_bought", from_at: "2026-09-01T07:00:00.000Z", to_at: expect.any(String), row_count: 1 }]);
    // The window's end, or the download's cutoff when that is earlier (a window running past today).
    expect(Date.parse(state.inserted[0].to_at)).toBeLessThanOrEqual(Date.parse("2026-10-01T07:00:00.000Z"));
  });

  it("won't hand over a list it couldn't record (a write-off in it could then be undone unseen)", async () => {
    // Postgres's own words name the table: that is a refusal, never "0350 isn't applied".
    for (const e of [
      { code: "42501", message: 'new row violates row-level security policy for table "accountant_exports"' },
      { code: "42501", message: "permission denied for table accountant_exports" },
      { code: "23514", message: 'new row for relation "accountant_exports" violates check constraint "accountant_exports_window"' },
    ]) {
      state.recordError = e;
      const res = await GET(req("list=stock_used&from=2026-09-01&to=2026-09-30"));
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("couldn't be recorded");
    }
  });

  it("the record ends where the file does: a download today is cut a moment before it was asked for", async () => {
    const before = Date.now();
    await GET(req("list=stock_used&from=2026-09-01&to=2099-12-31"));
    const to = Date.parse(state.inserted[0].to_at);
    expect(to).toBeLessThanOrEqual(before);
    expect(to).toBeGreaterThan(before - 60_000);
  });

  it("before 0350 (no record to keep) the download still comes", async () => {
    for (const e of [
      { code: "42P01", message: 'relation "public.accountant_exports" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.accountant_exports' in the schema cache" },
    ]) {
      state.recordError = e;
      const res = await GET(req("list=on_hand&to=2026-09-30"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("on-hand-2026-09-30.csv");
    }
  });

  it("an unknown list is refused in words", async () => {
    const res = await GET(req("list=payroll"));
    expect(res.status).toBe(400);
  });
});
