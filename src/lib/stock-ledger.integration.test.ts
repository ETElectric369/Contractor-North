import { describe } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { defineStockLedgerSuite } from "./stock-ledger.db-suite";

/**
 * Migrations 0302-0304 (the shop shelf: techs see no prices, the ledger, and used stock stays put),
 * exercised where the rules live. The suite itself is stock-ledger.db-suite.ts; this file points it
 * at the production database inside ONE transaction that is always rolled back. When the
 * migrations are not applied yet, the suite applies them inside that same transaction.
 *
 * Same creds gate as rls.integration.test.ts; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("the shop shelf is a ledger (0302, 0303, 0304)", () => {
  defineStockLedgerSuite(async () => {
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
