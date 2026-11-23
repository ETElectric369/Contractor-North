import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { readBillLines } from "./invoice-markup-read";
import { readJobBillsWithLines } from "./unbilled-work";

/**
 * THE PROJECTION LAW FOR THE RETURN MATCHER (cn-v1186). returnLinesAgainstPurchases spends what of a
 * purchase line already went back (0417's `returned`, not closed by `returned_credit_bill_id`) before
 * it credits a return. The two reads that hand it bill lines (the importer's readBillLines; the
 * Unbilled card's and the work-to-date panel's readJobBillsWithLines) must list both columns, and a
 * database behind the deploy must still be read without them.
 */
function fakeDb(o: { missing?: RegExp } = {}) {
  const selects: string[] = [];
  const from = () => {
    let cols = "";
    const q: any = {
      select: (c: string) => ((cols = c), selects.push(c), q),
      eq: () => q,
      is: () => q,
      in: () => q,
      order: () => q,
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(
          o.missing && o.missing.test(cols)
            ? { data: null, error: { code: "42703", message: "column does not exist" } }
            : { data: [], error: null },
        ).then(ok, bad),
    };
    return q;
  };
  return { db: { from } as any, selects };
}

describe("the reads that feed the return matcher list returned and returned_credit_bill_id", () => {
  it("readBillLines (the importer) asks for both, and falls back without them, then without billable", async () => {
    const a = fakeDb();
    expect(await readBillLines(a.db, ["b1"])).toEqual({ lines: [] });
    expect(a.selects).toHaveLength(1);
    expect(a.selects[0]).toMatch(/billable, billed_amount, returned, returned_credit_bill_id/);

    const behind = fakeDb({ missing: /returned/ });
    expect(await readBillLines(behind.db, ["b1"])).toEqual({ lines: [] });
    expect(behind.selects[1]).toMatch(/billable, billed_amount/);
    expect(behind.selects[1]).not.toMatch(/returned/);

    const older = fakeDb({ missing: /returned|billable/ });
    expect(await readBillLines(older.db, ["b1"])).toEqual({ lines: [] });
    expect(older.selects).toHaveLength(3);
    expect(older.selects[2]).not.toMatch(/billable|returned/);
  });

  it("readJobBillsWithLines (the Unbilled card, the work-to-date panel) asks for both, and falls back the same way", async () => {
    const a = fakeDb();
    expect((await readJobBillsWithLines(a.db, "j1")).error).toBeNull();
    expect(a.selects).toHaveLength(1);
    expect(a.selects[0]).toMatch(/bill_line_items\([^)]*billable, billed_amount, returned, returned_credit_bill_id\)/);

    const behind = fakeDb({ missing: /returned/ });
    expect((await readJobBillsWithLines(behind.db, "j1")).error).toBeNull();
    expect(behind.selects[1]).toMatch(/billable, billed_amount\)/);

    const older = fakeDb({ missing: /returned|billable/ });
    expect((await readJobBillsWithLines(older.db, "j1")).error).toBeNull();
    expect(older.selects).toHaveLength(3);
  });
});
