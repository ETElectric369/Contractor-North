import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";

/**
 * THE INVOICE DOORS' DATABASE FACTS (Wave 1, lane 4), pinned against the TEST database inside ONE
 * transaction that is always rolled back. Each case is a fact the TypeScript leans on and cannot
 * see from where it sits:
 *
 *   · Nort's job.create offers billing_type tm or fixed - exactly what jobs_billing_type_check
 *     takes. It offered "draw", which failed on every save, and could not ask for Time & Material.
 *   · The payment-recorded push writes its bell line first (W1-10): a notifications row of type
 *     invoice_paid, for a person in the invoice's own company.
 *   · The first send restamps an untouched draft's due date (markInvoiceSent's second write),
 *     guarded in the WHERE by invoices.due_date_by_hand = false (0366, lane 2's migration). On a
 *     database without 0366 that guard fails as a missing column, 42703, the one code the send
 *     tolerates (the date stays, the send stands). With 0366 the guard restamps an untouched
 *     draft and leaves a date a person picked.
 *   · Set Aside Until… writes the day and the why (hold_until, hold_reason) on a draft.
 *
 * No DDL: nothing here takes a lock beyond its own rows, so a suite running beside it on the test
 * database is never held up. Fixtures are a TEST company minted inside the transaction
 * (throwaway-org.db-fixture.ts).
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run src/lib/invoice-doors.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("the invoice doors' database facts (W1 lane 4)", () => {
  let c: pg.Client;
  let org = "";
  let owner = "";
  let job = "";
  let draft = "";
  let byHand = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** Run a statement that may be refused, inside a savepoint: its rows, or the code it failed with. */
  const attempt = async (sql: string, params: unknown[] = []): Promise<{ rows: any[] } | { code: string }> => {
    await c.query("savepoint attempt");
    try {
      const r = await c.query(sql, params);
      await c.query("release savepoint attempt");
      return { rows: r.rows };
    } catch (e) {
      await c.query("rollback to savepoint attempt");
      return { code: String((e as { code?: string }).code ?? e) };
    }
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const t = await mintThrowawayOrg(c, { label: "invoice doors", techs: 0 });
    org = t.orgId;
    owner = t.owner.id;
    job = (await one("insert into public.jobs (org_id, name, job_number, status, billing_type) values ($1, 'TEST invoice doors job', 'TEST-W1L4-J', 'in_progress', 'tm') returning id::text as id", [org])).id;
    draft = (
      await one(
        "insert into public.invoices (org_id, job_id, invoice_number, status, invoice_kind, title, due_date) values ($1, $2, 'TEST-W1L4-1', 'draft', 'standard', 'TEST untouched', '2026-10-01') returning id::text as id",
        [org, job],
      )
    ).id;
    byHand = (
      await one(
        "insert into public.invoices (org_id, job_id, invoice_number, status, invoice_kind, title, due_date) values ($1, $2, 'TEST-W1L4-2', 'draft', 'standard', 'TEST picked by hand', '2026-11-15') returning id::text as id",
        [org, job],
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (!c) return;
    try {
      await c.query("rollback");
    } finally {
      await c.end();
    }
  });

  it("Nort's job.create offers exactly the billing types the database takes: tm and fixed, never 'draw'", async () => {
    for (const ok of ["tm", "fixed"]) {
      const r = await attempt("insert into public.jobs (org_id, name, job_number, status, billing_type) values ($1, 'TEST bt', $2, 'scheduled', $3) returning id", [org, `TEST-W1L4-${ok}`, ok]);
      expect("rows" in r, `billing_type ${ok}`).toBe(true);
    }
    expect(await attempt("insert into public.jobs (org_id, name, job_number, status, billing_type) values ($1, 'TEST bt', 'TEST-W1L4-draw', 'scheduled', 'draw')", [org])).toEqual({ code: "23514" });
    // …and the entity's own schema says the same two words.
    const { jobActions } = await import("@/lib/actions/entities/job");
    const schema = jobActions["job.create"].input as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ name: "x", billing_type: "tm" }).success).toBe(true);
    expect(schema.safeParse({ name: "x", billing_type: "fixed" }).success).toBe(true);
    expect(schema.safeParse({ name: "x", billing_type: "draw" }).success).toBe(false);
  });

  it("the payment push's bell line is a row the notifications table takes, for a person in the invoice's company", async () => {
    const r = await attempt(
      "insert into public.notifications (org_id, user_id, type, title, body, url) values ($1, $2, 'invoice_paid', 'Payment recorded', '$624.49 on TEST-W1L4-1', $3) returning type, read_at",
      [org, owner, `/billing/${draft}`],
    );
    expect(r).toEqual({ rows: [{ type: "invoice_paid", read_at: null }] });
  });

  it("the first send's restamp is guarded by due_date_by_hand: 42703 before 0366 (tolerated, the date stays); with it, the untouched draft moves and the picked date stays", async () => {
    const hasColumn = (
      await one("select exists (select 1 from information_schema.columns where table_schema='public' and table_name='invoices' and column_name='due_date_by_hand') as yes")
    ).yes as boolean;
    const restamp = (id: string) =>
      attempt("update public.invoices set due_date = '2026-10-11' where id = $1 and org_id = $2 and due_date_by_hand = false returning id::text as id", [id, org]);
    if (!hasColumn) {
      // Before 0366: exactly the code markInvoiceSent's restamp and setInvoiceDueDate tolerate.
      expect(await restamp(draft)).toEqual({ code: "42703" });
      expect(await attempt("update public.invoices set due_date = '2026-10-11', due_date_by_hand = true where id = $1 returning id", [byHand])).toEqual({ code: "42703" });
      // …and the date is exactly as it was.
      expect((await one("select due_date::text as d from public.invoices where id = $1", [draft])).d).toBe("2026-10-01");
      return;
    }
    // With 0366: a date a person picks is flagged (setInvoiceDueDate), and the restamp leaves it.
    await c.query("update public.invoices set due_date = '2026-11-15', due_date_by_hand = true where id = $1", [byHand]);
    expect(await restamp(draft)).toEqual({ rows: [{ id: draft }] });
    expect(await restamp(byHand)).toEqual({ rows: [] });
    const dates = await c.query("select id::text as id, due_date::text as d from public.invoices where id = any($1::uuid[]) order by invoice_number", [[draft, byHand]]);
    expect(dates.rows).toEqual([
      { id: draft, d: "2026-10-11" },
      { id: byHand, d: "2026-11-15" },
    ]);
  });

  it("Set Aside Until… writes the day and the why on a draft (hold_until, hold_reason)", async () => {
    const r = await attempt(
      "update public.invoices set hold_until = '2026-10-04', hold_reason = 'Waiting on the change order' where id = $1 and status = 'draft' returning hold_until::text as until, hold_reason as why",
      [draft],
    );
    expect(r).toEqual({ rows: [{ until: "2026-10-04", why: "Waiting on the change order" }] });
  });
});
