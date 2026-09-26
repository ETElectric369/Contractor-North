#!/usr/bin/env node
// Rebuilds THE TEST DATABASE from supabase/migrations, in filename order.
//
//   node scripts/test-db/rebuild.cjs
//
// It writes to one database only: the Contractor North test project. The host and the user are
// constants in this file, not environment variables, so no env mix-up can point it at production.
// The password is the only thing it reads from outside: CN_TEST_DB_PW if set, else a textutil read
// of ~/Developer/db/CN_test_db.rtf. It never prints the password.
//
// SAFETY (it refuses, loudly, unless both hold):
//   (a) it connects as the test project's user (postgres.olmehzbhtzegjxgswgyk), and
//   (b) public.cn_test_database_marker holds exactly one row saying 'contractor-north-test'.
//       The marker is created ONLY when the public schema is completely empty (a brand-new
//       project). A database with objects in public and no marker is refused, full stop.
//
// ORDER, each step in its own transaction and recorded in public.cn_test_migrations (resumable:
// a recorded name is skipped on the next run):
//   1. supabase/test-db/bootstrap.sql          recorded as 'test-db/bootstrap.sql'
//   2. for each supabase/migrations/NNNN_*.sql:
//        supabase/test-db/before/NNNN.sql, if it exists, in the SAME transaction, right before it
//        the migration itself
//        recorded as its filename
// The first failure stops the run and prints the file, the line/column and the error.
//
// Historical migrations are never edited to make them run here. When one fails on a fresh
// database, the smallest fix goes in bootstrap.sql or before/NNNN.sql, with a comment saying what
// production has and why a fresh database lacks it.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const pg = require("pg");

// ── The one database this script may write to. Constants on purpose. ────────────────────────────
const TEST_HOST = "aws-0-us-east-2.pooler.supabase.com";
const TEST_PORT = 5432;
const TEST_USER = "postgres.olmehzbhtzegjxgswgyk";
const TEST_DB = "postgres";
const MARKER_VALUE = "contractor-north-test";
// Production's project ref. If it ever shows up anywhere in the connection, refuse.
const PROD_REF = "rbpokaozcxqownollqlx";

const repo = path.resolve(__dirname, "..", "..");
const migDir = path.join(repo, "supabase", "migrations");
const shimDir = path.join(repo, "supabase", "test-db");
const bootstrapFile = path.join(shimDir, "bootstrap.sql");
const beforeDir = path.join(shimDir, "before");

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function readPassword() {
  if (process.env.CN_TEST_DB_PW) return process.env.CN_TEST_DB_PW.trim();
  const rtf = path.join(os.homedir(), "Developer", "db", "CN_test_db.rtf");
  if (!fs.existsSync(rtf)) die(`No CN_TEST_DB_PW and no ${rtf}. Refusing.`);
  return execFileSync("textutil", ["-convert", "txt", "-stdout", rtf], { encoding: "utf8" }).replace(/[\r\n]/g, "");
}

// A pg error's `position` is a 1-based character offset into the text we sent. Turn it into
// line:column and show that line, so the failure points at the statement.
function locate(sql, position) {
  const pos = Number(position);
  if (!pos) return null;
  const before = sql.slice(0, pos - 1);
  const line = before.split("\n").length;
  const col = pos - before.lastIndexOf("\n") - 1;
  const text = sql.split("\n")[line - 1] ?? "";
  return { line, col, text };
}

function report(label, sql, e) {
  console.log("FAILED");
  console.error(`\n✗ ${label} failed.`);
  console.error(`  error:    ${e.message}`);
  if (e.code) console.error(`  sqlstate: ${e.code}`);
  const at = locate(sql, e.position);
  if (at) {
    console.error(`  at:       line ${at.line}, column ${at.col} (character ${e.position} of the transaction text)`);
    console.error(`  line:     ${at.text.trim()}`);
  }
  if (e.internalQuery) console.error(`  inside:   ${e.internalQuery.split("\n").slice(0, 3).join(" ").trim()} (char ${e.internalPosition})`);
  if (e.where) console.error(`  where:    ${e.where.split("\n").join(" | ")}`);
  if (e.detail) console.error(`  detail:   ${e.detail}`);
  if (e.hint) console.error(`  hint:     ${e.hint}`);
  console.error("");
}

async function guard(client) {
  // (a) who are we really? The pooler maps the tenant user to 'postgres'; the tenant suffix is
  //     the project ref, and it is what pg sent in the startup packet.
  if (client.connectionParameters.user !== TEST_USER) die(`Connected as ${client.connectionParameters.user}, not ${TEST_USER}. Refusing.`);
  if (client.connectionParameters.host !== TEST_HOST) die(`Connected to ${client.connectionParameters.host}, not ${TEST_HOST}. Refusing.`);
  if (JSON.stringify(client.connectionParameters).includes(PROD_REF)) die("The connection mentions the PRODUCTION project ref. Refusing.");

  // (b) the marker.
  const { rows: m } = await client.query(`select to_regclass('public.cn_test_database_marker') is not null as present`);
  if (!m[0].present) {
    const { rows } = await client.query(
      `select
         (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public')
       + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')
       + (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
            and t.typtype in ('e','d','c') and not exists (select 1 from pg_class c where c.reltype = t.oid))
         as n`,
    );
    const n = Number(rows[0].n);
    if (n !== 0) die(`public has ${n} object(s) and no cn_test_database_marker. This is not a fresh test database. Refusing.`);
    console.log("public is empty: creating the test-database marker.");
    await client.query("begin");
    await client.query(`create table public.cn_test_database_marker (value text primary key, created_at timestamptz not null default now())`);
    await client.query(`insert into public.cn_test_database_marker (value) values ($1)`, [MARKER_VALUE]);
    // Nothing outside postgres should see or touch it.
    await client.query(`revoke all on public.cn_test_database_marker from public, anon, authenticated`);
    await client.query("commit");
  }
  const { rows: mv } = await client.query(`select value from public.cn_test_database_marker`);
  if (mv.length !== 1 || mv[0].value !== MARKER_VALUE) die(`cn_test_database_marker does not hold exactly one '${MARKER_VALUE}' row. Refusing.`);
  console.log(`Guard passed: ${TEST_USER} @ ${TEST_HOST}, marker '${MARKER_VALUE}'.`);
}

async function main() {
  const client = new pg.Client({
    host: TEST_HOST,
    port: TEST_PORT,
    user: TEST_USER,
    database: TEST_DB,
    password: readPassword(),
    ssl: { rejectUnauthorized: false },
    application_name: "cn-test-db-rebuild",
  });
  await client.connect();
  try {
    await guard(client);

    await client.query(`create table if not exists public.cn_test_migrations (name text primary key, applied_at timestamptz not null default now())`);
    await client.query(`revoke all on public.cn_test_migrations from public, anon, authenticated`);
    const done = new Set((await client.query(`select name from public.cn_test_migrations`)).rows.map((r) => r.name));

    const steps = [];
    if (fs.existsSync(bootstrapFile)) steps.push({ name: "test-db/bootstrap.sql", parts: [["test-db/bootstrap.sql", bootstrapFile]] });
    for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
      const num = f.split("_")[0];
      const parts = [];
      const shim = path.join(beforeDir, `${num}.sql`);
      if (fs.existsSync(shim)) parts.push([`test-db/before/${num}.sql`, shim]);
      parts.push([f, path.join(migDir, f)]);
      steps.push({ name: f, parts });
    }

    const todo = steps.filter((s) => !done.has(s.name));
    console.log(`${steps.length} step(s), ${steps.length - todo.length} already applied, ${todo.length} to run.\n`);

    for (const s of todo) {
      process.stdout.write(`→ ${s.parts.map((p) => p[0]).join(" + ")} … `);
      await client.query("begin");
      for (const [label, file] of s.parts) {
        const sql = fs.readFileSync(file, "utf8");
        try {
          await client.query(sql);
        } catch (e) {
          await client.query("rollback").catch(() => {});
          report(label, sql, e);
          process.exit(1);
        }
      }
      await client.query(`insert into public.cn_test_migrations (name) values ($1)`, [s.name]);
      await client.query("commit");
      console.log("OK");
    }

    const { rows } = await client.query(`select count(*)::int as n, max(name) as last from public.cn_test_migrations where name not like 'test-db/%'`);
    console.log(`\nDone. ${rows[0].n} migration(s) recorded; last: ${rows[0].last}.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => die(e.message));
