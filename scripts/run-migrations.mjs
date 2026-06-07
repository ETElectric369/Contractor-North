// Runs every supabase/migrations/*.sql file in order against the database in
// SUPABASE_DB_URL (read from .env.local). Each file runs in its own
// transaction; on error it rolls back that file and stops.
//
//   node scripts/run-migrations.mjs            # run all
//   node scripts/run-migrations.mjs --verify   # run all, then print a summary
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

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
  console.log(`Connected. Running ${files.length} migration(s)…\n`);
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
