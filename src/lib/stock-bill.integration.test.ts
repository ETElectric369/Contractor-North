import { describe } from "vitest";
import pg from "pg";
import { defineStockBillSuite } from "./stock-bill.db-suite";

/**
 * Migration 0343 and the stock importer's plan (Shop Stock, Phase 3), exercised where the rules
 * live. The suite is stock-bill.db-suite.ts; this file points it at the production database inside
 * ONE transaction that is always rolled back. When 0343 is not applied yet the case says so and
 * returns, unless STOCK_BILL_APPLY=1 (it then applies 0343 inside that same transaction, after the
 * fixtures, and rolls it back with everything else).
 *
 * Same creds gate as rls.integration.test.ts; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("a piece from the shelf is billed once (0343)", () => {
  defineStockBillSuite(async () => {
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
