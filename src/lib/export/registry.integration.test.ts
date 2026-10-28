import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { COMPANY_TABLE, EXPORT_TABLES } from "@/lib/export/registry";

/**
 * THE EXPORT REGISTRY NAMES REAL COLUMNS (cn-v1138). Every column list in lib/export/registry.ts is
 * run against the test database as the route runs it: `select <columns> from public.<table> where
 * org_id = <no company> limit 0`. A column that is not there, or a table with no org_id, fails with
 * the table's name (Postgres says which column). The order column each read pages by is proved
 * unique within a company: a unique index on (org_id, order) or on (order) alone. Reads only, on
 * a company id that is nobody's; nothing is written.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

/** A company id that is nobody's: the reads must come back empty, and they are limit 0 anyway. */
const NO_ORG = "00000000-0000-0000-0000-000000000000";

d("the export registry names real columns", () => {
  let c: pg.Client;
  let ready = false;

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) return ctx.skip();
      await fn();
    });

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    await c.query("set statement_timeout = '30s'");
    ready = true;
  });

  afterAll(async () => {
    await c?.end();
  });

  /** One read the way the route reads: the registry's columns, the company named, no rows wanted. */
  const tryRead = async (table: string, columns: readonly string[], where: string): Promise<string | null> => {
    try {
      const { rows } = await c.query(`select ${columns.map((x) => `"${x}"`).join(", ")} from public."${table}" where ${where} = $1 limit 0`, [NO_ORG]);
      return rows.length === 0 ? null : `${table}: ${rows.length} rows for nobody's company`;
    } catch (e) {
      return `${table}: ${String((e as Error).message ?? e)}`;
    }
  };

  it("every exported table has every listed column and an org_id", async () => {
    const bad: string[] = [];
    for (const t of EXPORT_TABLES) {
      const problem = await tryRead(t.table, t.columns, "org_id");
      if (problem) bad.push(problem);
    }
    expect(bad).toEqual([]);
    expect(EXPORT_TABLES.length).toBe(87);
  });

  it("the company's row has every listed column, read by id", async () => {
    expect(await tryRead(COMPANY_TABLE.table, COMPANY_TABLE.columns, "id")).toBeNull();
  });

  it("each table's order column is unique within a company (a unique index on it, with or without org_id)", async () => {
    const bad: string[] = [];
    for (const t of EXPORT_TABLES) {
      const { rows } = await c.query(
        `select i.indexrelid::regclass::text as name,
                (select array_agg(a.attname::text order by k.ord)
                   from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as cols
           from pg_index i
           join pg_class r on r.oid = i.indrelid
           join pg_namespace n on n.oid = r.relnamespace
          where n.nspname = 'public' and r.relname = $1 and i.indisunique and i.indpred is null`,
        [t.table],
      );
      const covered = rows.some((r: { cols: string[] | null }) => Array.isArray(r.cols) && r.cols.every((col) => col === "org_id" || col === t.order));
      if (!covered) bad.push(`${t.table}: no unique index on (${t.order}) or (org_id, ${t.order}); found ${rows.map((r: { name: string; cols: string[] }) => `${r.name}(${(r.cols ?? []).join(",")})`).join(", ") || "none"}`);
    }
    expect(bad).toEqual([]);
  });
});
