#!/usr/bin/env node
// PARITY DIFF: the TEST database's schema against PRODUCTION's, read from both catalogs.
//
//   node scripts/test-db/schema-diff.cjs
//
// PRODUCTION IS READ ONLY HERE. Its connection opens BEGIN TRANSACTION READ ONLY, proves
// transaction_read_only = on before its first catalog read, runs SELECTs on the catalog only, and
// rolls back. The test side is read the same way. Passwords come from CN_PROD_DB_PW / CN_TEST_DB_PW,
// else a textutil read of ~/Developer/db/CN_db.rtf / CN_test_db.rtf; they are never printed.
//
// It compares: columns (type, default, nullability, identity/generated, order), constraints,
// indexes, functions (md5 of the definition, security definer, config, owner), triggers (every
// schema's triggers that call a public/archive function, and every trigger on a public/archive
// table) and event triggers, RLS flags, policies (public, archive, storage), grants (tables,
// columns, functions, sequences, schemas, default privileges), views, enums, extensions, storage
// buckets, roles, and comments.
//
// The ALLOWED differences (printed, exit 0): the cn_test_* tables, comments, column order, the
// 'Contractor North' role, and platform ACLs (default privileges and grants held by Supabase's own
// roles outside public/archive). Anything else is printed under DIFFERENCES and exits 1.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const pg = require("pg");

const SIDES = {
  production: { host: "aws-1-us-east-2.pooler.supabase.com", user: "postgres.rbpokaozcxqownollqlx", env: "CN_PROD_DB_PW", rtf: "CN_db.rtf" },
  test: { host: "aws-0-us-east-2.pooler.supabase.com", user: "postgres.olmehzbhtzegjxgswgyk", env: "CN_TEST_DB_PW", rtf: "CN_test_db.rtf" },
};
const SCHEMAS = ["public", "archive"];

function password(side) {
  if (process.env[side.env]) return process.env[side.env].trim();
  const rtf = path.join(os.homedir(), "Developer", "db", side.rtf);
  if (!fs.existsSync(rtf)) throw new Error(`No ${side.env} and no ${rtf}.`);
  return execFileSync("textutil", ["-convert", "txt", "-stdout", rtf], { encoding: "utf8" }).replace(/[\r\n]/g, "");
}
const md5 = (s) => crypto.createHash("md5").update(String(s)).digest("hex");
const squash = (s) => String(s).replace(/\s+/g, " ").trim();

// Each query returns rows of { k, v }: k names the object, v is what must match.
const Q = {
  columns: `select 'column ' || c.table_schema || '.' || c.table_name || '.' || c.column_name as k,
                   concat_ws(' | ', c.data_type, c.udt_name, c.character_maximum_length, c.numeric_precision, c.numeric_scale,
                             'default=' || coalesce(c.column_default, '∅'), 'nullable=' || c.is_nullable,
                             'identity=' || c.is_identity, 'generated=' || coalesce(c.generation_expression, '∅')) as v
              from information_schema.columns c where c.table_schema = any($1)`,
  column_order: `select 'column order ' || n.nspname || '.' || cl.relname as k,
                        string_agg(a.attname, ',' order by a.attnum) as v
                   from pg_attribute a join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace
                  where n.nspname = any($1) and a.attnum > 0 and not a.attisdropped and cl.relkind in ('r', 'p', 'v', 'm')
                  group by n.nspname, cl.relname`,
  constraints: `select 'constraint ' || n.nspname || '.' || cl.relname || '.' || co.conname as k,
                       pg_get_constraintdef(co.oid) || ' validated=' || co.convalidated || ' deferrable=' || co.condeferrable as v
                  from pg_constraint co join pg_class cl on cl.oid = co.conrelid join pg_namespace n on n.oid = cl.relnamespace
                 where n.nspname = any($1)`,
  indexes: `select 'index ' || schemaname || '.' || indexname as k, indexdef as v from pg_indexes where schemaname = any($1)`,
  functions: `select 'function ' || p.oid::regprocedure::text as k,
                     concat_ws(' | ', 'md5=' || md5(pg_get_functiondef(p.oid)), 'secdef=' || p.prosecdef, 'config=' || coalesce(p.proconfig::text, '∅'),
                               'owner=' || pg_get_userbyid(p.proowner), 'lang=' || l.lanname, 'volatile=' || p.provolatile::text) as v,
                     pg_get_functiondef(p.oid) as body
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
               where n.nspname = any($1) and p.prokind in ('f', 'p')`,
  triggers: `select 'trigger ' || n.nspname || '.' || cl.relname || '.' || t.tgname as k,
                    pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text as v
               from pg_trigger t join pg_class cl on cl.oid = t.tgrelid join pg_namespace n on n.oid = cl.relnamespace
               join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
              where not t.tgisinternal and (n.nspname = any($1) or pn.nspname = any($1))`,
  event_triggers: `select 'event trigger ' || evtname as k,
                          concat_ws(' | ', evtevent, evtfoid::regprocedure::text, 'enabled=' || evtenabled::text, 'tags=' || coalesce(evttags::text, '∅'),
                                    'owner=' || pg_get_userbyid(evtowner)) as v
                     from pg_event_trigger`,
  rls: `select 'rls ' || n.nspname || '.' || cl.relname as k, 'enabled=' || cl.relrowsecurity || ' forced=' || cl.relforcerowsecurity as v
          from pg_class cl join pg_namespace n on n.oid = cl.relnamespace where n.nspname = any($1) and cl.relkind in ('r', 'p')`,
  policies: `select 'policy ' || schemaname || '.' || tablename || '.' || policyname as k,
                    concat_ws(' | ', permissive, roles::text, cmd, 'using=' || coalesce(qual, '∅'), 'check=' || coalesce(with_check, '∅')) as v
               from pg_policies where schemaname = any($1 || array['storage'])`,
  table_grants: `select 'grant ' || n.nspname || '.' || cl.relname as k, coalesce(cl.relacl::text, '∅') as v
                   from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
                  where n.nspname = any($1) and cl.relkind in ('r', 'p', 'v', 'm', 'S', 'f')`,
  column_grants: `select 'column grant ' || n.nspname || '.' || cl.relname || '.' || a.attname as k, a.attacl::text as v
                    from pg_attribute a join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace
                   where n.nspname = any($1) and a.attacl is not null and a.attnum > 0 and not a.attisdropped`,
  function_grants: `select 'function grant ' || p.oid::regprocedure::text as k, coalesce(p.proacl::text, '∅') as v
                      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1)`,
  schema_grants: `select 'schema ' || nspname as k, 'owner=' || pg_get_userbyid(nspowner) || ' acl=' || coalesce(nspacl::text, '∅') as v
                    from pg_namespace where nspname = any($1)`,
  default_acls: `select 'default acl ' || pg_get_userbyid(defaclrole) || ' in ' || coalesce(defaclnamespace::regnamespace::text, '(all)') || ' on ' || defaclobjtype::text as k,
                        defaclacl::text as v from pg_default_acl`,
  views: `select 'view ' || schemaname || '.' || viewname as k, md5(definition) as v, definition as body from pg_views where schemaname = any($1)
          union all
          select 'materialized view ' || schemaname || '.' || matviewname, md5(definition), definition from pg_matviews where schemaname = any($1)`,
  enums: `select 'enum ' || n.nspname || '.' || t.typname as k, string_agg(e.enumlabel, ',' order by e.enumsortorder) as v
            from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
           where n.nspname = any($1) group by n.nspname, t.typname`,
  types: `select 'type ' || n.nspname || '.' || t.typname as k, t.typtype::text as v
            from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = any($1) and t.typtype in ('d', 'c', 'r') and not exists (select 1 from pg_class c where c.reltype = t.oid)`,
  extensions: `select 'extension ' || extname as k, extversion || ' in ' || extnamespace::regnamespace::text as v from pg_extension`,
  buckets: `select 'bucket ' || id as k, concat_ws(' | ', 'public=' || public, 'limit=' || coalesce(file_size_limit::text, '∅'),
                    'mime=' || coalesce(allowed_mime_types::text, '∅')) as v from storage.buckets`,
  roles: `select 'role ' || rolname as k, concat_ws(' ', 'login=' || rolcanlogin, 'bypassrls=' || rolbypassrls) as v
            from pg_roles where rolname !~ '^pg_'`,
  comments: `select 'comment ' || d.classoid::regclass::text || ' ' ||
                    coalesce(pg_describe_object(d.classoid, d.objoid, d.objsubid), d.objoid::text) as k, d.description as v
               from pg_description d
               left join pg_class cl on d.classoid = 'pg_class'::regclass and cl.oid = d.objoid
               left join pg_proc p on d.classoid = 'pg_proc'::regclass and p.oid = d.objoid
              where coalesce(cl.relnamespace, p.pronamespace) in (select oid from pg_namespace where nspname = any($1))`,
};

async function snapshot(name) {
  const side = SIDES[name];
  const c = new pg.Client({ host: side.host, port: 5432, user: side.user, password: password(side), database: "postgres", ssl: { rejectUnauthorized: false }, application_name: "cn-schema-diff" });
  await c.connect();
  const snap = {};
  try {
    await c.query("begin transaction read only");
    const ro = (await c.query("show transaction_read_only")).rows[0].transaction_read_only;
    if (ro !== "on") throw new Error(`${name}: the transaction is not read-only. Stopping before any read.`);
    await c.query("set local statement_timeout = '60s'");
    for (const [cat, sql] of Object.entries(Q)) {
      const rows = (await c.query(sql, sql.includes("$1") ? [SCHEMAS] : [])).rows;
      snap[cat] = new Map(rows.map((r) => [r.k, { v: r.v, body: r.body }]));
    }
    await c.query("rollback");
  } finally {
    await c.end();
  }
  return snap;
}

// Why a difference is allowed, or null.
function allowed(cat, key) {
  if (/cn_test_/.test(key)) return "the test database's own bookkeeping (cn_test_* tables)";
  if (cat === "comments") return "comments";
  if (cat === "column_order") return "column order";
  if (cat === "roles" && key === "role Contractor North") return "the 'Contractor North' role (production only; no migration makes or uses it)";
  if (cat === "default_acls" && !/ in (public|archive) on /.test(key)) return "platform ACLs (Supabase's default privileges outside public/archive)";
  return null;
}

async function main() {
  const [prod, test] = [await snapshot("production"), await snapshot("test")];
  const diffs = [];
  const ok = [];
  for (const cat of Object.keys(Q)) {
    const keys = new Set([...prod[cat].keys(), ...test[cat].keys()]);
    for (const k of [...keys].sort()) {
      const p = prod[cat].get(k);
      const t = test[cat].get(k);
      let line = null;
      if (!t) line = `PRODUCTION ONLY  ${k}  = ${p.v}`;
      else if (!p) line = `TEST ONLY        ${k}  = ${t.v}`;
      else if (p.v !== t.v) {
        line = `DIFFERENT        ${k}\n                   production: ${p.v}\n                   test:       ${t.v}`;
        if (p.body != null && t.body != null) {
          line += md5(squash(p.body)) === md5(squash(t.body)) ? "\n                   (the bodies differ in whitespace only)" : "\n                   (the bodies differ in more than whitespace)";
        }
      }
      if (!line) continue;
      const why = allowed(cat, k);
      (why ? ok : diffs).push({ cat, line, why });
    }
  }
  const counts = Object.fromEntries(Object.keys(Q).map((c) => [c, `${prod[c].size}/${test[c].size}`]));
  console.log("Compared (production/test object counts):");
  for (const [c, n] of Object.entries(counts)) console.log(`  ${c.padEnd(16)} ${n}`);
  console.log(`\nALLOWED differences (${ok.length}):`);
  const byWhy = new Map();
  for (const d of ok) byWhy.set(d.why, [...(byWhy.get(d.why) ?? []), d.line]);
  for (const [why, lines] of byWhy) {
    console.log(`  ${why}: ${lines.length}`);
    for (const l of lines) console.log(`    ${l.split("\n")[0]}`);
  }
  console.log(`\nDIFFERENCES (${diffs.length}):`);
  for (const d of diffs) console.log(`  [${d.cat}] ${d.line}`);
  if (diffs.length) process.exit(1);
  console.log("  none: the test database mirrors production's schema.");
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
