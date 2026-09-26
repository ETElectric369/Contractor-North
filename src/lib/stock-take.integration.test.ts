import { describe } from "vitest";
import pg from "pg";
import { defineStockTakeSuite } from "./stock-take.db-suite";

/**
 * Took From Stock at the database (0343 + 0344): a piece from the shelf is billed once, an undone or
 * short piece is never billed, un-void can't bring back an undone take, and the crew reads the job's
 * takes with no cost. The suite is stock-take.db-suite.ts, over ONE connection, each case in its own
 * transaction that is always rolled back.
 *
 * OPT-IN, AND ONLY IN A SANDBOX ORG (integration of feat/stock-phase3, the same gate as the bill
 * suite). Creds alone do NOT run it - CI has production creds, and this suite writes fixtures and
 * takes the org's claim lock. It needs STOCK_TAKE_DB=1 and TEST_SANDBOX_ORG (optionally
 * TEST_SANDBOX_ORG_2 for the stranger checks). STOCK_TAKE_APPLY=1 (apply 0343/0344 inside each
 * case's transaction when the database lacks them) is refused outright against the production
 * project: 0343's trigger DDL locks every company's invoices for as long as the case runs.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… STOCK_TAKE_DB=1 TEST_SANDBOX_ORG=<uuid> npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, STOCK_TAKE_DB, TEST_SANDBOX_ORG, TEST_SANDBOX_ORG_2, STOCK_TAKE_APPLY } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER && STOCK_TAKE_DB === "1" && TEST_SANDBOX_ORG ? describe : describe.skip;
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
      return client;
    },
    {
      sandboxOrgId: String(TEST_SANDBOX_ORG ?? ""),
      strangerOrgId: TEST_SANDBOX_ORG_2 ? String(TEST_SANDBOX_ORG_2) : undefined,
      allowDdl: STOCK_TAKE_APPLY === "1" && !isProduction,
    },
  );
});
