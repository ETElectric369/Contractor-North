import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";

/**
 * Migration 0296: a vendor is a brand, and a brand has a phone number.
 *
 * price_list_vendors holds one card per vendor name per org. The org reads its cards, staff write
 * them, nobody deletes them (archive), and another org's cards are invisible and untouchable: the
 * tenant line is in the policy on every verb (the 0173 law), never in a read path. 0296 also
 * widens price_list_item_options.markup_pct to six decimals so a typed sell lands on its cents.
 *
 * Also pinned here, because the vendor sheets' Archive and Undo lean on it: 0282's one-default
 * index ignores archived rows, so a default can be archived, another made default, and the first
 * brought back only as an alternative (restoreVendor steps it down first).
 *
 * Speaks as an existing staff member and an existing tech of one org by planting
 * request.jwt.claims under `set local role authenticated` (PostgREST's own mechanism), inside ONE
 * transaction that is always rolled back. Its fixtures are named TEST 0296 and dated 2001-01-01.
 * Before 0296 is applied, each 0296 case says so on the console and returns: loud, not a green lie.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("vendor cards: one per name, org reads, staff writes, never another org's (0296)", () => {
  let c: pg.Client;
  let has0296 = false;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherOrgId = "";
  let otherCardId = "";
  let itemId = "";

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
  const needs = () => {
    return has0296 || notOnThisDatabase("[vendor-cards] migration 0296 is not on this database yet; apply it to exercise this case.");
  };

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    await assertTestDatabase(c);
    await c.query("begin");
    has0296 = !!(await one("select to_regclass('public.price_list_vendors') is not null as ok"))?.ok;

    // A TEST company (owner + tech) and a stranger company, minted here and rolled back (never a live one).
    const fx = await mintOrgAndStranger(c, "0296");
    orgId = fx.orgId;
    techId = fx.techId;
    staffId = fx.staffId;

    const item = await one(
      `insert into price_list_items (org_id, code, description, unit, buy_price, markup_pct)
       values ($1, 'TEST-0296', 'TEST 0296 windows 2001-01-01', 'ea', 830, 0) returning id`,
      [orgId],
    );
    itemId = item.id;

    const other = await one("insert into organizations (name) values ('TEST 0296 other org 2001-01-01') returning id");
    otherOrgId = other.id;
    if (has0296) {
      const oc = await one("insert into price_list_vendors (org_id, name, phone) values ($1, 'TEST 0296 Andersen', '5305550100') returning id", [
        otherOrgId,
      ]);
      otherCardId = oc.id;
    }
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("staff add a card; the org is stamped by the trigger, not by the caller", async () => {
    if (!needs()) return;
    await as(staffId);
    const row = await one("insert into price_list_vendors (name, phone) values ('TEST 0296 Andersen', '(530) 555-0199') returning org_id, name, archived");
    expect(row.org_id).toBe(orgId);
    expect(row.archived).toBe(false);
    await asServer();
  });

  it("one card per name: a second spelling of the same name is refused", async () => {
    if (!needs()) return;
    await as(staffId);
    await c.query("insert into price_list_vendors (name) values ('TEST 0296 Milgard')");
    expect(await refused("insert into price_list_vendors (name) values ('  test 0296 MILGARD ')", [])).toBe("23505");
    await asServer();
  });

  it("the same name in ANOTHER org is its own card (the index is per org)", async () => {
    if (!needs()) return;
    await as(staffId);
    // The other org already has 'TEST 0296 Andersen'; this org's own insert above did not collide.
    const mine = await one("select count(*)::int as n from price_list_vendors where name = 'TEST 0296 Andersen'");
    expect(mine.n).toBe(1); // only this org's, and it can't see the other one
    await asServer();
  });

  it("a tech reads the org's cards but can't add, change or delete one", async () => {
    if (!needs()) return;
    await as(staffId);
    const card = await one("insert into price_list_vendors (name) values ('TEST 0296 Marvin') returning id");
    await as(techId);
    const seen = await one("select count(*)::int as n from price_list_vendors where id = $1", [card.id]);
    expect(seen.n).toBe(1);
    expect(await refused("insert into price_list_vendors (name) values ('TEST 0296 Pella')", [])).toBe("42501");
    const upd = await c.query("update price_list_vendors set phone = '1' where id = $1 returning id", [card.id]);
    expect(upd.rowCount).toBe(0);
    const del = await c.query("delete from price_list_vendors where id = $1 returning id", [card.id]);
    expect(del.rowCount).toBe(0);
    await asServer();
  });

  it("nobody deletes a card through the API, staff included: archive is the verb", async () => {
    if (!needs()) return;
    await as(staffId);
    const card = await one("insert into price_list_vendors (name) values ('TEST 0296 Jeld-Wen') returning id");
    const del = await c.query("delete from price_list_vendors where id = $1 returning id", [card.id]);
    expect(del.rowCount).toBe(0);
    const arch = await c.query("update price_list_vendors set archived = true where id = $1 returning id", [card.id]);
    expect(arch.rowCount).toBe(1);
    await asServer();
  });

  it("another org's card is invisible and untouchable, and staff can't write into another org", async () => {
    if (!needs()) return;
    await as(staffId);
    const seen = await one("select count(*)::int as n from price_list_vendors where id = $1", [otherCardId]);
    expect(seen.n).toBe(0);
    const upd = await c.query("update price_list_vendors set phone = '0' where id = $1 returning id", [otherCardId]);
    expect(upd.rowCount).toBe(0);
    expect(await refused("insert into price_list_vendors (org_id, name) values ($1, 'TEST 0296 planted')", [otherOrgId])).toBe("42501");
    // Moving one of our own cards into the other org is refused by the update's WITH CHECK.
    const mine = await one("insert into price_list_vendors (name) values ('TEST 0296 Kolbe') returning id");
    expect(await refused("update price_list_vendors set org_id = $1 where id = $2", [otherOrgId, mine.id])).toBe("42501");
    await asServer();
    const still = await one("select phone from price_list_vendors where id = $1", [otherCardId]);
    expect(still.phone).toBe("5305550100");
  });

  it("a vendor's markup holds six decimals, so a typed sell comes back to the cent", async () => {
    if (!needs()) return;
    await as(staffId);
    const o = await one(
      `insert into price_list_item_options (item_id, vendor, buy_price, markup_pct)
       values ($1, 'TEST 0296 Six', 12000, 2.880583) returning markup_pct::text as m`,
      [itemId],
    );
    expect(o.m).toBe("2.880583");
    await asServer();
  });

  it("0282: an archived default gives up the seat, and can't come back as a second default", async () => {
    await as(staffId);
    const a = await one(
      "insert into price_list_item_options (item_id, vendor, buy_price, is_default) values ($1, 'TEST 0282 A', 1200, true) returning id",
      [itemId],
    );
    const b = await one("insert into price_list_item_options (item_id, vendor, buy_price) values ($1, 'TEST 0282 B', 950) returning id", [itemId]);
    // Archive the default (archiveVendor), then make another the default: allowed.
    expect((await c.query("update price_list_item_options set archived = true where id = $1 returning id", [a.id])).rowCount).toBe(1);
    expect((await c.query("update price_list_item_options set is_default = true where id = $1 returning id", [b.id])).rowCount).toBe(1);
    // Bringing A back as it was would be two defaults: the index refuses...
    expect(await refused("update price_list_item_options set archived = false where id = $1", [a.id])).toBe("23505");
    // ...so restoreVendor steps it down first, and then it comes back as an alternative.
    await c.query("update price_list_item_options set is_default = false where id = $1", [a.id]);
    expect((await c.query("update price_list_item_options set archived = false where id = $1 returning id", [a.id])).rowCount).toBe(1);
    const defaults = await one("select count(*)::int as n from price_list_item_options where item_id = $1 and is_default and not archived", [itemId]);
    expect(defaults.n).toBe(1);
    await asServer();
  });
});
