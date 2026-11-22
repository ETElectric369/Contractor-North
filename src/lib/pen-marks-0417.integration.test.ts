import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { penColumns, penFromColumns } from "@/lib/pen-marks";

/**
 * PEN MARKS ON THE BILL'S LINES (0417; cn-v1181), proven on the database they live on, inside ONE
 * transaction that is always rolled back:
 *   the shape    pen_mark text null, returned not null default false, returned_credit_bill_id uuid null;
 *                a line written the old way reads pen_mark null and returned false;
 *   the checks   a returned line that still bills is refused (bill_line_items_returned_not_billed); a
 *                credit closing a line that is not returned is refused (bill_line_items_credit_needs_return);
 *                a pen_mark that is not one of the three words is refused (bill_line_items_pen_mark_word);
 *   the key      deleting the credit memo's bill sets returned_credit_bill_id null: the line waits for
 *                its credit again, and stays returned and off the customer's bill;
 *   the app      every row penColumns (src/lib/pen-marks.ts) can produce is one the checks take, and
 *                penFromColumns reads it back as the paper's answer.
 *
 * 0417 is applied here ONLY when it is not on the database yet (twice: it is twice-safe). The owner
 * applies it on the test database before the deploy, so on CI that branch is not taken.
 *
 * Every company here is a TEST company minted inside the transaction (throwaway-org.db-fixture.ts).
 * No person, supplier or street here is anybody's. Never run outside CI by hand; it skips without the
 * test database's credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db src/lib/pen-marks-0417.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0417 = fileURLToPath(new URL("../../supabase/migrations/0417_pen_marks.sql", import.meta.url));

d("0417: a pen mark on a bill's line, and the credit that closes it", () => {
  let c: pg.Client;
  let orgId = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** The SQLSTATE a statement is refused with, or null when it went through (then undone). */
  const refused = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await c.query(sql, params);
      return null;
    } catch (e) {
      return String((e as { code?: string }).code ?? e);
    } finally {
      await c.query("rollback to savepoint attempt");
    }
  };
  const bill = async (supplier: string, amount: number): Promise<string> =>
    (
      await one(
        "insert into public.bills (org_id, supplier, amount, status, bill_date) values ($1, $2, $3, 'unpaid', '2001-01-02') returning id",
        [orgId, supplier, amount],
      )
    ).id as string;
  const line = async (billId: string, o: { billable?: boolean; pen_mark?: string | null; returned?: boolean; credit?: string | null } = {}): Promise<string> => {
    const cols = ["org_id", "bill_id", "description", "quantity", "unit_price", "amount", "category", "billable", "sort_order"];
    const vals: unknown[] = [orgId, billId, "TEST weatherproof box", 5, 10, 50, "Materials", o.billable ?? true, 0];
    if (o.pen_mark !== undefined) (cols.push("pen_mark"), vals.push(o.pen_mark));
    if (o.returned !== undefined) (cols.push("returned"), vals.push(o.returned));
    if (o.credit !== undefined) (cols.push("returned_credit_bill_id"), vals.push(o.credit));
    const marks = vals.map((_, i) => `$${i + 1}`).join(", ");
    return (await one(`insert into public.bill_line_items (${cols.join(", ")}) values (${marks}) returning id`, vals)).id as string;
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    // Is 0417 here? By what it left (the check), never by a ledger this suite cannot see.
    const there = await one(
      "select exists (select 1 from pg_constraint where conrelid = 'public.bill_line_items'::regclass and conname = 'bill_line_items_credit_needs_return') as there",
    );
    if (there.there !== true) {
      const sql = readFileSync(M0417, "utf8");
      await c.query(sql); // a first run: the ground check, the columns, the key, the checks, the index, the self-check
      await c.query(sql); // and the second run the file says is safe
      console.warn("[pen-marks-0417] 0417 was applied inside this suite's transaction (twice: it is twice-safe) and is rolled back with it.");
    }
    orgId = (await mintThrowawayOrg(c, { label: "0417 pen marks", techs: 0 })).orgId;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("a line written the old way reads no pen mark, not returned, no credit", async () => {
    const b = await bill("TEST Northline Supply", 50);
    const id = await line(b);
    expect(await one("select pen_mark, returned, returned_credit_bill_id from public.bill_line_items where id = $1", [id])).toEqual({
      pen_mark: null,
      returned: false,
      returned_credit_bill_id: null,
    });
  });

  it("a returned line that still bills is refused; returned and off the bill is taken", async () => {
    const b = await bill("TEST Northline Supply", 50);
    expect(
      await refused("insert into public.bill_line_items (org_id, bill_id, description, amount, billable, returned) values ($1, $2, 'TEST box', 50, true, true)", [orgId, b]),
    ).toBe("23514");
    const ok = await line(b, { billable: false, pen_mark: "struck", returned: true });
    expect(await refused("update public.bill_line_items set billable = true where id = $1", [ok])).toBe("23514");
  });

  it("a credit closing a line that is not returned is refused", async () => {
    const b = await bill("TEST Northline Supply", 50);
    const memo = await bill("TEST Northline Supply", -50);
    expect(
      await refused(
        "insert into public.bill_line_items (org_id, bill_id, description, amount, billable, returned, returned_credit_bill_id) values ($1, $2, 'TEST box', 50, false, false, $3)",
        [orgId, b, memo],
      ),
    ).toBe("23514");
    const open = await line(b, { billable: false, pen_mark: "struck", returned: true });
    expect(await refused("update public.bill_line_items set returned = false where id = $1 and returned_credit_bill_id is null", [open])).toBeNull();
    await c.query("update public.bill_line_items set returned_credit_bill_id = $2 where id = $1", [open, memo]);
    expect(await refused("update public.bill_line_items set returned = false where id = $1", [open])).toBe("23514");
  });

  it("a pen mark is one of the three words", async () => {
    const b = await bill("TEST Northline Supply", 50);
    expect(await refused("insert into public.bill_line_items (org_id, bill_id, description, amount, pen_mark) values ($1, $2, 'TEST box', 50, 'tick')", [orgId, b])).toBe("23514");
    for (const w of ["struck", "quantity", "unclear"]) expect(await line(b, { billable: false, pen_mark: w })).toBeTruthy();
  });

  it("deleting the credit memo's bill opens the line again: still returned, still off the bill", async () => {
    const b = await bill("TEST Northline Supply", 50);
    const memo = await bill("TEST Northline Supply", -50);
    const id = await line(b, { billable: false, pen_mark: "struck", returned: true, credit: memo });
    await c.query("delete from public.bills where id = $1", [memo]);
    expect(await one("select returned, billable, returned_credit_bill_id from public.bill_line_items where id = $1", [id])).toEqual({
      returned: true,
      billable: false,
      returned_credit_bill_id: null,
    });
  });

  it("every row the app writes (penColumns) is one the checks take, and reads back as the paper's answer", async () => {
    const b = await bill("TEST Northline Supply", 50);
    const marks = [undefined, "struck", "quantity", "unclear"] as const;
    for (const pen of marks)
      for (const returned of [undefined, true, false])
        for (const billable of [true, false])
          for (const creditExpected of [true, false]) {
            const cols = penColumns({ pen, returned, billable }, creditExpected);
            const id = await line(b, { billable: cols.billable, pen_mark: cols.pen_mark, returned: cols.returned });
            const row = await one("select pen_mark, returned, billable from public.bill_line_items where id = $1", [id]);
            expect(row).toEqual(cols);
            // Read back, an unclear mark is still the open question; a returned line is still returned.
            const back = penFromColumns(row);
            if (cols.pen_mark === "unclear") expect(back).toEqual({ pen: "unclear" });
            if (cols.returned) expect(back.returned).toBe(true);
          }
  });
});
