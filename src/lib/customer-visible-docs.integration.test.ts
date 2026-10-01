import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { CUSTOMER_VISIBLE_STATUSES } from "@/lib/customer-visible-docs";

/**
 * WHICH PAPERS A CUSTOMER MAY OPEN, IN THE DATABASE THAT IS ACTUALLY DEPLOYED (W3).
 *
 * src/lib/customer-visible-docs.test.ts pins the app's one list to the migration FILES, with no
 * credentials, so it runs on every push. This is its twin: it reads the catalog, so a function
 * hand-edited in a database — or a migration written but never applied — cannot drift either.
 *
 * The database keeps its own gate because a customer's token reaches these security-definer
 * functions with no app code in front of them. Widen one side alone and the customer gets a Pay or
 * Download button the other side refuses, or a bill whose document can only say "couldn't load".
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

/** The gates, each named with the alias its own body uses for the table it narrows. */
const GATES: { fn: string; alias: string; kind: "invoice" | "quote"; what: string }[] = [
  { fn: "public_invoice", alias: "i", kind: "invoice", what: "the bill behind a customer's /i link" },
  { fn: "customer_portal", alias: "i", kind: "invoice", what: "the bills on the customer's home page" },
  { fn: "portal_job_view", alias: "i", kind: "invoice", what: "the bills on the customer's job page" },
  { fn: "public_quote", alias: "q", kind: "quote", what: "the quote behind a customer's /q link" },
];

d("the deployed customer doors open exactly what the app opens (W3)", () => {
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
        where n.nspname = 'public' and p.proname = any($1::text[])`,
      [GATES.map((g) => g.fn)],
    );
    for (const r of rows) bodies.set(r.proname, (bodies.get(r.proname) ?? "") + "\n" + (r.def ?? ""));
  });
  afterAll(async () => {
    await client?.end();
  });

  for (const g of GATES) {
    it(`${g.fn} narrows by status to the app's list — ${g.what}`, () => {
      const def = bodies.get(g.fn);
      expect(def, `public.${g.fn} is not in this database`).toBeTruthy();
      const want = [...CUSTOMER_VISIBLE_STATUSES[g.kind]].sort();
      const re = new RegExp(`\\b${g.alias}\\.status\\s+in\\s*\\(([^)]*)\\)`, "gi");
      const found = [...def!.matchAll(re)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((w) => w[1]).sort());
      expect(
        found.length,
        `public.${g.fn} no longer narrows ${g.kind}s by status where this test looks — re-point it, do not delete it`,
      ).toBeGreaterThan(0);
      for (const list of found) {
        expect(list, `deployed ${g.fn} vs CUSTOMER_VISIBLE_STATUSES.${g.kind}`).toEqual(want);
      }
    });
  }

  it("a draft or voided bill is in no customer gate at all", () => {
    for (const g of GATES) {
      const def = bodies.get(g.fn) ?? "";
      const re = new RegExp(`\\b${g.alias}\\.status\\s+in\\s*\\(([^)]*)\\)`, "gi");
      for (const m of def.matchAll(re)) {
        expect(m[1], `${g.fn} lets a draft or void through`).not.toMatch(/'(draft|void)'/);
      }
    }
  });
});
