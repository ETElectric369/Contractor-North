import { describe, it, expect, vi } from "vitest";
import { strictDb, type Row } from "@/test/strict-db";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ error: "not in a test" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { shelveLines } from "@/lib/stock-ledger";

/**
 * GOODS THAT WENT BACK ARE NEVER SHOP STOCK (cn-v1181 fixer, skeptic #84 S1). shelveLines is the one
 * door every shelving path goes through (the tray's File It to Stock, Put the Rest in Stock, a
 * supplier's stock invoice): a line returned to the supplier, or one whose pen mark is still asked,
 * is refused in one sentence before anything is written. Stand-ins: Northline Supply, Larkspur.
 */
const line = (id: string, over: Row = {}): Row => ({
  id,
  org_id: "org-1",
  bill_id: "bill-1",
  description: "12/2 NM-B Cable 250 ft",
  quantity: 1,
  unit_price: 120,
  amount: 120,
  category: "Materials",
  billable: true,
  billed_amount: null,
  sort_order: 0,
  returned: false,
  pen_mark: null,
  ...over,
});
const pick = (lineId: string) => ({ lineId, pieces: 250, used: 0, unit: "ft", bought: 1, newItemName: "12/2 NM-B" });

function db(lines: Row[], o: { pre0417?: boolean } = {}) {
  const base = strictDb({ bill_line_items: lines, stock_lot_balance: [], inventory_items: [] });
  const rpc = vi.fn(async () => ({ data: null, error: { message: "rpc reached" } }));
  const from = (t: string) => {
    const q = base.sb.from(t);
    if (!o.pre0417 || t !== "bill_line_items") return q;
    const select = q.select;
    q.select = (cols: string) => {
      // A database before 0417: asking for its columns is PostgREST's 42703.
      if (/pen_mark|returned/.test(cols)) return { eq: () => ({ eq: () => ({ order: async () => ({ data: null, error: { code: "42703", message: "column bill_line_items.returned does not exist" } }) }) }) };
      return select.call(q, cols);
    };
    return q;
  };
  return { sb: { from, rpc } as any, rpc };
}

describe("shelveLines refuses what went back", () => {
  it("a returned line: one sentence, nothing written, the shelf's transaction never asked", async () => {
    const d = db([line("l-1", { returned: true, billable: false, pen_mark: "struck" })]);
    const res = await shelveLines(d.sb, "org-1", "bill-1", [pick("l-1")]);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^12\/2 NM-B Cable 250 ft went back to the supplier.*can't go into stock/) });
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it("a line whose pen mark is still asked is refused the same way", async () => {
    const d = db([line("l-1", { pen_mark: "unclear", billable: false })]);
    expect((await shelveLines(d.sb, "org-1", "bill-1", [pick("l-1")])).ok).toBe(false);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it("an ordinary line goes on to the shelf's own steps (not refused for its pen)", async () => {
    const d = db([line("l-1")]);
    const res = await shelveLines(d.sb, "org-1", "bill-1", [pick("l-1")]);
    expect(res.ok ? "" : res.error).not.toMatch(/went back to the supplier/);
    expect(d.rpc).toHaveBeenCalled();
  });

  it("a database before 0417 is read as it always was, and nothing there went back", async () => {
    const d = db([line("l-1")], { pre0417: true });
    const res = await shelveLines(d.sb, "org-1", "bill-1", [pick("l-1")]);
    expect(res.ok ? "" : res.error).not.toMatch(/does not exist|went back/);
    expect(d.rpc).toHaveBeenCalled();
  });
});
