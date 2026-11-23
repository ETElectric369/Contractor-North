import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * A CUSTOMER'S OWN PAGE STARTS OFF (0419; cn-v1186), proven on the database it lives on, inside ONE
 * transaction that is always rolled back. The owner: "lets set the customer portal to default as OFF
 * and then we can turn it on when needed for who needs it only".
 *   (a) the default   a customer made now gets its link at once (0298's trigger), with a token, OFF;
 *   (b) the sweep     with the default put back to true, five links that are all on: never used; opened
 *                     (last_opened_at); a customer's own device (a 'customer' session); a sign-in code
 *                     asked for; and an office look only (an 'office' session, which never counts). The
 *                     file's own text turns off ONLY the never-used one and the office-look one, stamps
 *                     disabled_at, leaves the other three exactly on, and the default is false again;
 *   (c) twice-safe    a never-used link the office turned on by hand stays on when the file runs again
 *                     (the sweep runs only while the default is still true);
 *   (d) the stamps    invoices.resend_dismissed_at and bills.duplicate_dismissed_at: nullable timestamptz.
 *
 * 0419 is applied here ONLY when it is not on the database yet (it is twice-safe). The owner applies it
 * on the test database before the deploy, so on CI that branch is not taken.
 *
 * Every company here is a TEST company minted inside the transaction (throwaway-org.db-fixture.ts).
 * No person or place here is anybody's. It skips without the test database's credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db src/lib/portal-starts-off-0419.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0419 = fileURLToPath(new URL("../../supabase/migrations/0419_the_portal_starts_off_and_two_put_aways.sql", import.meta.url));

d("0419: a customer's own page starts off, and two notices can be put away", () => {
  let c: pg.Client;
  let orgId = "";
  let sql0419 = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const defaultOfEnabled = async () =>
    (
      await one(
        `select column_default as d from information_schema.columns
          where table_schema = 'public' and table_name = 'customer_portal_access' and column_name = 'enabled'`,
      )
    )?.d as string | null;
  const customer = async (name: string) =>
    (await one("insert into public.customers (org_id, name) values ($1, $2) returning id", [orgId, name])).id as string;
  const link = async (customerId: string) =>
    one("select token, enabled, disabled_at, disabled_by from public.customer_portal_access where customer_id = $1", [customerId]);
  const hex = (n: 32 | 64) => (n === 32 ? "md5(random()::text)" : "md5(random()::text) || md5(random()::text)");

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");
    sql0419 = readFileSync(M0419, "utf8");
    // Is 0419 here? By what it left (the default and the two columns), never by a ledger.
    const there = await one(
      `select (select column_default from information_schema.columns
                where table_schema = 'public' and table_name = 'customer_portal_access' and column_name = 'enabled') = 'false'
          and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'invoices' and column_name = 'resend_dismissed_at')
          and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'bills' and column_name = 'duplicate_dismissed_at') as there`,
    );
    if (there.there !== true) {
      console.warn("[portal-starts-off-0419] 0419 applied inside this rolled-back transaction: the database did not have it yet, and every case still runs.");
      await c.query(sql0419);
    }
    orgId = (await mintThrowawayOrg(c, { label: "0419", techs: 1 })).orgId;
  });
  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("(a) a customer made now has its link at once, with a token, and OFF", async () => {
    await c.query("savepoint a");
    try {
      expect(await defaultOfEnabled()).toBe("false");
      const id = await customer("TEST 0419 Larkspur");
      const row = await link(id);
      expect(row?.token).toMatch(/^[0-9a-f]{32}$/);
      expect(row?.enabled).toBe(false);
    } finally {
      await c.query("rollback to savepoint a");
    }
  });

  it("(b) the sweep turns off only a link nobody has used, and sets the default to false", async () => {
    await c.query("savepoint b");
    try {
      // The database as it was before 0419: every new link ON.
      await c.query("alter table public.customer_portal_access alter column enabled set default true");
      expect(await defaultOfEnabled()).toBe("true");
      const never = await customer("TEST 0419 never used");
      const opened = await customer("TEST 0419 opened");
      const device = await customer("TEST 0419 signed in");
      const coded = await customer("TEST 0419 code asked");
      const officeOnly = await customer("TEST 0419 office look only");
      for (const id of [never, opened, device, coded, officeOnly]) expect((await link(id))?.enabled, id).toBe(true);

      await c.query("update public.customer_portal_access set last_opened_at = now() - interval '1 day' where customer_id = $1", [opened]);
      await c.query(
        `insert into public.customer_portal_sessions (customer_id, org_id, session_hash, kind, expires_at)
         values ($1, $2, ${hex(64)}, 'customer', now() + interval '30 days')`,
        [device, orgId],
      );
      await c.query(
        `insert into public.customer_portal_codes (customer_id, org_id, channel, code_salt, code_hash, expires_at)
         values ($1, $2, 'email', ${hex(32)}, ${hex(64)}, now() + interval '10 minutes')`,
        [coded, orgId],
      );
      await c.query(
        `insert into public.customer_portal_sessions (customer_id, org_id, session_hash, kind, expires_at)
         values ($1, $2, ${hex(64)}, 'office', now() + interval '8 hours')`,
        [officeOnly, orgId],
      );

      await c.query(sql0419);

      for (const id of [never, officeOnly]) {
        const row = await link(id);
        expect(row?.enabled, id).toBe(false);
        expect(row?.disabled_at, id).not.toBeNull();
        expect(row?.disabled_by, id).toBeNull();
      }
      for (const id of [opened, device, coded]) {
        const row = await link(id);
        expect(row?.enabled, id).toBe(true);
        expect(row?.disabled_at, id).toBeNull();
      }
      expect(await defaultOfEnabled()).toBe("false");
    } finally {
      await c.query("rollback to savepoint b");
    }
  });

  it("(c) twice-safe: a never-used link turned on by hand stays on when the file runs again", async () => {
    await c.query("savepoint c");
    try {
      const id = await customer("TEST 0419 Snowbell");
      expect((await link(id))?.enabled).toBe(false);
      await c.query("update public.customer_portal_access set enabled = true, disabled_at = null, disabled_by = null where customer_id = $1", [id]);
      await c.query(sql0419);
      const row = await link(id);
      expect(row?.enabled).toBe(true);
      expect(row?.disabled_at).toBeNull();
      expect(await defaultOfEnabled()).toBe("false");
    } finally {
      await c.query("rollback to savepoint c");
    }
  });

  it("(d) the two stamps exist: nullable timestamptz", async () => {
    const { rows } = await c.query(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'invoices' and column_name = 'resend_dismissed_at')
            or (table_name = 'bills' and column_name = 'duplicate_dismissed_at'))
        order by table_name`,
    );
    expect(rows).toEqual([
      { table_name: "bills", column_name: "duplicate_dismissed_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      { table_name: "invoices", column_name: "resend_dismissed_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
    ]);
  });
});
