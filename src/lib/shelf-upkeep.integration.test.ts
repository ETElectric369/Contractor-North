import { describe } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { defineShelfUpkeepSuite } from "./shelf-upkeep.db-suite";

/**
 * Shelf upkeep at the database (0350): a write-off and a return to CED keep every roll adding up to
 * what was paid, a return's credit is the shelf's and never a customer's, only the office writes
 * them, and what an accountant download carried can't be undone. The suite is
 * shelf-upkeep.db-suite.ts, over ONE connection, each case in its own transaction that is always
 * rolled back, in throwaway companies of its own. The TEST database only:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("shelf upkeep and the accountant's record (0350)", () => {
  defineShelfUpkeepSuite(async () => {
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
