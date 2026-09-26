#!/usr/bin/env node
// CI's gate before `npm test`: TEST_DB_* must point at THE TEST DATABASE, never at production.
//
//   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… node scripts/test-db/check-test-db.cjs
//
// The same two checks as src/lib/db-guard.ts (assertTestDatabase), which every DB suite also runs
// right after it connects (tests/db-guard.test.ts pins that these constants match it):
//   (a) the connection's user is the test project's pooler user, and
//   (b) public.cn_test_database_marker holds exactly one row, 'contractor-north-test'.
//   (c) the test database is not BEHIND the repo (audit v1018): public.cn_test_migrations records
//       every step of supabase/migrations (and the test-db shims) that rebuild.cjs would apply, with
//       the md5 of the files as they are now. A suite whose migration is missing would otherwise pass
//       having asserted nothing. Each failure names its own way out: a step not applied yet ->
//       node scripts/test-db/rebuild.cjs; a step edited since it was applied -> undo the edit, or
//       rebuild.cjs --reset (which empties the test database and re-applies THIS checkout's steps,
//       dropping any other branch's applied migrations until that branch applies them again).
//   Steps the database holds and this checkout does not (another branch's migration, applied ahead of
//   its merge) never fail the job: they are named as a warning, because a suite asserting a shape
//   they changed can fail until that branch merges (steps.cjs ledgerAhead; rebuild.cjs follows the
//   same rule).
// Anything else fails the job, in one plain sentence. It reads; it never writes.

"use strict";

const pg = require("pg");
const { stepsOnDisk, ledgerBehind, ledgerAhead } = require("./steps.cjs");

const TEST_DB_USER_NAME = "postgres.olmehzbhtzegjxgswgyk";
const TEST_DB_MARKER = "contractor-north-test";
const SENTENCE = "TEST_DB_* point at a database without the contractor-north-test marker - repoint the GitHub secrets at the test project";

const BEHIND = "the test database is behind: run node scripts/test-db/rebuild.cjs";
const CHANGED =
  "a step was edited after the test database applied it, so it will never be re-applied: undo the edit, or run node scripts/test-db/rebuild.cjs --reset (it empties the test database and re-applies this checkout's steps; another branch's applied migrations go with it until that branch applies them again)";
const AHEAD = "the test database holds step(s) this checkout does not (another branch's migration, applied ahead of its merge); a suite asserting a shape they changed can fail until that branch merges";

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
    const hasLedger = (await client.query("select to_regclass('public.cn_test_migrations') is not null as ok")).rows[0].ok === true;
    const ledger = hasLedger ? (await client.query("select name, md5 from public.cn_test_migrations")).rows : [];
    await client.query("rollback");
    if (rows.length !== 1 || rows[0].value !== TEST_DB_MARKER) fail(present ? `the marker holds ${rows.length} row(s)` : "no marker table");
    console.log(`TEST_DB_* point at the test database (${TEST_DB_USER_NAME}, marker '${TEST_DB_MARKER}').`);

    const steps = stepsOnDisk();
    const recorded = new Map(ledger.map((r) => [r.name, r.md5]));
    const ahead = ledgerAhead(steps, recorded);
    if (ahead.length) {
      console.log(`::warning::${AHEAD}: ${ahead.join(", ")}`);
      console.log(AHEAD);
      for (const n of ahead) console.log(`  - ${n}`);
    }
    const { missing, changed } = ledgerBehind(steps, recorded);
    if (missing.length || changed.length) {
      if (missing.length) {
        console.error(`::error::${BEHIND}`);
        console.error(BEHIND);
        for (const n of missing) console.error(`  - not applied: ${n}`);
      }
      if (changed.length) {
        console.error(`::error::${CHANGED}`);
        console.error(CHANGED);
        for (const n of changed) console.error(`  - changed since it was applied: ${n}`);
      }
      process.exit(1);
    }
    console.log(`The test database carries all ${steps.length} step(s) in the repo (${steps.filter((s) => s.kind === "migration").length} migrations).`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => fail(e.message));
