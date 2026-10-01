import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { STAFF_ROLES } from "@/lib/actions/perms";

/**
 * WHO COUNTS AS OFFICE, IN THE DATABASE THAT IS ACTUALLY DEPLOYED (W2).
 *
 * src/lib/office-roles.test.ts pins the app's list to the migration FILES, with no credentials, so
 * it runs on every push. This is its twin: it reads the catalog, so a function hand-edited in a
 * database — or a migration that was written but never applied — cannot drift either.
 *
 * NOT MERGED WITH THE APP, deliberately. is_org_staff() and is_staff() are what RLS calls; a crafted
 * PostgREST request never passes through app code. The database owns the boundary and the app knows
 * enough to hide a door. This test is what keeps the two saying the same thing.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("the deployed staff helpers name exactly the app's office roles (W2)", () => {
  let client: pg.Client;
  const bodies = new Map<string, string>();

  beforeAll(async () => {
    client = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await assertTestDatabase(client);
    const { rows } = await client.query(
      `select p.proname, pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('is_org_staff', 'is_staff')`,
    );
    for (const r of rows) bodies.set(r.proname, r.def ?? "");
  });
  afterAll(async () => {
    await client?.end();
  });

  const want = [...STAFF_ROLES].sort();

  for (const fn of ["is_org_staff", "is_staff"]) {
    it(`${fn}() answers true for exactly ${want.join(", ")}`, () => {
      const def = bodies.get(fn);
      expect(def, `public.${fn}() is not in this database`).toBeTruthy();
      const m = /\brole\s+in\s*\(([^)]*)\)/i.exec(def!);
      expect(m, `public.${fn}() no longer names its roles where this test looks — re-point it, do not delete it`).not.toBeNull();
      const roles = [...m![1].matchAll(/'([^']*)'/g)].map((w) => w[1]).sort();
      expect(roles, `deployed ${fn}() vs STAFF_ROLES in src/lib/actions/perms.ts`).toEqual(want);
    });

    it(`${fn}() still answers false for a deactivated seat (0158)`, () => {
      expect(bodies.get(fn)).toMatch(/coalesce\(active, ?true\)/);
    });
  }

  it("a profile can only hold a role the app has decided about", async () => {
    const { rows } = await client.query(
      `select e.enumlabel as role from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'user_role' order by e.enumsortorder`,
    );
    const stored = rows.map((r: { role: string }) => r.role).sort();
    // src/lib/types UserRole. A role the database can store that the app never listed would slip
    // past OFFICE_BY_ROLE's exhaustiveness check, because the compiler never sees it.
    expect(stored).toEqual(["admin", "office", "owner", "tech"]);
    for (const r of STAFF_ROLES) expect(stored, `STAFF_ROLES names ${r}, which no profile can hold`).toContain(r);
  });
});
