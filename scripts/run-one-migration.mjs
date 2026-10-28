// Applies a SINGLE migration file (passed as argv[2]) against SUPABASE_DB_URL
// from .env.local. No secrets live in this file — the connection string is read
// from the environment.
//   node scripts/run-one-migration.mjs supabase/migrations/0048_x.sql
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import pg from "pg";

// THE SAME GUARD db:push HAS (scripts/test-db/guard.cjs): this script takes the same SUPABASE_DB_URL,
// and pointed at production it would apply the file there. It runs only where the test marker is.
const require = createRequire(import.meta.url);
const { checkMarker, DB_PUSH_REFUSAL } = require("./test-db/guard.cjs");

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
// A migration's RAISE NOTICEs are its report (0289 prints every converted piece and the one invoice
// line it writes). Without a listener pg drops them, and the real run would be silent while only a
// dry run showed what happened.
client.on("notice", (n) => {
  if (/does not exist, skipping/.test(n.message)) return;
  console.log(`  NOTICE: ${n.message}`);
});
try {
  await client.connect();
  const guard = await checkMarker(client);
  if (!guard.ok) {
    console.error(`✗ ${DB_PUSH_REFUSAL} (${guard.why}).`);
    await client.end();
    process.exit(1);
  }
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
