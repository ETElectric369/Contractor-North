import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

/**
 * Migrations 0339 and 0340 (audit v994 TL1, TL2): a row may only name a PARENT of its own org.
 *
 *   0339  a price_list_item_options row names an item of its own org, so another company can't
 *         crowd an item's one-per-maker / one-default indexes (keyed on item_id alone).
 *   0340  a document, a bill or an organized_items row names a job of its own org (or none).
 *
 * Speaks as an existing staff member of one org (request.jwt.claims under `set local role
 * authenticated`, PostgREST's own mechanism) inside ONE transaction that is always rolled back.
 * Fixtures are named TEST 0339 / TEST 0340 and live only inside that transaction. Before the
 * migrations are applied each case says so on the console and returns: loud, not a green lie.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run src/lib/tenant-parent.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("a row names only its own org's parent (0339, 0340)", () => {
  let c: pg.Client;
  let has0339 = false;
  let has0340 = false;
  let orgId = "";
  let staffId = "";
  let myItem = "";
  let myJob = "";
  let theirItem = "";
  let theirJob = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** The SQLSTATE a statement is refused with, or null when it went through (then undone). */
  const refused = async (sql: string, params: unknown[]): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await c.query(sql, params);
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint attempt");
      return String((e as { code?: string }).code ?? e);
    }
  };
  const needs = (applied: boolean, n: string) => {
    if (!applied) console.warn(`[tenant-parent] migration ${n} is not on this database yet; apply it to exercise this case.`);
    return applied;
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await c.query("begin");
    const pol = async (name: string, needle: string) =>
      !!(await one("select position($2 in coalesce(with_check, '')) > 0 as ok from pg_policies where schemaname = 'public' and policyname = $1", [name, needle]))?.ok;
    has0339 = await pol("price_list_item_options_write", "price_list_items");
    has0340 = (await pol("documents_write", "jobs")) && (await pol("bills_write", "jobs")) && (await pol("organized_items_write", "jobs"));

    const fx = await one(
      `select s.org_id, s.id as staff_id from profiles s
        where s.role in ('owner','admin','office') and coalesce(s.active, true) and s.org_id is not null
        limit 1`,
    );
    if (!fx) throw new Error("0339/0340 fixture: no active staff member to speak as.");
    orgId = fx.org_id;
    staffId = fx.staff_id;

    myItem = (await one("insert into price_list_items (org_id, code, description, unit, buy_price) values ($1, 'TEST-0339', 'TEST 0339 windows', 'ea', 830) returning id", [orgId])).id;
    myJob = (await one("insert into jobs (org_id, job_number, name) values ($1, 'TEST-0340', 'TEST 0340 our job') returning id", [orgId])).id;
    const other = (await one("insert into organizations (name) values ('TEST 0339 other org 2001-01-01') returning id")).id;
    theirItem = (await one("insert into price_list_items (org_id, code, description, unit, buy_price) values ($1, 'TEST-0339', 'TEST 0339 their windows', 'ea', 830) returning id", [other])).id;
    theirJob = (await one("insert into jobs (org_id, job_number, name) values ($1, 'TEST-0340', 'TEST 0340 their job') returning id", [other])).id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("0339: staff add a vendor to their own item, and never to another company's", async () => {
    if (!needs(has0339, "0339")) return;
    await as(staffId);
    expect(await refused("insert into price_list_item_options (item_id, vendor, buy_price) values ($1, 'TEST Andersen', 900)", [myItem])).toBeNull();
    expect(await refused("insert into price_list_item_options (item_id, vendor, buy_price, is_default) values ($1, 'TEST Andersen', 900, true)", [theirItem])).toBe("42501");
    // Nor by moving one of their own rows under the other company's item.
    const mine = await one("insert into price_list_item_options (item_id, vendor, buy_price) values ($1, 'TEST Milgard', 800) returning id", [myItem]);
    expect(await refused("update price_list_item_options set item_id = $1 where id = $2", [theirItem, mine.id])).toBe("42501");
    await asServer();
  });

  it("0340: a bill, a document and a tray row may name our job or none, never theirs", async () => {
    if (!needs(has0340, "0340")) return;
    await as(staffId);
    expect(await refused("insert into bills (supplier, amount, job_id) values ('TEST 0340', 1, $1)", [myJob])).toBeNull();
    expect(await refused("insert into bills (supplier, amount, job_id) values ('TEST 0340', 1, null)", [])).toBeNull();
    expect(await refused("insert into bills (supplier, amount, job_id) values ('TEST 0340', 1, $1)", [theirJob])).toBe("42501");
    expect(await refused("insert into documents (name, job_id) values ('TEST 0340', $1)", [myJob])).toBeNull();
    expect(await refused("insert into documents (name, job_id) values ('TEST 0340', $1)", [theirJob])).toBe("42501");
    expect(await refused("insert into organized_items (job_id, created_by, title) values ($1, $2, 'TEST 0340')", [myJob, staffId])).toBeNull();
    expect(await refused("insert into organized_items (job_id, created_by, title) values ($1, $2, 'TEST 0340')", [theirJob, staffId])).toBe("42501");
    await asServer();
  });
});
