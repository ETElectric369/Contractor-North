// THE TEST-DATABASE MARKER, ONE RULE FOR EVERY SCRIPT THAT WRITES MIGRATIONS (cn-v1134).
//
// Only the Contractor North TEST database carries public.cn_test_database_marker with exactly one row,
// 'contractor-north-test' (rebuild.cjs made it on an empty schema; src/lib/db-guard.ts and
// scripts/test-db/check-test-db.cjs read the same row before any DB suite runs). Two scripts apply
// supabase/migrations wholesale: rebuild.cjs (the test database, by constant host and user) and
// scripts/run-migrations.mjs (`npm run db:push`, whatever SUPABASE_DB_URL in .env.local points at —
// pointed at production it would re-run 397 migrations there). Both decide with markerDecision()
// below, which is a PURE function over what the marker read returned, so tests/db-push-guard.test.ts
// proves the decision without a database. Nothing here connects; the caller hands in its client.

"use strict";

const MARKER_VALUE = "contractor-north-test";

/** What db:push says, in words, before it runs anything against a database without the marker. */
const DB_PUSH_REFUSAL = "db:push runs only against the test database; production migrations go through ~/Developer/db/apply-migration.cjs";

/**
 * The decision, pure: `rows` is what `select value from public.cn_test_database_marker` returned, or
 * null when the table is not there at all. Passes only on exactly one row holding the marker value.
 */
function markerDecision(rows) {
  if (rows === null || rows === undefined) return { ok: false, why: "no cn_test_database_marker table" };
  if (!Array.isArray(rows)) return { ok: false, why: "the marker read answered no rows" };
  if (rows.length !== 1) return { ok: false, why: `cn_test_database_marker holds ${rows.length} row(s), not one` };
  if (rows[0] == null || rows[0].value !== MARKER_VALUE) return { ok: false, why: `cn_test_database_marker does not hold '${MARKER_VALUE}'` };
  return { ok: true, why: null };
}

/** The marker read: the rows, or null when the table is absent. Reads only. */
async function readMarkerRows(client) {
  const { rows: m } = await client.query("select to_regclass('public.cn_test_database_marker') is not null as present");
  if (!m[0] || !m[0].present) return null;
  const { rows } = await client.query("select value from public.cn_test_database_marker");
  return rows;
}

/** Read the marker on this client and decide. */
async function checkMarker(client) {
  return markerDecision(await readMarkerRows(client));
}

module.exports = { MARKER_VALUE, DB_PUSH_REFUSAL, markerDecision, readMarkerRows, checkMarker };
