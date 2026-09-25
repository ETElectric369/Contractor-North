import { describe } from "vitest";
import pg from "pg";
import { defineShelfPhase2Suite } from "./shelf-phase2.db-suite";

/**
 * Shop Stock Phase 2 (migration 0328: shelve_bill_lines and stock_recount), exercised where the
 * rules live. The suite is shelf-phase2.db-suite.ts; this file points it at the production database
 * inside ONE transaction that is always rolled back. Same creds gate as the other DB suites; skips
 * cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("putting things on the shelf (0328)", () => {
  defineShelfPhase2Suite(async () => {
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
