import { describe } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { defineOnePlaceAtATimeSuite } from "./one-place-at-a-time.db-suite";

/**
 * Migration 0360 (one person, one place at a time) against the TEST database, inside ONE
 * transaction that is always rolled back. The suite is one-place-at-a-time.db-suite.ts.
 *
 * Same creds gate as the other DB suites; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("one person, one place at a time (0360)", () => {
  defineOnePlaceAtATimeSuite(async () => {
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
