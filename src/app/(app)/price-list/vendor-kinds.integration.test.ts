import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";

/**
 * Migration 0341: a vendor has a kind (vendor import, Phase 1).
 *
 * price_list_vendors gains kind (brand / supplier / subcontractor, NULL = Not Sorted), trade,
 * is_person and import_batch, and (Look Up, Phase 2) source_url, maps_url and looked_up_at. Pinned
 * here, against the real database, inside ONE transaction that is always rolled back:
 *   · every card made before 0341 is backfilled to 'brand' (today's prices behave as before), and a
 *     re-run never touches a card a person left Not Sorted;
 *   · the kind is a whitelist and the trade is short, in the database as well as the app, and a
 *     looked-up source or map link is an http(s) address of at most 500 characters;
 *   · an insert leaves updated_at = created_at and an edit moves updated_at: the fact Undo relies on
 *     to archive only the cards nobody has touched since the import;
 *   · 0296's boundary is unchanged: staff write, a tech can't, and another company can't read,
 *     insert into, or undo this company's import.
 *
 * Speaks as an existing staff member and tech of one org by planting request.jwt.claims under
 * `set local role authenticated`. Fixtures are named TEST 0341 and dated 2001-01-01.
 *
 * 0341 is not applied until it merges. Until then the suite waits, loudly; VENDOR_APPLY_0341=1
 * applies it INSIDE the test's own transaction (lock_timeout 3s, statement_timeout 15s), which is
 * rolled back, so the database is left exactly as it was.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [VENDOR_APPLY_0341=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, VENDOR_APPLY_0341 } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const MIGRATION = fileURLToPath(new URL("../../../../supabase/migrations/0341_a_vendor_has_a_kind.sql", import.meta.url));
const BATCH = "0341aaaa-0000-4000-8000-000000000001";

d("0341: a vendor has a kind, and Undo can tell an untouched import from an edited one", () => {
  let c: pg.Client;
  let waiting = false;
  let appliedHere = false;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherOrgId = "";
  let otherStaffId = "";
  let oldCardId = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
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
  const ready = () => {
    if (waiting) console.warn("[vendor-kinds] 0341 is not on this database yet; set VENDOR_APPLY_0341=1 to apply it inside the rolled-back transaction.");
    return !waiting;
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    // Asked before any DDL: is 0341 already on this database?
    const has = await one(
      "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='price_list_vendors' and column_name='kind') as yes",
    );
    if (!has.yes && VENDOR_APPLY_0341 !== "1") {
      waiting = true;
      return;
    }

    // A TEST company (owner + tech) and a stranger company, minted here and rolled back (never a live one).
    const fx = await mintOrgAndStranger(c, "0341");
    ({ orgId, techId, staffId } = fx);
    ({ otherOrgId, otherStaffId } = fx);

    if (!has.yes) {
      // A card made BEFORE 0341, to prove the backfill.
      oldCardId = (await one("insert into price_list_vendors (org_id, name) values ($1, 'TEST 0341 Old Brand 2001-01-01') returning id", [orgId])).id;
      await c.query(readFileSync(MIGRATION, "utf8"));
      appliedHere = true;
      console.warn("[vendor-kinds] 0341 applied inside the test's own transaction, which is rolled back.");
    }
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("backfills every card made before it to 'brand'", async () => {
    if (!ready()) return;
    if (!appliedHere) return console.warn("[vendor-kinds] 0341 was already applied; the backfill ran when it was.");
    const row = await one("select kind, trade, is_person, import_batch from price_list_vendors where id = $1", [oldCardId]);
    expect(row).toEqual({ kind: "brand", trade: null, is_person: false, import_batch: null });
  });

  it("a re-run changes nothing: a card left Not Sorted stays Not Sorted", async () => {
    if (!ready()) return;
    // Only where this test applied it: never DDL against a database that already has 0341.
    if (!appliedHere) return console.warn("[vendor-kinds] 0341 was already applied; the re-run case needs VENDOR_APPLY_0341 on a database without it.");
    const id = (await one("insert into price_list_vendors (org_id, name, kind) values ($1, 'TEST 0341 Not Sorted', null) returning id", [orgId])).id;
    await c.query(readFileSync(MIGRATION, "utf8"));
    expect((await one("select kind from price_list_vendors where id = $1", [id])).kind).toBeNull();
  });

  it("staff add a subcontractor with its trade and batch; the insert leaves updated_at = created_at", async () => {
    if (!ready()) return;
    await as(staffId);
    const row = await one(
      `insert into price_list_vendors (name, kind, trade, is_person, import_batch)
       values ('TEST 0341 Alpha Plumbing', 'subcontractor', 'Plumbing', false, $1)
       returning org_id, kind, trade, (updated_at = created_at) as untouched`,
      [BATCH],
    );
    await asServer();
    expect(row).toEqual({ org_id: orgId, kind: "subcontractor", trade: "Plumbing", untouched: true });
  });

  it("the kind is a whitelist and the trade is short, in the database too", async () => {
    if (!ready()) return;
    await as(staffId);
    expect(await refused("insert into price_list_vendors (name, kind) values ('TEST 0341 Bad Kind', 'vendor')", [])).toBe("23514");
    expect(await refused("insert into price_list_vendors (name, trade) values ('TEST 0341 Long Trade', $1)", ["x".repeat(61)])).toBe("23514");
    expect(await refused("insert into price_list_vendors (name, trade) values ('TEST 0341 Blank Trade', '  ')", [])).toBe("23514");
    expect(await refused("insert into price_list_vendors (name, kind) values ('TEST 0341 Supplier', 'supplier')", [])).toBeNull();
    await asServer();
  });

  it("Look Up's columns: a source and a map link are web addresses only, and when it was taken is a time", async () => {
    if (!ready()) return;
    await as(staffId);
    const bad = (col: string, v: string) => refused(`insert into price_list_vendors (name, ${col}) values ('TEST 0341 Bad Link', $1)`, [v]);
    for (const col of ["source_url", "maps_url"]) {
      expect(await bad(col, "javascript:alert(1)")).toBe("23514");
      expect(await bad(col, "https://has a space.example")).toBe("23514");
      expect(await bad(col, `https://x.example/${"a".repeat(490)}`)).toBe("23514");
      expect(await bad(col, "granitepeak.example")).toBe("23514");
    }
    const row = await one(
      `insert into price_list_vendors (name, kind, phone, source_url, maps_url, looked_up_at)
       values ('TEST 0341 Looked Up', 'subcontractor', '(530) 555-0142', 'https://granitepeak.example/contact',
               'https://www.google.com/maps/search/?api=1&query=Granite', now())
       returning org_id, source_url, (looked_up_at is not null) as stamped`,
    );
    expect(row).toEqual({ org_id: orgId, source_url: "https://granitepeak.example/contact", stamped: true });
    await asServer();
    // Another company can't see it.
    await as(otherStaffId);
    expect((await c.query("select source_url from price_list_vendors where name = 'TEST 0341 Looked Up'")).rowCount).toBe(0);
    await asServer();
  });

  it("Undo's rule, as the server action runs it: only the batch's untouched cards are archived", async () => {
    if (!ready()) return;
    // Two cards from the batch, stamped in the past as if imported yesterday; then one is edited.
    const mk = async (name: string) =>
      (
        await one(
          `insert into price_list_vendors (org_id, name, kind, import_batch, created_at, updated_at)
           values ($1, $2, 'subcontractor', $3, '2001-01-01', '2001-01-01') returning id`,
          [orgId, name, BATCH],
        )
      ).id;
    const untouchedId = await mk("TEST 0341 Beta Drywall");
    const editedId = await mk("TEST 0341 Gamma Roofing");
    await as(staffId);
    const edit = await c.query("update price_list_vendors set phone = '5305550100' where id = $1 returning (updated_at = created_at) as untouched", [editedId]);
    expect(edit.rows[0].untouched).toBe(false);
    const undone = await c.query(
      `update price_list_vendors set archived = true
        where org_id = $1 and import_batch = $2 and updated_at = created_at and id = any($3::uuid[])
        returning id`,
      [orgId, BATCH, [untouchedId, editedId]],
    );
    await asServer();
    expect(undone.rows.map((r) => r.id)).toEqual([untouchedId]);
  });

  it("a tech can't add a card or sort one (0296's boundary, unchanged)", async () => {
    if (!ready()) return;
    await as(techId);
    const ins = await refused("insert into price_list_vendors (name, kind) values ('TEST 0341 Tech Try', 'supplier')", []);
    expect(ins).toBe("42501");
    const upd = await c.query("update price_list_vendors set kind = 'brand' where import_batch = $1 returning id", [BATCH]);
    expect(upd.rowCount).toBe(0);
    await asServer();
  });

  it("another company can't read this import, add into it, or undo it", async () => {
    if (!ready()) return;
    await as(otherStaffId);
    const seen = await c.query("select id, kind, trade, import_batch from price_list_vendors where import_batch = $1", [BATCH]);
    expect(seen.rowCount).toBe(0);
    const undo = await c.query("update price_list_vendors set archived = true where import_batch = $1 returning id", [BATCH]);
    expect(undo.rowCount).toBe(0);
    // Writing a row INTO this company is refused by the policy; a row with no org is stamped with the writer's own.
    expect(await refused("insert into price_list_vendors (org_id, name, kind) values ($1, 'TEST 0341 Cross Org', 'brand')", [orgId])).toBe("42501");
    const mine = await one("insert into price_list_vendors (name, kind, import_batch) values ('TEST 0341 Own Org', 'brand', $1) returning org_id", [BATCH]);
    expect(mine.org_id).toBe(otherOrgId);
    await asServer();
    // And this company's staff can't undo the other company's card that shares the batch id.
    await as(staffId);
    const cross = await c.query("update price_list_vendors set archived = true where import_batch = $1 and name = 'TEST 0341 Own Org' returning id", [BATCH]);
    expect(cross.rowCount).toBe(0);
    await asServer();
  });

  it("Undo's index is there, and 0296's one-per-name index is unchanged", async () => {
    if (!ready()) return;
    const idx = await c.query("select indexname, indexdef from pg_indexes where tablename = 'price_list_vendors' order by indexname");
    const byName = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.price_list_vendors_import_batch).toMatch(/\(org_id, import_batch\) WHERE \(import_batch IS NOT NULL\)/);
    expect(byName.price_list_vendors_one_per_name).toMatch(/\(org_id, lower\(btrim\(name\)\)\)/);
    const policies = await c.query("select polname from pg_policy where polrelid = 'public.price_list_vendors'::regclass order by polname");
    expect(policies.rows.map((r) => r.polname)).toEqual(["price_list_vendors_insert", "price_list_vendors_read", "price_list_vendors_update"]);
  });
});
