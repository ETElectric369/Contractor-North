// Runs every supabase/migrations/*.sql file in order against the database in
// SUPABASE_DB_URL (read from .env.local). Each file runs in its own
// transaction; on error it rolls back that file and stops.
//
//   node scripts/run-migrations.mjs            # run all
//   node scripts/run-migrations.mjs --verify   # run all, then print a summary
//
// THE TEST DATABASE ONLY (cn-v1134). SUPABASE_DB_URL is whatever .env.local says; pointed at
// production this would re-run every migration there. So after it connects and before it runs
// anything, it reads the test database's marker row (scripts/test-db/guard.cjs, the same rule
// rebuild.cjs and CI's check-test-db.cjs keep) and refuses in words when the marker is absent.
// Production migrations go through ~/Developer/db/apply-migration.cjs, one file at a time.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
const { checkMarker, DB_PUSH_REFUSAL } = require("./test-db/guard.cjs");

const root = process.cwd();

function loadEnvLocal() {
  const p = path.join(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

loadEnvLocal();
const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("✗ Set SUPABASE_DB_URL in .env.local (the Postgres connection string).");
  process.exit(1);
}

const dir = path.join(root, "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  // The marker first, before a single statement of a migration: no marker, nothing runs.
  const marker = await checkMarker(client);
  if (!marker.ok) {
    console.error(`✗ ${DB_PUSH_REFUSAL} (${marker.why}). Nothing was run.`);
    await client.end();
    process.exit(1);
  }
  console.log(`Guard passed: this is the test database. Running ${files.length} migration(s)…\n`);
  for (const f of files) {
    const sql = readFileSync(path.join(dir, f), "utf8");
    process.stdout.write(`→ ${f} … `);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("commit");
      console.log("OK");
    } catch (e) {
      await client.query("rollback");
      console.log("FAILED");
      console.error(`\n✗ ${f} failed:\n${e.message}\n`);
      process.exit(1);
    }
  }

  if (process.argv.includes("--verify")) {
    const { rows } = await client.query(
      `select o.name as company, p.email, p.role
         from public.profiles p join public.organizations o on o.id = p.org_id`,
    );
    console.log("\nVerification (profiles ↔ organizations):");
    console.table(rows);
  }
  console.log("\n✓ All migrations applied.");
} finally {
  await client.end();
}
