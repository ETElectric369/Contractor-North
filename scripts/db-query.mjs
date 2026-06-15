// Read-only ad-hoc query helper. Connection comes from PG* env vars (no secrets
// on disk). Usage: PGHOST=… PGPASSWORD=… node scripts/db-query.mjs "select …"
import pg from "pg";
const sql = process.argv[2];
if (!sql) { console.error("usage: db-query.mjs <sql>"); process.exit(1); }
const c = new pg.Client({ ssl: { rejectUnauthorized: false } });
try {
  await c.connect();
  const r = await c.query(sql);
  console.log(JSON.stringify(r.rows, null, 2));
} catch (e) {
  console.error("ERR:", e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
