#!/usr/bin/env node
// Rebuilds THE TEST DATABASE from supabase/migrations, in filename order.
//
//   node scripts/test-db/rebuild.cjs            apply whatever is not applied yet
//   node scripts/test-db/rebuild.cjs --reset    empty the test database's public schema and drop its
//                                               archive schema, then rebuild from 0001
//
// It writes to one database only: the Contractor North test project. The host and the user are
// constants in this file, not environment variables, so no env mix-up can point it at production.
// The password is the only thing it reads from outside: CN_TEST_DB_PW if set, else a textutil read
// of ~/Developer/db/CN_test_db.rtf. It never prints the password.
//
// SAFETY (it refuses, loudly, unless both hold; --reset runs only after they do):
//   (a) it connects as the test project's user (postgres.olmehzbhtzegjxgswgyk), and
//   (b) public.cn_test_database_marker holds exactly one row saying 'contractor-north-test'.
//       The marker is created ONLY when the public schema is completely empty (a brand-new
//       project). A database with objects in public and no marker is refused, full stop.
//
// ORDER, each step in its own transaction and recorded in public.cn_test_migrations with the md5 of
// its parts (resumable: a recorded step is skipped on the next run):
//   1. supabase/test-db/bootstrap.sql          recorded as 'test-db/bootstrap.sql'
//   2. for each supabase/migrations/NNNN_*.sql:
//        supabase/test-db/before/NNNN.sql, if it exists, in the SAME transaction, right before it
//        the migration itself
//        recorded as its filename
//   3. supabase/test-db/after/*.sql, in name order, after the last migration
//        recorded as 'test-db/after/<file>'. These make the test database what PRODUCTION is where
//        production differs from the migrations (the dashboard's objects, drift nobody migrated).
//        A migration added later runs after them on this database, as it does on production; the
//        run says so when that happens.
// The first failure stops the run and prints the file, the line/column and the error.
//
// NOTHING SILENT. It refuses, naming the file, when:
//   - a recorded step's parts no longer hash to the recorded md5 (an edited migration or shim, or a
//     before/NNNN.sql added for a migration already applied): it would never be re-applied;
//   - bootstrap.sql exists but is unrecorded while migrations are recorded (it would run last, not
//     first).
// Each of those needs a --reset rebuild (or the edit undone). A recorded step with no file on disk
// (another branch's migration on the shared test database) is NOT a refusal: it is named, and the
// run goes on (steps.cjs ledgerAhead, the same rule check-test-db.cjs follows).
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
// The steps and their md5s: one list, shared with check-test-db.cjs (CI's is-the-test-database-behind check).
const { stepsOnDisk, ledgerAhead } = require("./steps.cjs");

// ── The one database this script may write to. Constants on purpose. ────────────────────────────
const TEST_HOST = "aws-0-us-east-2.pooler.supabase.com";
const TEST_PORT = 5432;
const TEST_USER = "postgres.olmehzbhtzegjxgswgyk";
const TEST_DB = "postgres";
const MARKER_VALUE = "contractor-north-test";
// Production's project ref. If it ever shows up anywhere in the connection, refuse.
const PROD_REF = "rbpokaozcxqownollqlx";

const RESET = process.argv.slice(2).includes("--reset");
const unknownArgs = process.argv.slice(2).filter((a) => a !== "--reset");

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

// --reset: empty public (keeping the schema itself, Supabase's grants and default privileges on it,
// and the marker) and drop archive. Objects the migrations hung on other schemas that depend on
// public (the auth.users triggers, storage policies calling public functions, the ensure_rls event
// trigger) go with them by CASCADE; the rest the migrations re-create idempotently.
async function reset(client) {
  console.log("--reset: emptying public (the schema, its grants and the marker stay) and dropping archive …");
  await client.query("begin");
  try {
    await client.query("drop schema if exists archive cascade");
    await client.query(`
      do $$
      declare r record;
      begin
        for r in select e.extname from pg_extension e where e.extnamespace = 'public'::regnamespace loop
          execute format('drop extension if exists %I cascade', r.extname);
        end loop;
        for r in select c.relname, c.relkind from pg_class c
                  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
                    and c.relname <> 'cn_test_database_marker' loop
          execute format('drop %s if exists public.%I cascade',
            case r.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end, r.relname);
        end loop;
        for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' loop
          execute format('drop sequence if exists public.%I cascade', r.relname);
        end loop;
        for r in select p.oid::regprocedure::text as sig, p.prokind from pg_proc p where p.pronamespace = 'public'::regnamespace loop
          execute format('drop %s if exists %s cascade', case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, r.sig);
        end loop;
        for r in select t.typname, t.typtype from pg_type t
                  where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd', 'c', 'r')
                    and not exists (select 1 from pg_class c where c.reltype = t.oid) loop
          execute format('drop %s if exists public.%I cascade', case r.typtype when 'd' then 'domain' else 'type' end, r.typname);
        end loop;
      end $$`);
    const { rows } = await client.query(
      `select 'relation ' || c.relname as o from pg_class c where c.relnamespace = 'public'::regnamespace
          and c.relname not in ('cn_test_database_marker', 'cn_test_database_marker_pkey')
       union all select 'function ' || p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace
       union all select 'type ' || t.typname from pg_type t where t.typnamespace = 'public'::regnamespace
          and t.typtype in ('e', 'd', 'c', 'r') and not exists (select 1 from pg_class c where c.reltype = t.oid)`,
    );
    if (rows.length) throw new Error(`public still holds ${rows.length} object(s) after the reset: ${rows.slice(0, 10).map((r) => r.o).join(", ")}`);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    die(`--reset failed, nothing was changed: ${e.message}`);
  }
  console.log("--reset: public is empty but for the marker; archive is gone. Rebuilding from 0001.\n");
}

async function main() {
  if (unknownArgs.length) die(`Unknown argument(s): ${unknownArgs.join(" ")}. The only one is --reset.`);
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
    if (RESET) await reset(client);

    await client.query(`create table if not exists public.cn_test_migrations (name text primary key, applied_at timestamptz not null default now(), md5 text)`);
    await client.query(`alter table public.cn_test_migrations add column if not exists md5 text`);
    await client.query(`revoke all on public.cn_test_migrations from public, anon, authenticated`);
    const recorded = new Map((await client.query(`select name, md5 from public.cn_test_migrations`)).rows.map((r) => [r.name, r.md5]));

    const steps = stepsOnDisk();
    const byName = new Map(steps.map((s) => [s.name, s]));
    const problems = [];

    // A recorded step with no file on disk: the shared test database holds another branch's migration
    // (or a step renamed or deleted since). Said by name, never a refusal: the missing steps still
    // apply (one rule with check-test-db.cjs, steps.cjs ledgerAhead).
    const ahead = ledgerAhead(steps, recorded);
    if (ahead.length) {
      console.log(`Recorded here but not in this checkout (another branch's step, or one renamed or deleted); left as it is:`);
      for (const n of ahead) console.log(`  - ${n}`);
      console.log("");
    }

    // bootstrap.sql must run FIRST; on a database that already has migrations it would run last.
    const migrationsRecorded = [...recorded.keys()].filter((n) => !n.startsWith("test-db/")).length;
    if (byName.has("test-db/bootstrap.sql") && !recorded.has("test-db/bootstrap.sql") && migrationsRecorded > 0) {
      problems.push(
        `supabase/test-db/bootstrap.sql exists but was never applied here, and ${migrationsRecorded} migration(s) already are: it would run after them, not first. A --reset rebuild is needed.`,
      );
    }

    // Steps recorded before checksums existed get today's md5, said out loud.
    const unhashed = steps.filter((s) => recorded.has(s.name) && recorded.get(s.name) == null);
    if (unhashed.length) {
      console.log(`Recording the md5 of ${unhashed.length} step(s) applied before checksums existed (from the files on disk now).`);
      for (const s of unhashed) {
        await client.query(`update public.cn_test_migrations set md5 = $2 where name = $1`, [s.name, s.md5]);
        recorded.set(s.name, s.md5);
      }
    }

    // A recorded step whose parts changed would never be re-applied: refuse, naming the files.
    for (const s of steps) {
      if (recorded.has(s.name) && recorded.get(s.name) !== s.md5) {
        problems.push(`${s.parts.map((p) => p[0]).join(" + ")} changed since it was applied here (md5 ${recorded.get(s.name)} → ${s.md5}); it will never be re-applied. Undo the edit or rebuild with --reset.`);
      }
    }
    if (problems.length) die(`Refusing:\n  - ${problems.join("\n  - ")}`);

    const todo = steps.filter((s) => !recorded.has(s.name));
    console.log(`${steps.length} step(s), ${steps.length - todo.length} already applied, ${todo.length} to run.\n`);
    const afterRecorded = [...recorded.keys()].some((n) => n.startsWith("test-db/after/"));
    for (const s of todo) {
      if (s.kind === "migration" && afterRecorded) {
        console.log(`  note: ${s.name} runs after the test-db/after steps on this database (as it does on production); a --reset rebuild runs it before them.`);
      }
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
      await client.query(`insert into public.cn_test_migrations (name, md5) values ($1, $2)`, [s.name, s.md5]);
      await client.query("commit");
      console.log("OK");
    }

    const { rows } = await client.query(`select count(*)::int as n, max(name) as last from public.cn_test_migrations where name not like 'test-db/%'`);
    const { rows: extra } = await client.query(`select coalesce(string_agg(name, ', ' order by name), 'none') as names from public.cn_test_migrations where name like 'test-db/%'`);
    console.log(`\nDone. ${rows[0].n} migration(s) recorded; last: ${rows[0].last}. Test-db steps: ${extra[0].names}.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => die(e.message));
