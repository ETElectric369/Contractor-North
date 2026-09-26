import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { groupInvoiceLines } from "@/lib/invoice-math";

/**
 * Migration 0342: a line says what it is (Erik, INV-079: "Other instead of materials in invoice").
 *
 * Pinned against the real database, inside ONE transaction that is always rolled back:
 *   · invoice_items.line_kind takes labor / materials / other / credit or null, nothing else;
 *   · the backfill filed INV-079's three price-book lines and INV-056's two estimate copies that
 *     name their code in brackets ("... [P116OW]") (and only price-book lines, never an
 *     imported line or one billed in hours) under Materials, and changed no words, amount, unit,
 *     order or edited flag; a re-run files nothing more;
 *   · the /i document (public_invoice through invoice_document_projection) and the portal job page
 *     (portal_job_view) carry line_kind on every line, and INV-079's document groups as
 *     Labor $531.25 / Materials $25.50 with nothing under Other;
 *   · setting a kind on an imported line never marks it edited, so new hours still join it.
 *
 * Fixtures: none are inserted. It reads ET Electric's INV-079 as production holds it and one
 * enabled portal link, all inside the rolled-back transaction.
 *
 * 0342 is not applied until it merges. Until then the suite waits, loudly; LINEKIND_APPLY_0342=1
 * applies it INSIDE the test's own transaction (lock_timeout 3s, statement_timeout 15s), which is
 * rolled back, so the database is left exactly as it was.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [LINEKIND_APPLY_0342=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, LINEKIND_APPLY_0342 } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const MIGRATION = fileURLToPath(new URL("../../supabase/migrations/0342_a_line_says_what_it_is.sql", import.meta.url));
const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";

d("0342: a line says what it is, and every customer document reads it", () => {
  let c: pg.Client;
  let waiting = false;
  let inv079 = "";
  let before: { id: string; description: string; quantity: string; unit: string; unit_price: string; line_total: string; sort_order: number; edited: boolean }[] = [];
  const notices: string[] = [];

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
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
    if (waiting) console.warn("[line-kind] 0342 is not on this database yet; set LINEKIND_APPLY_0342=1 to apply it inside the rolled-back transaction.");
    return !waiting;
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    c.on("notice", (n) => notices.push(String(n.message)));
    await c.connect();
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const inv = await one("select id from invoices where org_id = $1 and invoice_number = 'INV-079'", [ET]);
    if (!inv) throw new Error("0342 fixture: ET Electric's INV-079 is not on this database.");
    inv079 = inv.id;
    before = (
      await c.query(
        "select id, description, quantity::text, unit, unit_price::text, line_total::text, sort_order, edited from invoice_items where invoice_id = $1 and org_id = $2 order by sort_order, id",
        [inv079, ET],
      )
    ).rows;
    const has = await one(
      "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='invoice_items' and column_name='line_kind') as yes",
    );
    if (!has.yes && LINEKIND_APPLY_0342 !== "1") {
      waiting = true;
      return;
    }
    if (!has.yes) {
      await c.query(readFileSync(MIGRATION, "utf8"));
      console.warn("[line-kind] 0342 applied inside the test's own transaction, which is rolled back.");
    }
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the column takes the four kinds or null, and nothing else", async () => {
    if (!ready()) return;
    const anyLine = before[0].id;
    for (const k of ["labor", "materials", "other", "credit", null]) {
      expect(await refused("update invoice_items set line_kind = $1 where id = $2 and org_id = $3", [k, anyLine, ET])).toBeNull();
    }
    expect(await refused("update invoice_items set line_kind = 'Materials' where id = $1 and org_id = $2", [anyLine, ET])).toBe("23514");
    expect(await refused("update invoice_items set line_kind = 'bogus' where id = $1 and org_id = $2", [anyLine, ET])).toBe("23514");
  });

  it("INV-079: the three price-book lines are Materials, the labor import is untouched, nothing else moved", async () => {
    if (!ready()) return;
    const now = (
      await c.query(
        "select id, description, quantity::text, unit, unit_price::text, line_total::text, sort_order, edited, import_source, line_kind from invoice_items where invoice_id = $1 and org_id = $2 order by sort_order, id",
        [inv079, ET],
      )
    ).rows;
    expect(now.map((r) => [r.description, r.import_source, r.line_kind])).toEqual([
      ["Labor - Erik Taylor", "labor", null],
      ["1597TRW — 15A 125V GFCI RCPT", null, "materials"],
      ["TM870LA — S5A 125V 1P SWITCH", null, "materials"],
      ["3232TRI — 15A 125V DPLX RCPT", null, "materials"],
    ]);
    // Classification only: every other column of every line reads as it did before.
    expect(now.map(({ import_source: _s, line_kind: _k, ...rest }) => rest)).toEqual(before);
  });

  it("INV-056: the two lines copied from an estimate with a bracketed [CODE] are Materials (Erik: 'price list items I added from stock')", async () => {
    if (!ready()) return;
    const rows = (
      await c.query(
        `select it.description, it.line_total::text as line_total, it.import_source, it.line_kind
           from invoice_items it join invoices i on i.id = it.invoice_id and i.org_id = it.org_id
          where i.org_id = $1 and i.invoice_number = 'INV-056'
            and (it.description like '%[P116OW]%' or it.description like '%[885TRW]%')
          order by it.sort_order, it.id`,
        [ET],
      )
    ).rows;
    if (!rows.length) {
      console.warn("[line-kind] INV-056's bracketed lines are not on this database; skipped.");
      return;
    }
    expect(rows.map((r) => [r.import_source, r.line_kind])).toEqual(rows.map(() => [null, "materials"]));
    // The first apply's per-org count, for the record (ET Electric only: no other org's book names a supplier).
    console.warn("[line-kind] 0342 notices:", notices.filter((n) => n.startsWith("0342:")).join(" | "));
  });

  it("the backfill filed only unimported, non-hourly lines whose code is in the same org's book and names a supplier; a re-run files nothing", async () => {
    if (!ready()) return;
    const wrong = await one(
      `select count(*)::int as n
         from invoice_items it
        where it.line_kind = 'materials'
          and (it.import_source is not null
               or lower(btrim(coalesce(it.unit, ''))) ~ '^(hr|hrs|hour|hours|man-?hours?)$'
               or not exists (select 1 from price_list_items p
                               where p.org_id = it.org_id
                                 and nullif(btrim(p.supplier), '') is not null
                                 and (lower(btrim(p.code)) = lower(btrim(split_part(it.description, ' — ', 1)))
                                      or exists (select 1
                                                   from regexp_matches(coalesce(it.description, ''), '\\[([^\\]]+)\\]', 'g') as m(t)
                                                  where lower(btrim(p.code)) in (lower(btrim(m.t[1])),
                                                                                 lower((regexp_match(btrim(m.t[1]), '(\\S+)$'))[1]))))))`,
    );
    expect(wrong.n).toBe(0);
    notices.length = 0;
    await c.query(readFileSync(MIGRATION, "utf8"));
    expect(notices).toContain("0342: 0 line(s) in all");
  });

  it("the /i document carries line_kind on every line, and INV-079 groups Labor $531.25 / Materials $25.50", async () => {
    if (!ready()) return;
    const doc = (await one("select public.invoice_document_projection($1) as j", [inv079])).j;
    expect(doc.items.every((it: object) => "line_kind" in it)).toBe(true);
    const g = groupInvoiceLines(doc.items);
    expect(g.labor.subtotal).toBe(531.25);
    expect(g.materials.subtotal).toBe(25.5);
    expect(g.other.lines).toHaveLength(0);
    // public_invoice is the same projection behind the customer's token (sent bills only).
    const tok = await one("select public_token from invoices where id = $1 and org_id = $2", [inv079, ET]);
    if (tok?.public_token) {
      const pub = (await one("select public.public_invoice($1) as j", [tok.public_token])).j;
      expect(pub.items.map((it: { line_kind: string | null }) => it.line_kind)).toEqual(doc.items.map((it: { line_kind: string | null }) => it.line_kind));
    }
  });

  it("the portal job page carries line_kind on its lines and on each bill's document", async () => {
    if (!ready()) return;
    const link = await one(
      `select a.token, jb.id as job_id
         from customer_portal_access a
         join jobs jb on jb.customer_id = a.customer_id and jb.org_id = a.org_id
         join invoices i on i.job_id = jb.id and i.org_id = a.org_id and i.customer_id = a.customer_id and i.status <> 'void'
        where a.enabled
          and jb.status in ('to_be_scheduled', 'scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced')
        limit 1`,
    );
    if (!link) {
      console.warn("[line-kind] no enabled portal link with a bill on this database; the portal check is skipped.");
      return;
    }
    const page = (await one("select public.portal_job_view($1, $2) as j", [link.token, link.job_id])).j;
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.lines.every((l: object) => "line_kind" in l)).toBe(true);
    for (const inv of page.invoices) expect(inv.doc.items.every((it: object) => "line_kind" in it)).toBe(true);
  });

  it("a kind set on an imported labor line never marks it edited (new hours still join it)", async () => {
    if (!ready()) return;
    const labor = await one("select id, edited from invoice_items where invoice_id = $1 and org_id = $2 and import_source = 'labor' limit 1", [inv079, ET]);
    await c.query("update invoice_items set line_kind = 'labor' where id = $1 and org_id = $2", [labor.id, ET]);
    const after = await one("select edited, line_kind from invoice_items where id = $1 and org_id = $2", [labor.id, ET]);
    expect(after).toEqual({ edited: labor.edited, line_kind: "labor" });
  });
});
