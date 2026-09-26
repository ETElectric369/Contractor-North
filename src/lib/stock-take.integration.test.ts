import { describe } from "vitest";
import pg from "pg";
import { defineStockTakeSuite } from "./stock-take.db-suite";

/**
 * Migration 0344 and Took From Stock at the database: a piece from the shelf is billed once, an
 * undone or short piece is never billed, un-void can't bring back an undone take, and the crew reads
 * the job's takes with no cost. The suite is stock-take.db-suite.ts; this file points it at the
 * production database over ONE connection, each case in its own transaction that is always rolled
 * back (0344 applied inside it when the database doesn't have it yet).
 *
 * Same creds gate as rls.integration.test.ts; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("Took From Stock at the database (0344)", () => {
  defineStockTakeSuite(async () => {
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
