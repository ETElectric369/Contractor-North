// Applies a SINGLE migration file (passed as argv[2]) against SUPABASE_DB_URL
// from .env.local. No secrets live in this file — the connection string is read
// from the environment.
//   node scripts/run-one-migration.mjs supabase/migrations/0048_x.sql
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const root = process.cwd();
function loadEnvLocal() {
  const p = path.join(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const file = process.argv[2];
if (!file) { console.error("usage: run-one-migration.mjs <file.sql>"); process.exit(1); }
const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.MIGRATE_DB_URL;
// Either a full connection URL, or discrete PGHOST/PGUSER/PGPASSWORD/… from env
// (pg picks those up automatically). One-off only; no secrets stored on disk.
if (!url && !process.env.PGHOST) { console.error("✗ No DB URL or PGHOST in env."); process.exit(1); }

const sql = readFileSync(path.join(root, file), "utf8");
const client = new pg.Client(
  url ? { connectionString: url, ssl: { rejectUnauthorized: false } } : { ssl: { rejectUnauthorized: false } },
);
try {
  await client.connect();
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  console.log(`✓ Applied ${file}`);
} catch (e) {
  try { await client.query("rollback"); } catch {}
  console.error(`✗ ${file} failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
