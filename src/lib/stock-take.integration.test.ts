import { describe } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { defineStockTakeSuite } from "./stock-take.db-suite";

/**
 * Took From Stock at the database (0343 + 0344): a piece from the shelf is billed once, an undone or
 * short piece is never billed, un-void can't bring back an undone take, and the crew reads the job's
 * takes with no cost. The suite is stock-take.db-suite.ts, over ONE connection, each case in its own
 * transaction that is always rolled back.
 *
 * OPT-IN, AND ONLY IN ITS OWN THROWAWAY COMPANIES (integration of feat/stock-phase3, the same gate
 * as the bill suite). Creds alone do NOT run it (it writes fixtures and takes an org's claim lock;
 * CI's creds once pointed at production, and db-guard.ts now refuses anything but the test
 * database). It needs STOCK_TAKE_DB=1; each case mints its own TEST
 * org (and a stranger's) inside its transaction and rolls them back (throwaway-org.db-fixture.ts),
 * so no sandbox org has to exist. STOCK_TAKE_APPLY=1 (apply 0343/0344 inside each
 * case's transaction when the database lacks them) is refused outright against the production
 * project: 0343's trigger DDL locks every company's invoices for as long as the case runs.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… STOCK_TAKE_DB=1 npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, STOCK_TAKE_DB, STOCK_TAKE_APPLY } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER && STOCK_TAKE_DB === "1" ? describe : describe.skip;
/** The production project (its pooler user names it). */
const PRODUCTION_REF = "rbpokaozcxqownollqlx";
const isProduction = `${TEST_DB_HOST ?? ""} ${TEST_DB_USER ?? ""}`.includes(PRODUCTION_REF);
if (STOCK_TAKE_APPLY === "1" && isProduction) {
  throw new Error("stock-take: STOCK_TAKE_APPLY=1 is refused on the production database. Apply 0343/0344 there as migrations, in a quiet window.");
}

d("Took From Stock at the database (0343 + 0344)", () => {
  defineStockTakeSuite(
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
      await assertTestDatabase(client);
      return client;
    },
    { allowDdl: STOCK_TAKE_APPLY === "1" && !isProduction },
  );
});
