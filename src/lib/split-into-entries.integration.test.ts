import { describe } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { defineSplitIntoEntriesSuite } from "./split-into-entries.db-suite";

/**
 * Migrations 0288 + 0290 + 0313 (a split is a cut into ordinary entries; the old split table
 * dropped, and the guards that stay read time entries only; a void line's claim follows every cut),
 * exercised where the rules live. 0289's one-time
 * conversion cases went with the table. The suite itself is split-into-entries.db-suite.ts;
 * this file points it at the production database, inside ONE transaction that is always rolled back.
 *
 * Same creds gate as rls.integration.test.ts; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("a split is a cut into ordinary entries (0288, 0290, 0313)", () => {
  defineSplitIntoEntriesSuite(async () => {
    const client = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await assertTestDatabase(client);
    return client;
  });
});
