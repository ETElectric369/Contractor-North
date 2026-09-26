import { describe } from "vitest";
import pg from "pg";
import { defineStockBillSuite } from "./stock-bill.db-suite";

/**
 * Migration 0343 and the stock importer's plan (Shop Stock, Phase 3), exercised where the rules
 * live. The suite is stock-bill.db-suite.ts; this file points it at a database inside ONE
 * transaction that is always rolled back.
 *
 * OPT-IN, AND ONLY IN ITS OWN THROWAWAY COMPANY (review of this branch). Creds alone do not run it:
 * it needs STOCK_BILL_DB=1. It mints a TEST org with an owner and a tech inside its one transaction
 * and rolls it back (throwaway-org.db-fixture.ts); the live companies are refused by id and no
 * sandbox org has to exist. STOCK_BILL_APPLY=1 (apply 0343 inside the test transaction when the database
 * lacks it) is refused outright against the production project: DDL there locks every company's
 * invoices for as long as the test runs.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… STOCK_BILL_DB=1 npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, STOCK_BILL_DB, STOCK_BILL_APPLY } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER && STOCK_BILL_DB === "1" ? describe : describe.skip;
/** The production project (its pooler user names it). */
const PRODUCTION_REF = "rbpokaozcxqownollqlx";
const isProduction = `${TEST_DB_HOST ?? ""} ${TEST_DB_USER ?? ""}`.includes(PRODUCTION_REF);
if (STOCK_BILL_APPLY === "1" && isProduction) {
  throw new Error("stock-bill: STOCK_BILL_APPLY=1 is refused on the production database. Apply 0343 there as a migration, in a quiet window.");
}

d("a piece from the shelf is billed once (0343)", () => {
  defineStockBillSuite(
    async () => {
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
    },
    { allowDdl: STOCK_BILL_APPLY === "1" && !isProduction },
  );
});
