// THE TEST DATABASE'S STEPS, as the repo says them: one list, read by rebuild.cjs (which applies them)
// and check-test-db.cjs (CI's check that the test database carries every one of them).
//
//   1. supabase/test-db/bootstrap.sql          recorded as 'test-db/bootstrap.sql'
//   2. for each supabase/migrations/NNNN_*.sql: supabase/test-db/before/NNNN.sql (if any) + the
//      migration, recorded as its filename
//   3. supabase/test-db/after/*.sql            recorded as 'test-db/after/<file>'
// Each step carries the md5 of its parts, which public.cn_test_migrations records beside its name.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const repo = path.resolve(__dirname, "..", "..");

// The md5 of a step: every part's label and text, in order. A shim added, removed or edited changes it.
function md5Of(parts) {
  const h = crypto.createHash("md5");
  for (const [label, file] of parts) h.update(`-- part: ${label}\n`).update(fs.readFileSync(file, "utf8")).update("\n");
  return h.digest("hex");
}

function stepsOnDisk(root = repo) {
  const migDir = path.join(root, "supabase", "migrations");
  const shimDir = path.join(root, "supabase", "test-db");
  const bootstrapFile = path.join(shimDir, "bootstrap.sql");
  const beforeDir = path.join(shimDir, "before");
  const afterDir = path.join(shimDir, "after");
  const steps = [];
  if (fs.existsSync(bootstrapFile)) steps.push({ name: "test-db/bootstrap.sql", kind: "bootstrap", parts: [["test-db/bootstrap.sql", bootstrapFile]] });
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
    const num = f.split("_")[0];
    const parts = [];
    const shim = path.join(beforeDir, `${num}.sql`);
    if (fs.existsSync(shim)) parts.push([`test-db/before/${num}.sql`, shim]);
    parts.push([f, path.join(migDir, f)]);
    steps.push({ name: f, kind: "migration", parts });
  }
  if (fs.existsSync(afterDir)) {
    for (const f of fs.readdirSync(afterDir).filter((x) => x.endsWith(".sql")).sort()) {
      steps.push({ name: `test-db/after/${f}`, kind: "after", parts: [[`test-db/after/${f}`, path.join(afterDir, f)]] });
    }
  }
  for (const s of steps) s.md5 = md5Of(s.parts);
  return steps;
}

/**
 * Where the test database is behind the repo, by name: the steps it never recorded, and the ones whose
 * files changed since it recorded them (a null md5 predates checksums and is not judged). A step the
 * database has and the repo does not (another branch's migration) is not this check's business.
 *   steps     stepsOnDisk()
 *   recorded  Map(name -> md5 | null), from public.cn_test_migrations
 */
function ledgerBehind(steps, recorded) {
  const missing = steps.filter((s) => !recorded.has(s.name)).map((s) => s.name);
  const changed = steps.filter((s) => recorded.has(s.name) && recorded.get(s.name) != null && recorded.get(s.name) !== s.md5).map((s) => s.name);
  return { missing, changed };
}

module.exports = { md5Of, stepsOnDisk, ledgerBehind };
