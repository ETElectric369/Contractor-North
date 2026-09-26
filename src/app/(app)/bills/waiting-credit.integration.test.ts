import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";

/**
 * Migration 0346: a supplier bill can wait on a credit (Erik, 2026-09-26; the Hillside switch).
 *
 * supplier_invoices gains waiting_credit_since and waiting_credit_by. Pinned here, against the real
 * database, inside ONE transaction that is always rolled back:
 *   · both columns are nullable and every existing paper reads "not waiting";
 *   · staff of the paper's own company can set and clear the stamp (the server action's write);
 *   · a tech can't (0273's staff-only RLS, unchanged), and another company's staff can't touch it.
 *
 * Makes its own two companies and three people inside that transaction (the test database may
 * hold nobody), and speaks as each by planting request.jwt.claims under `set local role
 * authenticated`. Everything is named TEST 0346; the paper is dated 2001-01-01.
 *
 * Until 0346 is applied the suite waits, loudly; WAIT_APPLY_0346=1 applies it INSIDE the test's own
 * transaction, which is rolled back, so the database is left exactly as it was.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [WAIT_APPLY_0346=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, WAIT_APPLY_0346 } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const MIGRATION = fileURLToPath(new URL("../../../../supabase/migrations/0346_a_bill_can_wait_on_a_credit.sql", import.meta.url));

d("0346: a supplier bill can wait on a credit", () => {
  let c: pg.Client;
  let waiting = false;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherStaffId = "";
  let paperId = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  const ready = () => {
    return !waiting || notOnThisDatabase("[waiting-credit] 0346 is not on this database yet; set WAIT_APPLY_0346=1 to apply it inside the rolled-back transaction.");
  };
  const stamp = async (uid: string) => {
    await as(uid);
    const r = await c.query(
      "update supplier_invoices set waiting_credit_since = now(), waiting_credit_by = $2 where id = $1 returning id",
      [paperId, uid],
    );
    await asServer();
    return r.rowCount;
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has = await one(
      "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='supplier_invoices' and column_name='waiting_credit_since') as yes",
    );
    if (!has.yes && WAIT_APPLY_0346 !== "1") {
      waiting = true;
      return;
    }
    if (!has.yes) await c.query(readFileSync(MIGRATION, "utf8"));

    // ITS OWN PEOPLE, inside the transaction: two companies, an office staffer and a tech in one,
    // an office staffer in the other. The test database may hold nobody at all, and a suite that
    // borrows real people cannot run there. Invite-only (0125) is honoured, not bypassed: each
    // email goes on the allowlist first, and handle_new_user makes the profile.
    const person = async (org: string, role: string, tag: string) => {
      const email = `test-0346-${tag}@example.test`;
      await c.query("insert into signup_allowlist (email, note) values ($1, 'TEST 0346') on conflict do nothing", [email]);
      const id = (await one("insert into auth.users (id, email, aud, role) values (gen_random_uuid(), $1, 'authenticated', 'authenticated') returning id", [email])).id;
      await c.query("update profiles set org_id = $2, role = $3, active = true where id = $1", [id, org, role]);
      return String(id);
    };
    orgId = (await one("insert into organizations (name) values ('TEST 0346 ET') returning id")).id;
    const otherOrg = (await one("insert into organizations (name) values ('TEST 0346 Other') returning id")).id;
    staffId = await person(orgId, "office", "staff");
    techId = await person(orgId, "tech", "tech");
    otherStaffId = await person(otherOrg, "office", "other");
    paperId = (
      await one(
        `insert into supplier_invoices (org_id, invoice_number, kind, invoice_date, job_name_raw, total, open_balance, closed)
         values ($1, 'TEST 0346 8802-1107139', 'invoice', '2001-01-01', '13683 HILLSIDE', 59.17, 59.17, false) returning id`,
        [orgId],
      )
    ).id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("both columns are nullable, and a paper nobody set aside is not waiting", async () => {
    if (!ready()) return;
    const cols = await c.query(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema='public' and table_name='supplier_invoices' and column_name like 'waiting_credit%' order by column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "waiting_credit_by", data_type: "uuid", is_nullable: "YES" },
      { column_name: "waiting_credit_since", data_type: "timestamp with time zone", is_nullable: "YES" },
    ]);
    expect(await one("select waiting_credit_since, waiting_credit_by from supplier_invoices where id = $1", [paperId])).toEqual({
      waiting_credit_since: null,
      waiting_credit_by: null,
    });
  });

  it("a tech can't set it, and another company's staff can't either", async () => {
    if (!ready()) return;
    expect(await stamp(techId)).toBe(0);
    expect(await stamp(otherStaffId)).toBe(0);
    expect((await one("select waiting_credit_since from supplier_invoices where id = $1", [paperId])).waiting_credit_since).toBeNull();
  });

  it("staff of its own company set it and clear it (the button, and Undo)", async () => {
    if (!ready()) return;
    expect(await stamp(staffId)).toBe(1);
    const set = await one("select waiting_credit_since, waiting_credit_by from supplier_invoices where id = $1", [paperId]);
    expect(set.waiting_credit_by).toBe(staffId);
    expect(set.waiting_credit_since).toBeInstanceOf(Date);
    await as(staffId);
    const cleared = await c.query("update supplier_invoices set waiting_credit_since = null, waiting_credit_by = null where id = $1 returning id", [paperId]);
    await asServer();
    expect(cleared.rowCount).toBe(1);
  });
});
