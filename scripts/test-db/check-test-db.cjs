#!/usr/bin/env node
// CI's gate before `npm test`: TEST_DB_* must point at THE TEST DATABASE, never at production.
//
//   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… node scripts/test-db/check-test-db.cjs
//
// The same two checks as src/lib/db-guard.ts (assertTestDatabase), which every DB suite also runs
// right after it connects (tests/db-guard.test.ts pins that these constants match it):
//   (a) the connection's user is the test project's pooler user, and
//   (b) public.cn_test_database_marker holds exactly one row, 'contractor-north-test'.
// Anything else fails the job, in one plain sentence. It reads; it never writes.

"use strict";

const pg = require("pg");

const TEST_DB_USER_NAME = "postgres.olmehzbhtzegjxgswgyk";
const TEST_DB_MARKER = "contractor-north-test";
const SENTENCE = "TEST_DB_* point at a database without the contractor-north-test marker - repoint the GitHub secrets at the test project";

function fail(detail) {
  console.error(`::error::${SENTENCE}`);
  console.error(SENTENCE);
  if (detail) console.error(`  (${detail})`);
  process.exit(1);
}

async function main() {
  const { TEST_DB_HOST, TEST_DB_USER, TEST_DBPW } = process.env;
  const missing = ["TEST_DB_HOST", "TEST_DB_USER", "TEST_DBPW"].filter((k) => !process.env[k]);
  if (missing.length) fail(`missing: ${missing.join(", ")}`);
  if (TEST_DB_USER !== TEST_DB_USER_NAME) fail(`TEST_DB_USER is not the test project's user`);

  const client = new pg.Client({
    host: TEST_DB_HOST,
    port: 5432,
    user: TEST_DB_USER,
    password: TEST_DBPW,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    application_name: "cn-ci-test-db-check",
  });
  try {
    await client.connect();
  } catch (e) {
    fail(`could not connect: ${e.message}`);
  }
  try {
    if (client.user !== TEST_DB_USER_NAME) fail("connected as another user");
    await client.query("begin transaction read only");
    const present = (await client.query("select to_regclass('public.cn_test_database_marker') is not null as ok")).rows[0].ok === true;
    const rows = present ? (await client.query("select value from public.cn_test_database_marker")).rows : [];
    await client.query("rollback");
    if (rows.length !== 1 || rows[0].value !== TEST_DB_MARKER) fail(present ? `the marker holds ${rows.length} row(s)` : "no marker table");
    console.log(`TEST_DB_* point at the test database (${TEST_DB_USER_NAME}, marker '${TEST_DB_MARKER}').`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => fail(e.message));
