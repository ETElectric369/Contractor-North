import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * Migration 0354: any company, any supplier (Wave 0). Pinned against the TEST database, inside ONE
 * transaction that is always rolled back, with throwaway companies minted in it:
 *   · two suppliers may print the same number; one account may not hold it twice;
 *   · a purchase order made with no vendor names none (the column default is '');
 *   · the shelf credit guard names no supplier;
 *   · platform_set_bug_status: a company's owner is refused; a platform admin marks another
 *     company's report, and only the three statuses the app writes.
 *
 * Until 0354 is applied the suite waits, loudly; ANY_COMPANY_APPLY_0354=1 applies it INSIDE the
 * rolled-back transaction, so the database is left exactly as it was.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [ANY_COMPANY_APPLY_0354=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, ANY_COMPANY_APPLY_0354 } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const MIGRATION = fileURLToPath(new URL("../../supabase/migrations/0354_any_company_any_supplier.sql", import.meta.url));

d("0354: any company, any supplier", () => {
  let c: pg.Client;
  let waiting = false;
  let orgA = "";
  let orgB = "";
  let ownerA = "";
  let ownerB = "";
  let acct1 = "";
  let acct2 = "";
  let reportB = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run `fn` under a savepoint: an expected refusal rolls back only itself, never the suite. */
  const tryIt = async (fn: () => Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> => {
    await c.query("savepoint try_it");
    try {
      const value = await fn();
      await c.query("release savepoint try_it");
      return { ok: true, value };
    } catch (e) {
      await c.query("rollback to savepoint try_it");
      await asServer();
      return { ok: false, message: String((e as Error)?.message ?? e) };
    }
  };
  const ready = () =>
    !waiting || notOnThisDatabase("[any-company] 0354 is not on this database yet; set ANY_COMPANY_APPLY_0354=1 to apply it inside the rolled-back transaction.");

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has = await one("select to_regprocedure('public.platform_set_bug_status(uuid, text)') is not null as yes");
    if (!has.yes && ANY_COMPANY_APPLY_0354 !== "1") {
      waiting = true;
      return;
    }
    if (!has.yes) await c.query(readFileSync(MIGRATION, "utf8"));

    const a = await mintThrowawayOrg(c, { label: "0354 A", techs: 0 });
    const b = await mintThrowawayOrg(c, { label: "0354 B", techs: 0 });
    orgA = a.orgId;
    orgB = b.orgId;
    ownerA = a.owner.id;
    ownerB = b.owner.id;
    acct1 = (await one("insert into supplier_accounts (org_id, name) values ($1, 'TEST 0354 Supply One') returning id", [orgA])).id;
    acct2 = (await one("insert into supplier_accounts (org_id, name) values ($1, 'TEST 0354 Supply Two') returning id", [orgA])).id;
    reportB = (
      await one("insert into bug_reports (org_id, reported_by, note, status) values ($1, $2, 'TEST 0354 a report', 'open') returning id", [orgB, ownerB])
    ).id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("two suppliers may print the same number; one account may not hold it twice", async () => {
    if (!ready()) return;
    const paper = (acct: string | null) =>
      c.query(
        `insert into supplier_invoices (org_id, supplier_account_id, invoice_number, kind, invoice_date, total, open_balance, closed)
         values ($1, $2, 'TEST-0354-9019059048', 'invoice', '2001-01-01', 10, 10, false)`,
        [orgA, acct],
      );
    expect((await tryIt(() => paper(acct1))).ok).toBe(true);
    expect((await tryIt(() => paper(acct2))).ok).toBe(true);
    expect((await tryIt(() => paper(null))).ok).toBe(true);
    const again = await tryIt(() => paper(acct1));
    expect(again.ok).toBe(false);
    expect(again.ok ? "" : again.message).toMatch(/duplicate key/);
    // Still one per number among papers on no account.
    expect((await tryIt(() => paper(null))).ok).toBe(false);
  });

  it("a purchase order made with no vendor names none", async () => {
    if (!ready()) return;
    const po = await one("insert into purchase_orders (org_id, status) values ($1, 'draft') returning vendor", [orgA]);
    expect(po.vendor).toBe("");
  });

  it("the shelf credit guard names no supplier", async () => {
    if (!ready()) return;
    const def = (await one("select pg_get_functiondef('public.guard_shelf_credit_bill()'::regprocedure) as def")).def as string;
    expect(def).not.toMatch(/Return To CED/);
    expect(def).toContain("(the return on Shop Stock)");
  });

  it("a company's owner can't mark a report through the platform function", async () => {
    if (!ready()) return;
    const res = await tryIt(async () => {
      await as(ownerA);
      const r = await one("select public.platform_set_bug_status($1, 'fixed') as ok", [reportB]);
      await asServer();
      return r.ok;
    });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.message).toMatch(/Only North's own team/);
    expect((await one("select status from bug_reports where id = $1", [reportB])).status).toBe("open");
  });

  it("a platform admin marks another company's report, with the app's statuses only", async () => {
    if (!ready()) return;
    // Company A's owner is made a platform admin, inside this transaction only.
    await c.query("insert into platform_admins (user_id, note) values ($1, 'TEST 0354, rolled back')", [ownerA]);
    const marked = await tryIt(async () => {
      await as(ownerA);
      const r = await one("select public.platform_set_bug_status($1, 'fixed') as ok", [reportB]);
      await asServer();
      return r.ok;
    });
    expect(marked).toEqual({ ok: true, value: true });
    expect((await one("select status from bug_reports where id = $1", [reportB])).status).toBe("fixed");
    const odd = await tryIt(async () => {
      await as(ownerA);
      await one("select public.platform_set_bug_status($1, 'banana') as ok", [reportB]);
    });
    expect(odd.ok).toBe(false);
    const gone = await tryIt(async () => {
      await as(ownerA);
      const r = await one("select public.platform_set_bug_status(gen_random_uuid(), 'open') as ok");
      await asServer();
      return r.ok;
    });
    expect(gone).toEqual({ ok: true, value: false });
  });
});
