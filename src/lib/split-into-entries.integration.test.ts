import { describe } from "vitest";
import pg from "pg";
import { defineSplitIntoEntriesSuite } from "./split-into-entries.db-suite";

/**
 * Migrations 0288 + 0289 (a split is a cut into ordinary entries; the old splits converted and the
 * old table frozen), exercised where the rules live. The suite itself is split-into-entries.db-suite.ts;
 * this file points it at the production database, inside ONE transaction that is always rolled back.
 *
 * Same creds gate as rls.integration.test.ts; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("a split is a cut into ordinary entries (0288, 0289)", () => {
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
    return client;
  });
});
