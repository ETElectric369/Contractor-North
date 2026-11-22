import { describe, it, expect, vi, beforeEach } from "vitest";
import { strictDb, type Row } from "@/test/strict-db";

/**
 * KEPT OR RETURNED ON A WAITING PAPER (cn-v1181, lane T1): setPaperLineReturned, on a stand-in that
 * honours filters and select lists. Each rule below is red without its line in the action.
 */

const state = vi.hoisted(() => ({ client: null as any, staff: true }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (state.staff ? { supabase: state.client, userId: "user-1", orgId: "org-1" } : { error: "This action is staff-only." })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setPaperLineReturned } from "./pen-line-actions";

const LINES = () => [
  { description: "12-2 NM-B WIRE 250FT", quantity: 2, unit_price: 120, amount: 240, category: "Materials", billable: false, pen: "struck", returned: true },
  { description: "SINGLE POLE BREAKER", quantity: 4, unit_price: 10, amount: 40, category: "Materials", billable: false, pen: "unclear" },
  { description: "GATORADE", quantity: 1, unit_price: 3, amount: 3, category: "Food & Drink", billable: false, pen: "unclear" },
  { description: "WIRE NUTS", quantity: 1, unit_price: 9, amount: 9, category: "Materials", billable: true },
];
let db: ReturnType<typeof strictDb>;
const paper = (over: Row = {}): Row => ({ id: "oi-1", org_id: "org-1", status: "needs_review", payment: "on_account", line_items: LINES(), ...over });
const linesOf = (id = "oi-1") => db.tables.organized_items.find((r) => r.id === id)!.line_items as Row[];

beforeEach(() => {
  state.staff = true;
  db = strictDb({
    organized_items: [paper(), paper({ id: "oi-other", org_id: "org-2" })],
  });
  state.client = db.sb;
});

describe("setPaperLineReturned", () => {
  it("staff only: a tech's call writes nothing", async () => {
    state.staff = false;
    const res = await setPaperLineReturned("oi-1", 1, true, "SINGLE POLE BREAKER");
    expect(res.ok).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it("RETURNED on an unclear line: returned, off the customer's bill, the mark becomes struck; read back; nothing else moves", async () => {
    const res = await setPaperLineReturned("oi-1", 1, true, "SINGLE POLE BREAKER");
    expect(res).toEqual({ ok: true, message: "SINGLE POLE BREAKER: off the customer's bill." });
    const l = linesOf();
    expect(l[1]).toMatchObject({ pen: "struck", returned: true, billable: false });
    expect(l[0]).toEqual(LINES()[0]);
    expect(l[3]).toEqual(LINES()[3]);
    // Another company's paper is never touched.
    expect(linesOf("oi-other")).toEqual(LINES());
  });

  it("KEPT on an unclear line: the mark is removed, returned false, billable back to what the words say", async () => {
    await setPaperLineReturned("oi-1", 1, false, "SINGLE POLE BREAKER");
    const l = linesOf()[1];
    expect(l.pen).toBeUndefined();
    expect(l).toMatchObject({ returned: false, billable: true });
    // A snack kept stays off the customer's bill (decideReceiptLine with nothing stored).
    await setPaperLineReturned("oi-1", 2, false, "GATORADE");
    expect(linesOf()[2]).toMatchObject({ returned: false, billable: false });
    expect(linesOf()[2].pen).toBeUndefined();
  });

  it("KEPT on a struck line keeps the mark (it is what the reader saw) and puts the line back on the bill", async () => {
    await setPaperLineReturned("oi-1", 0, false, "12-2 NM-B WIRE 250FT");
    expect(linesOf()[0]).toMatchObject({ pen: "struck", returned: false, billable: true });
  });

  it("refuses a paper already filed, and writes nothing", async () => {
    db.tables.organized_items[0].status = "filed";
    const res = await setPaperLineReturned("oi-1", 1, true, "SINGLE POLE BREAKER");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already filed/);
    expect(db.writes).toEqual([]);
  });

  it("refuses when the line at that place has other words (the lines changed): reload", async () => {
    const res = await setPaperLineReturned("oi-1", 1, true, "12-2 NM-B WIRE 250FT");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Reload the page/);
    expect(db.writes).toEqual([]);
  });

  it("refuses a line with no pen mark, and a place past the end", async () => {
    expect((await setPaperLineReturned("oi-1", 3, true, "WIRE NUTS")).error).toMatch(/no pen mark/);
    expect((await setPaperLineReturned("oi-1", 9, true, "")).ok).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it("another company's paper is not found, and is not written", async () => {
    const res = await setPaperLineReturned("oi-other", 1, true, "SINGLE POLE BREAKER");
    expect(res).toEqual({ ok: false, error: "That paper isn't here any more. Reload the page." });
    expect(db.writes).toEqual([]);
  });

  it("a paper filed between the read and the write: zero rows is said, never taken for done", async () => {
    const real = db.sb.from;
    db.sb.from = (t: string) => {
      const q = real(t);
      const upd = q.update;
      q.update = (p: Row) => {
        db.tables.organized_items[0].status = "filed"; // filed from another screen meanwhile
        return upd(p);
      };
      return q;
    };
    const res = await setPaperLineReturned("oi-1", 1, true, "SINGLE POLE BREAKER");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/didn't save/);
  });

  it("a failed read is said, never 'not here'", async () => {
    state.client = strictDb({ organized_items: [paper()] }, { fail: (t, v) => (t === "organized_items" && v === "select" ? "connection reset" : undefined) }).sb;
    const res = await setPaperLineReturned("oi-1", 1, true, "SINGLE POLE BREAKER");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing changed/);
    expect(res.error).not.toMatch(/isn't here/);
  });
});
