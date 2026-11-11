import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jobTakesScope, scopeForJob, scopeText } from "@/lib/estimate/job-scope";
import { bornFromEstimateCandidates } from "@/lib/quote-site";

/**
 * BORN FROM AN ESTIMATE (0409; cn-v1160. The owner, 2026-11-10: "the scope remains empty when that
 * can be filled from the estimate description all the way through we already have the information
 * right?"), read from the migration file the way migration-0408.test.ts reads 0408. Three things and
 * nothing else:
 *   1. public.accept_public_quote re-made from 0396's body (the last migration that made it) with
 *      the scope worked out once, written on the job it makes, and filled on a job that was already
 *      there only where that job's own Description is empty;
 *   2. public.invoice_document_projection's site list PATCHED IN PLACE (its live body is 0301's plus
 *      0315's and 0342's patches, so no file can re-create it): the job, then the source estimate's
 *      own address, then that estimate's lead's;
 *   3. the one-time backfill: the forward rule applied backward, for every company.
 * NO DATABASE RUNS HERE. What this file can prove is the text: the two md5s the ground check holds
 * the live function to, recomputed from the two files; that the statements 0396 wrote are all still
 * there; that the fragment the patch replaces appears exactly once in the body the earlier
 * migrations left; that the rule the SQL states is the app's (the self-check's own cases are run
 * through scopeForJob and jobTakesScope). That the SQL does what it says is the database suite's
 * (src/lib/born-from-estimate.integration.test.ts) and the migration's own self-check.
 * Applied migrations are immutable: 0409 is pinned the day it is applied.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const names = readdirSync(migrations).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
const migration = (prefix: string) => {
  const f = names.find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** The statements alone, without the header's words. */
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const count = (s: string, needle: string) => s.split(needle).length - 1;

/** A backslash, and the characters the rule is about, spelled by number so that no tool can read an
 *  escape into this file (the first draft of the migration lost three of them that way). */
const BS = String.fromCharCode(92);
const SPACE = String.fromCharCode(32);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NBSP = String.fromCharCode(160);
/** The four blank characters as the SQL spells them: E, a quote, a space, backslash-t, backslash-n,
 *  backslash-r, a quote. */
const BLANK = `E' ${BS}t${BS}n${BS}r'`;

const ACCEPT = "create or replace function public.accept_public_quote(p_token text)";
/** The function's text from its header to the tag that closes it, and the body between the tags. */
const acceptText = (sql: string) => {
  const at = sql.indexOf(ACCEPT);
  if (at < 0) throw new Error(`no ${ACCEPT}`);
  const open = sql.indexOf("as $function$", at) + "as $function$".length;
  const close = sql.indexOf("$function$", open);
  return { whole: sql.slice(at, close + "$function$".length), body: sql.slice(open, close) };
};
/** What the migration's ground check hashes: a body's statements with comments and spacing taken out
 *  (the JS twin of md5(translate(regexp_replace(prosrc, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', ''))). */
const statementsMd5 = (body: string) =>
  createHash("md5").update(body.replace(/-{2}[^\n]*/g, "").replace(/[ \t\n\r]/g, ""), "utf8").digest("hex");

/** The lines one list has that the other does not, in order (a longest-common-subsequence diff). */
function lineDiff(a: string[], b: string[]): { removed: string[]; added: string[] } {
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < a.length) removed.push(a[i++]);
  while (j < b.length) added.push(b[j++]);
  return { removed, added };
}
/** A body's statement lines: whole-line comments and blank lines dropped, nothing else touched. */
const statementLines = (body: string) => body.split("\n").filter((l) => l.trim() !== "" && !/^\s*--/.test(l));

/** A dollar-quoted literal out of a migration: the text between the nth pair of $tag$. */
const dollar = (sql: string, tag: string, nth = 0) => {
  const parts = sql.split(`$${tag}$`);
  if (parts.length < 2 * nth + 3) throw new Error(`no $${tag}$ literal number ${nth + 1}`);
  return parts[2 * nth + 1];
};
/** One exact replacement, which must find its fragment exactly once: the migrations' own rule. */
const once = (s: string, a: string, b: string) => {
  expect(count(s, a), `the fragment appears ${count(s, a)} time(s): ${a}`).toBe(1);
  return s.replace(a, () => b);
};

describe("migration 0409: born from an estimate", () => {
  const sql = migration("0409_");
  const code = noComments(sql);
  const m0396 = migration("0396_");
  const m0301 = migration("0301_");
  const m0315 = migration("0315_");
  const m0342 = migration("0342_");
  const accept = acceptText(sql);
  const was = acceptText(m0396);
  const acceptCode = noComments(accept.body);

  /** The file's parts, by the headings it carries. */
  const at = (heading: string) => {
    const i = sql.indexOf(heading);
    if (i < 0) throw new Error(`no heading: ${heading}`);
    return i;
  };
  const GROUND = "-- ── The ground it stands on";
  const BEFORE = "-- ── Every invoice document as it reads today";
  const PLACE = "-- ── 2. A bill made straight from an estimate knows its place";
  const SCOPE = "-- ── 1. A job born from an estimate takes its scope";
  const BACKFILL = "-- ── 3. The one-time backfill";
  const SELF = "-- ── Self-check";
  const ground = sql.slice(at(GROUND), at(BEFORE));
  const place = sql.slice(at(PLACE), at(SCOPE));
  const backfill = sql.slice(at(BACKFILL), at(SELF));
  const self = sql.slice(at(SELF));

  it("is the one 0409 and nothing sits past it", () => {
    expect(names.filter((n) => n.startsWith("0409_"))).toEqual(["0409_born_from_an_estimate.sql"]);
    expect(names.some((n) => /^041\d_|^04[2-9]\d_|^0[5-9]\d\d_|^[1-9]\d{3}_/.test(n))).toBe(false);
  });

  it("names itself, quotes the owner, runs under the house timeouts, and opens no transaction of its own", () => {
    expect(sql).toContain("migration 0409: born from an estimate");
    // The words the owner said, as he typed them (the rule's own file, job-scope.ts, opens with the same).
    const said =
      "i like how the new estimate tasks carry though to the items to buy and created a task to be done but the scope remains empty when that can be filled from the estimate description all the way through we already have the information right?";
    const unwrapped = (text: string) => text.replace(/\n\s*(?:--|\*) ?/g, " ").replace(/ {2,}/g, " ");
    expect(unwrapped(sql)).toContain(`The owner, 2026-11-10, on the page of a job made from an accepted estimate: "${said}"`);
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0409: born from an estimate/);
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(30);
    // The runner wraps the file in ONE transaction: no begin / commit / rollback statement here
    // (a plpgsql block's own `begin` has no semicolon).
    expect(code).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\b[^;\n]*;/im);
    expect(code).not.toMatch(/\bsavepoint\b/i);
  });

  it("does its work in the order it says: the ground, the read of every invoice, the patch and its proof, the function, the backfill, the self-check", () => {
    const order = [GROUND, BEFORE, PLACE, "-- THE PROOF, as 0342 gave it", SCOPE, BACKFILL, SELF, "-- The proof's two helpers leave with it."].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The patch stands before the function so the two reads of every invoice sit as close as they can.
    expect(sql.indexOf("create temp table _0409_before")).toBeLessThan(sql.indexOf("execute replace(v_def, v_old, v_new);"));
    expect(sql.indexOf("execute replace(v_def, v_old, v_new);")).toBeLessThan(sql.indexOf("from pg_temp._0409_before b"));
    expect(sql.indexOf("from pg_temp._0409_before b")).toBeLessThan(sql.indexOf(ACCEPT));
    expect(sql.indexOf(ACCEPT)).toBeLessThan(sql.indexOf("update public.jobs j"));
  });

  describe("the ground it stands on", () => {
    it("checks before it touches anything, and refuses in a plain sentence", () => {
      expect(ground.length).toBeGreaterThan(3000);
      for (const stands of [
        "for r in select t.tbl from (values ('jobs'), ('quotes'), ('invoices'), ('inquiries'), ('customers'), ('organizations')) as t(tbl) loop",
        "if to_regclass('public.' || r.tbl) is null then",
        "if (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then",
        "where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col and c.data_type = r.kind",
        "if to_regprocedure('public.accept_public_quote(text)') is null then",
        "if not has_function_privilege('anon', 'public.accept_public_quote(text)', 'execute')",
        "or not has_function_privilege('authenticated', 'public.accept_public_quote(text)', 'execute') then",
        "if to_regprocedure('public.invoice_document_projection(uuid)') is null",
        "or to_regprocedure('public.public_invoice(text)') is null then",
        "if has_function_privilege('anon', 'public.invoice_document_projection(uuid)', 'execute')",
        "or has_function_privilege('authenticated', 'public.invoice_document_projection(uuid)', 'execute') then",
        "if not has_function_privilege('service_role', 'public.invoice_document_projection(uuid)', 'execute')",
        "or not has_function_privilege('anon', 'public.public_invoice(text)', 'execute') then",
      ]) {
        expect(ground).toContain(stands);
      }
      // Nothing is changed inside the ground check: it only reads (and notes who owns and may call
      // the two functions, for later).
      expect(noComments(ground)).not.toMatch(/\balter\b|\bcreate\b|\bdrop\b|\bgrant\b|\brevoke\b|\binsert\b|\bupdate\b|\bdelete\b/i);
      expect((noComments(ground).match(/Nothing was changed\./g) ?? []).length).toBe(11);
    });

    /** Whether a migration's text adds `column` to `table` with that type: in the table's own CREATE,
     *  in an ALTER TABLE ... ADD COLUMN, or (org_id only) in 0004's loop over a list of tables. */
    const addsColumn = (text: string, table: string, column: string, kind: string): boolean => {
      const file = noComments(text);
      const type = ({ text: "text", uuid: "uuid", "timestamp with time zone": "timestamptz" } as Record<string, string>)[kind];
      if (!type) throw new Error(`a type this test does not know: ${kind}`);
      if (new RegExp(`alter table (?:public\\.)?${table}\\s+add column if not exists ${column}\\s+${type}\\b`, "i").test(file)) return true;
      const made = file.search(new RegExp(`create table (?:if not exists )?(?:public\\.)?${table}\\s*\\(`, "i"));
      if (made >= 0 && new RegExp(`^\\s*${column}\\s+${type}\\b`, "im").test(file.slice(made, file.indexOf("\n);", made)))) return true;
      if (column === "org_id") {
        const loop = file.indexOf("'alter table public.%I add column if not exists org_id uuid references public.organizations(id) on delete cascade;', t);");
        if (loop >= 0 && file.slice(file.lastIndexOf("foreach t in array array[", loop), loop).includes(`'${table}'`)) return true;
      }
      return false;
    };

    it("names every column it reads or writes with the migration that added it, and each of them is there", () => {
      const rows = [...ground.matchAll(/^\s*\('(\w+)',\s*'(\w+)',\s*'([a-z ]+)',\s*'(\d{4})'\),?$/gm)].map((m) => ({ table: m[1], column: m[2], kind: m[3], born: m[4] }));
      expect(rows.length).toBe(21);
      for (const r of rows) {
        expect(addsColumn(migration(`${r.born}_`), r.table, r.column, r.kind), `${r.table}.${r.column} (${r.kind}) is not added by ${r.born}`).toBe(true);
      }
      const named = (table: string) => rows.filter((r) => r.table === table).map((r) => `${r.column} ${r.born}`);
      // What the two rules and the backfill read, by table. The brief's own list is in it: the bill's
      // estimate, the estimate's lead, and the five address columns on the estimate and on the lead.
      expect(named("jobs")).toEqual(["description 0001", "org_id 0004"]);
      expect(named("invoices")).toEqual(["quote_id 0003", "org_id 0004"]);
      expect(named("quotes")).toEqual([
        "description 0120",
        "accepted_at 0014",
        "created_at 0001",
        "job_id 0001",
        "inquiry_id 0109",
        "org_id 0004",
        "address 0177",
        "unit 0187",
        "city 0177",
        "state 0177",
        "zip 0177",
      ]);
      expect(named("inquiries")).toEqual(["address 0034", "unit 0187", "city 0034", "state 0034", "zip 0034", "org_id 0034"]);
      // The detector is not a rubber stamp: it refuses a column a migration does not add.
      expect(addsColumn(migration("0177_"), "quotes", "unit", "text")).toBe(false);
      expect(addsColumn(migration("0003_"), "invoices", "inquiry_id", "uuid")).toBe(false);
      expect(addsColumn(migration("0004_"), "inquiries", "org_id", "uuid")).toBe(false);
      // The comment above the patch says the same, for the next reader of the function.
      for (const told of ["invoices.quote_id", "(0003, the table's own)", "quotes.inquiry_id (0109)", "quotes.address / city / state / zip (0177)", "quotes.unit (0187)", "(0034, the table's own)", "inquiries.unit (0187)"]) {
        expect(place).toContain(told);
      }
    });

    it("notes who owns each function and who may call it, the same way before and after", () => {
      const reading = "'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '')";
      expect(count(code, reading)).toBe(4); // noted twice in the ground check, read back twice in the self-check
      expect(ground).toContain(`perform set_config(\n    'cn.m0409_accept_was',\n    (select ${reading} from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure),\n    true);`);
      expect(ground).toContain(`perform set_config(\n    'cn.m0409_projection_was',\n    (select ${reading} from pg_proc p where p.oid = 'public.invoice_document_projection(uuid)'::regprocedure),\n    true);`);
      expect(self).toContain("v_was := current_setting('cn.m0409_accept_was', true);");
      expect(self).toContain("v_was := current_setting('cn.m0409_projection_was', true);");
      expect(self).toContain(`select ${reading} into v_now from pg_proc p where p.oid = v_accept;`);
      expect(self).toContain(`select ${reading} into v_now from pg_proc p where p.oid = v_projection;`);
      expect(count(self, "if v_now is distinct from v_was then")).toBe(2);
      // ONE TRANSACTION is checked before the first change, not only at the end.
      const patch = place.slice(place.indexOf("do $$"));
      const check = patch.indexOf("if coalesce(left(current_setting('cn.m0409_projection_was', true), 4), '') <> 'was:' then");
      expect(check).toBeGreaterThan(0);
      expect(check).toBeLessThan(patch.indexOf("pg_get_functiondef("));
      expect(check).toBeLessThan(patch.indexOf("execute replace("));
    });
  });

  describe("public.accept_public_quote: 0396's body, and only these additions", () => {
    it("0396 is the last migration that made it, and the ground check holds the live body to it", () => {
      const makers = names.filter((n) => /function\s+(public\.)?accept_public_quote\s*\(/i.test(readFileSync(join(migrations, n), "utf8")));
      expect(makers.slice(-2)).toEqual(["0396_the_customers_address_on_the_public_accept.sql", "0409_born_from_an_estimate.sql"]);
      const between = names.filter((x) => x >= "0397_" && x < "0409_");
      expect(between.length).toBe(12); // 0397 … 0408
      for (const n of between) expect(readFileSync(join(migrations, n), "utf8"), n).not.toContain("accept_public_quote");
      // The md5 the ground check compares the live body with IS 0396's body (statements only).
      const want = statementsMd5(was.body);
      expect(want).toBe("dd99a09340ab12e483379d9d3d610e5c");
      // …or, on a second run, exactly this file's own: never a body a later migration made, which a
      // stray re-run of this file would otherwise put back to what it was on the day of 0409.
      const mine = statementsMd5(accept.body);
      expect(mine).not.toBe(want);
      const reading = `coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^${BS}n]*', '', 'g'), ${BLANK}, '')), '')`;
      expect(sql).toContain(`  if ${reading}\n       not in ('${want}', '${mine}') then`);
      expect(sql).toContain("select p.prosrc into v_src from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure;");
      // The self-check reads the body it just stored the same way and wants this file's own md5: that
      // is what proves, on the first run, that a second run will pass the ground check.
      expect(sql).toContain(`  if ${reading} <> '${mine}' then`);
      expect(count(sql, reading)).toBe(2);
      expect(count(code, mine)).toBe(2);
      expect(count(code, want)).toBe(1);
      // The hashes are of statements only: a comment, a blank line or an indent changes neither.
      expect(statementsMd5(`-- a note\n${accept.body.replace(/\n/g, `\n${TAB} `)}\n\n   -- another\n`)).toBe(mine);
      // In both bodies two hyphens only ever open a comment, never sit inside a string: what stands
      // before them on the line has its quotes closed, so taking comments out cannot eat a statement.
      for (const body of [was.body, accept.body]) {
        const hyphened = body.split("\n").filter((l) => l.includes("--"));
        expect(hyphened.length).toBeGreaterThan(20);
        for (const line of hyphened) expect(count(line.slice(0, line.indexOf("--")), "'") % 2, line).toBe(0);
      }
    });

    it("the same door: its signature, its language, its security and its search path as 0396 wrote them, and no grant or revoke in this file", () => {
      const head = "create or replace function public.accept_public_quote(p_token text)\nreturns json\nlanguage plpgsql\nsecurity definer\nset search_path to 'public'\nas $function$";
      expect(was.whole.startsWith(head)).toBe(true);
      expect(accept.whole.startsWith(head)).toBe(true);
      expect(accept.whole.endsWith("\nend $function$")).toBe(true);
      // CREATE OR REPLACE keeps the owner and the grants; this file states none of its own.
      expect((code.match(/^\s*grant\b/gim) ?? []).length).toBe(0);
      expect((code.match(/^\s*revoke\b/gim) ?? []).length).toBe(0);
      expect(code).not.toMatch(/\balter function\b|\bowner to\b/i);
      // What the door has always been granted: the customer's link (anon) and a signed-in person.
      const grant = "grant execute on function public.accept_public_quote(text) to anon, authenticated;";
      for (const p of ["0014_", "0066_", "0119_"]) expect(migration(p)).toContain(grant);
      // …and no migration ever took it away.
      for (const n of names) expect(readFileSync(join(migrations, n), "utf8"), n).not.toMatch(/revoke[^;]*accept_public_quote/i);
    });

    it("every statement line of 0396's body is still there but one, and what was added is exactly this", () => {
      const { removed, added } = lineDiff(statementLines(was.body), statementLines(accept.body));
      expect(removed).toEqual(["                             address, unit, city, state, zip, created_by)"]);
      expect(added).toEqual([
        "  scope_for_job text;      -- 0409: what the job takes from the estimate's description",
        `  scope_for_job := nullif(btrim(q.description, ${BLANK}), '');`,
        "                             address, unit, city, state, zip, description, created_by)",
        "            scope_for_job,",
        "  if q.job_id is not null and scope_for_job is not null then",
        "    update public.jobs set description = scope_for_job",
        "     where id = q.job_id and org_id = q.org_id",
        `       and btrim(coalesce(description, ''), ${BLANK}) = '';`,
        "  end if;",
      ]);
      // And not one of 0396's own comment lines was dropped or reworded on the way.
      const comments = (body: string) => body.split("\n").filter((l) => /^\s*--/.test(l));
      const kept = lineDiff(comments(was.body), comments(accept.body));
      expect(kept.removed).toEqual([]);
      expect(kept.added.length).toBe(11);
      for (const line of kept.added) expect(line, line).toMatch(/^\s*-- (0409: |\S)/);
      expect(kept.added.filter((l) => l.includes("0409:")).length).toBe(3);
    });

    it("a: the scope is worked out once, where the estimate is in hand and before a job is born or met", () => {
      expect(count(acceptCode, "scope_for_job")).toBe(5); // declared, worked out, written on the insert, asked, filled
      expect(count(acceptCode, "q.description")).toBe(1);
      const made = accept.body.indexOf(`  scope_for_job := nullif(btrim(q.description, ${BLANK}), '');`);
      expect(made).toBeGreaterThan(accept.body.indexOf("  if q.job_id is null and q.revises_quote_id is not null then"));
      expect(made).toBeGreaterThan(accept.body.indexOf("      new_job := null;"));
      expect(made).toBeLessThan(accept.body.indexOf("  if q.job_id is null then\n"));
      // The estimate read at the top is the one whose words are taken: q is not read again on the way
      // (the one re-read is on the path that returns at once).
      expect(count(acceptCode, "select * into q from public.quotes")).toBe(2);
      expect(accept.body.indexOf("select * into q from public.quotes where id = q.id;")).toBeLessThan(accept.body.indexOf("if q.inquiry_id is not null then"));
    });

    it("b: the job it makes is born with the scope as its Description", () => {
      expect(accept.body.replace(/^\s*--.*\n/gm, "")).toContain(
        [
          "    insert into public.jobs (org_id, customer_id, inquiry_id, name, status,",
          "                             address, unit, city, state, zip, description, created_by)",
          "    values (q.org_id, q.customer_id, q.inquiry_id,",
          "            public.job_name_from(null, q.title, cust.name, cust.company_name, cust.type::text,",
          "                                 coalesce(nullif(site_address, ''), cust.address),",
          "                                 case when coalesce(site_address, '') <> '' then site_unit else cust.unit end,",
          "                                 inq.name,",
          "                                 (now() at time zone org_tz)::date),",
          "            'to_be_scheduled',",
          "            site_address, site_unit, site_city, site_state, site_zip,",
          "            scope_for_job,",
          "            q.created_by)",
          "    returning id into new_job;",
        ].join("\n"),
      );
      // Twelve columns named, twelve values written: the scope is the eleventh of each.
      const insert = acceptCode.slice(acceptCode.indexOf("insert into public.jobs ("), acceptCode.indexOf("returning id into new_job;"));
      const columns = insert.slice(insert.indexOf("(") + 1, insert.indexOf(")")).split(",").map((s) => s.trim());
      expect(columns).toEqual(["org_id", "customer_id", "inquiry_id", "name", "status", "address", "unit", "city", "state", "zip", "description", "created_by"]);
      expect(count(acceptCode, "insert into public.jobs")).toBe(1);
    });

    it("c: a job that was already there takes it only where its own Description is empty, and only when there is a scope", () => {
      const block = [
        "  if q.job_id is not null and scope_for_job is not null then",
        "    update public.jobs set description = scope_for_job",
        "     where id = q.job_id and org_id = q.org_id",
        `       and btrim(coalesce(description, ''), ${BLANK}) = '';`,
        "  end if;",
        "",
        "  return json_build_object('ok', true);",
        "end ",
      ].join("\n");
      // The last thing the function does, after the block that makes a job has closed.
      expect(accept.body.endsWith(block)).toBe(true);
      const fill = accept.body.indexOf("  if q.job_id is not null and scope_for_job is not null then");
      expect(fill).toBeGreaterThan(accept.body.indexOf("      delete from public.jobs where id = new_job and org_id = q.org_id;\n    end if;\n  end if;\n"));
      // The one write of a Description that is not the insert, and it is bound to the estimate's company.
      expect(count(acceptCode, "set description = ")).toBe(1);
      expect(count(acceptCode, "update public.jobs")).toBe(1);
      // The job made in this call is not filled a second time: its link leaves q.job_id null. The
      // three ways q.job_id comes to be set are all jobs this call did not make.
      expect(count(acceptCode, "q.job_id := new_job;")).toBe(1); // the revision pin (0392)
      expect(count(acceptCode, "select job_id into q.job_id from public.quotes where id = q.id;")).toBe(2); // both doors that lost a race
      const link = accept.body.slice(accept.body.indexOf("    returning id into new_job;"), fill);
      expect(link).not.toContain("q.job_id := ");
    });

    it("0392's and 0396's guards stand as they were, and the readers of the latest definer still find what they look for", () => {
      for (const kept of [
        // 0392: the guarded flip and the revision pin
        "update public.quotes set status = 'accepted', accepted_at = now() where id = q.id and status = 'sent';",
        "  if q.job_id is null and q.revises_quote_id is not null then",
        "    select o.job_id into new_job from public.quotes o where o.id = q.revises_quote_id and o.org_id = q.org_id;",
        // 0396: the customer's address as the third fallback, and the compare-and-set link with the losing door's job removed
        "    elsif cust.id is not null and coalesce(cust.address, '') <> '' then",
        "      site_address := cust.address; site_unit := cust.unit; site_city := cust.city; site_state := cust.state; site_zip := cust.zip;",
        "    update public.quotes set job_id = new_job where id = q.id and job_id is null;\n    if not found then\n      select job_id into q.job_id from public.quotes where id = q.id;\n      delete from public.jobs where id = new_job and org_id = q.org_id;\n    end if;",
      ]) {
        expect(accept.body).toContain(kept);
        expect(was.body).toContain(kept);
      }
      expect(count(acceptCode, "set job_id = new_job where id = q.id and job_id is null")).toBe(2);
      expect(acceptCode).not.toMatch(/set job_id = new_job where id = q\.id;/); // no unguarded link
      // src/lib/job-name.test.ts reads the LATEST definer, which is this file now: what it asks of it.
      expect(sql).toMatch(/public\.job_name_from\(null, q\.title,/);
      expect(sql).toMatch(/case when coalesce\(site_address, ''\) <> '' then site_unit else cust\.unit end,\s*inq\.name,/);
      expect(noComments(sql.slice(sql.indexOf(ACCEPT)))).not.toMatch(/'Job from '/);
      // tests/migration-0408.test.ts looks for the makers of the estimate's own public door: not this file.
      expect(sql).not.toMatch(/function\s+(public\.)?public_quote\s*\(/i);
    });
  });

  describe("what counts as blank: a space, a tab, a line feed and a carriage return, and only those", () => {
    /** Every call of btrim in the statements, with what stands between its parentheses. */
    const btrims = (text: string) => {
      const calls: string[] = [];
      let from = 0;
      for (;;) {
        const open = text.indexOf("btrim(", from);
        if (open < 0) break;
        let depth = 0;
        let end = open + "btrim".length;
        for (; end < text.length; end++) {
          if (text[end] === "(") depth++;
          if (text[end] === ")" && --depth === 0) break;
        }
        calls.push(text.slice(open + "btrim(".length, end));
        from = open + 1;
      }
      return calls;
    };

    it("every trim of a description names exactly the four, wherever it is: the function, the backfill, the self-check", () => {
      const calls = btrims(code);
      const onWords = calls.filter((c) => /description|r\.given|r\.has/.test(c));
      const others = calls.filter((c) => !/description|r\.given|r\.has/.test(c));
      // The two that are not about a description are 0396's own, on an e-mail address: not this rule's.
      expect(others).toEqual(["lower(coalesce(inq.email, ''))", "lower(coalesce(c.email, ''))"]);
      for (const c of onWords) expect(c.endsWith(`, ${BLANK}`), `btrim(${c})`).toBe(true);
      expect(onWords).toEqual([
        // accept_public_quote
        `q.description, ${BLANK}`,
        `coalesce(description, ''), ${BLANK}`,
        // the backfill: the scope, the empty job, an estimate that has words, and the empty job again on the write
        `q.description, ${BLANK}`,
        `coalesce(j.description, ''), ${BLANK}`,
        `q.description, ${BLANK}`,
        `coalesce(j.description, ''), ${BLANK}`,
        // the self-check: the two tables, the two marks it looks for in the stored body, what the backfill left
        `r.given #>> '{}', ${BLANK}`,
        `coalesce(r.has #>> '{}', ''), ${BLANK}`,
        `q.description, ${BLANK}`,
        `coalesce(description, ''), ${BLANK}`,
        `coalesce(j.description, ''), ${BLANK}`,
        `q.description, ${BLANK}`,
      ]);
      // The set is written fourteen times in the statements: those twelve, and the two readings of the
      // function's body, which take the same four characters out of it before hashing.
      expect(count(code, BLANK)).toBe(14);
      expect(count(code, `translate(regexp_replace(v_src, E'-{2}[^${BS}n]*', '', 'g'), ${BLANK}, '')`)).toBe(2);
      // No other trim touches a description: not trim(), ltrim(), rtrim() or a bare btrim(x).
      expect(code).not.toMatch(/\b(?:ltrim|rtrim|trim)\s*\(/i);
      expect(count(accept.body, BLANK)).toBe(2);
    });

    it("the SQL's four characters are the app's four, and JavaScript's own trim() is not the rule", { timeout: 30_000 }, () => {
      // The literal, decoded the way Postgres reads an E'' string.
      const inside = BLANK.slice(2, -1);
      const one: Record<string, number> = { t: 9, n: 10, r: 13 };
      const sqlSet: number[] = [];
      for (let i = 0; i < inside.length; i++) {
        if (inside[i] !== BS) {
          sqlSet.push(inside.codePointAt(i)!);
          continue;
        }
        expect(one[inside[i + 1]], `an escape this test does not know: ${inside[i + 1]}`).toBeDefined();
        sqlSet.push(one[inside[i + 1]]);
        i += 1;
      }
      expect(sqlSet.sort((a, b) => a - b)).toEqual([9, 10, 13, 32]);
      // The app's twin strips exactly those, at an end, and nothing else in all of Unicode. (Asked of
      // every character there is, and judged once at the end: a million expectations is a slow test.)
      const appSet: number[] = [];
      const disagree: string[] = [];
      let jsTrimOnly = 0;
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue; // half of a pair is not a character
        const ch = String.fromCodePoint(cp);
        const ends = `${ch}x${ch}`;
        const blank = scopeText(ends) === "x";
        if (blank) appSet.push(cp);
        else if (ends.trim() === "x") jsTrimOnly++;
        // The three readers are one rule: a description of only that character is no scope, and a
        // Description of only that character is an empty one, exactly when the character is blank.
        if ((scopeForJob(ch) === null) !== blank || jobTakesScope(ch) !== blank) disagree.push(`U+${cp.toString(16).toUpperCase()}`);
      }
      expect(disagree).toEqual([]);
      expect(appSet).toEqual([9, 10, 13, 32]);
      // The header's count: trim() strips a no-break space and twenty more that the rule keeps.
      expect(jsTrimOnly).toBe(21);
      expect(sql).toContain("trim(), which also strips a no-break space and twenty more");
      expect(`${NBSP}x`.trim()).toBe("x");
      expect(scopeForJob(`${NBSP}x`)).toBe(`${NBSP}x`);
    });

    /** The self-check's two tables, as written: a JSON string (or null) for each description. */
    const text = (cell: string): string | null => (cell === "null::jsonb" ? null : (JSON.parse(cell.slice(1, -"'::jsonb".length)) as string));
    const scopeCases = [...self.matchAll(/^\s*\('([^']*)', ('"[^']*"'::jsonb|null::jsonb), ('"[^']*"'::jsonb|null::jsonb)\),?$/gm)].map((m) => ({ why: m[1], given: text(m[2]), want: text(m[3]) }));
    const takeCases = [...self.matchAll(/^\s*\('([^']*)', ('"[^']*"'::jsonb|null::jsonb), (true|false)\),?$/gm)].map((m) => ({ why: m[1], has: text(m[2]), takes: m[3] === "true" }));

    it("the self-check's cases are the app's answers: each description through scopeForJob, each Description through jobTakesScope", () => {
      expect(scopeCases.length).toBe(10);
      for (const k of scopeCases) expect({ why: k.why, scope: scopeForJob(k.given) }).toEqual({ why: k.why, scope: k.want });
      expect(takeCases.length).toBe(5);
      for (const k of takeCases) expect({ why: k.why, takes: jobTakesScope(k.has) }).toEqual({ why: k.why, takes: k.takes });
      // The cases the brief asked for by name are there, by what they hold.
      const by = (re: RegExp) => scopeCases.find((k) => re.test(k.why))!;
      expect(by(/^spaces at both ends/).given).toBe(`${SPACE.repeat(3)}Replace the main panel${SPACE.repeat(2)}`);
      expect(by(/a tab, a line feed and a carriage return/).given).toBe(`${TAB}${CR}${LF} Replace the main panel ${LF}${CR}${TAB}`);
      expect(by(/a tab, a line feed and a carriage return/).want).toBe("Replace the main panel");
      expect(by(/blank between the words stays/).want).toBe(`Replace the main panel.${LF}${LF}${TAB}Patch  the drywall.`);
      expect(by(/^only blank space/).given).toBe(` ${TAB}${CR}${LF} `);
      expect(by(/^only blank space/).want).toBeNull();
      expect(by(/^no description/).given).toBeNull();
      expect(by(/no-break space is not blank/).given).toBe(` ${NBSP} Replace the main panel ${NBSP} `);
      expect(by(/no-break space is not blank/).want).toBe(`${NBSP} Replace the main panel ${NBSP}`);
      expect(by(/no-break space alone/).want).toBe(NBSP);
      expect(by(/vertical tab and a form feed/).want).toBe(`${String.fromCharCode(11)}Replace the main panel${String.fromCharCode(12)}`);
      expect(takeCases.map((k) => k.takes)).toEqual([true, true, true, false, false]);
      expect(takeCases[4].has).toBe(NBSP);
      // What the two loops ask of the database is the rule's own expression, the same as the function's.
      expect(self).toContain(`v_got := nullif(btrim(r.given #>> '{}', ${BLANK}), '');`);
      expect(self).toContain("if v_got is distinct from (r.want #>> '{}') then");
      expect(self).toContain(`if (btrim(coalesce(r.has #>> '{}', ''), ${BLANK}) = '') is distinct from r.takes then`);
    });

    it("no statement hides a character: plain ASCII everywhere outside the comments", () => {
      // An invisible space pasted into a statement reads the same on a screen and not to Postgres. The
      // self-check's no-break space and its vertical tab are JSON escapes, six plain characters each.
      const odd: string[] = [];
      sql.split("\n").forEach((line, i) => {
        const bad = [...line.replace(/--.*$/, "")].filter((c) => c.codePointAt(0)! > 0x7e || c.codePointAt(0)! < 0x20);
        if (bad.length) odd.push(`line ${i + 1}: ${bad.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`);
      });
      expect(odd).toEqual([]);
      expect(sql).not.toContain(NBSP);
      expect(sql).not.toContain(TAB);
      expect(sql).not.toContain(CR);
      expect(count(self, `${BS}u00a0`)).toBe(7);
      expect(count(self, `${BS}u000b`) + count(self, `${BS}u000c`)).toBe(4);
    });
  });

  describe("public.invoice_document_projection: patched in place, never re-created", () => {
    const PROJECTION = "create or replace function public.invoice_document_projection(p_invoice_id uuid)";
    /** 0301's body, the only file that ever wrote the whole function. */
    const body0301 = (() => {
      const from = m0301.indexOf(PROJECTION);
      const open = m0301.indexOf("as $$", from) + "as $$".length;
      return m0301.slice(open, m0301.indexOf("$$", open));
    })();
    /** A quoted SQL string out of 0315's patch block (its fragments are quoted, not dollar-quoted). */
    const quoted = (name: string) => {
      const m = m0315.match(new RegExp(`${name} := '((?:[^']|'')*)';`));
      if (!m) throw new Error(`no ${name} in 0315`);
      return m[1].split("''").join("'");
    };
    const vOld = dollar(sql, "old");
    const vNew = dollar(sql, "new");
    /** THE BODY THE EARLIER MIGRATIONS LEFT: 0301's, then 0315's patch, then 0342's, each replacing
     *  its own fragment exactly once, the way they did it on the database. */
    const live = () => once(once(body0301, quoted("v_old"), quoted("v_new")), dollar(m0342, "old"), dollar(m0342, "new"));

    it("no file can re-create it: 0301 wrote it whole, 0315 and 0342 patched it in place, and nothing else touched it", () => {
      const touched = names.filter((n) => readFileSync(join(migrations, n), "utf8").includes("invoice_document_projection"));
      expect(touched).toEqual(["0301_the_portal_reads_the_job.sql", "0315_a_customer_never_reads_a_supplier.sql", "0342_a_line_says_what_it_is.sql", "0409_born_from_an_estimate.sql"]);
      expect(names.filter((n) => readFileSync(join(migrations, n), "utf8").includes(PROJECTION))).toEqual(["0301_the_portal_reads_the_job.sql"]);
      expect(m0315).toContain("v_def := pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure);");
      expect(m0342).toContain("v_def := pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure);");
      // The body they left carries both patches, once each.
      const body = live();
      expect(count(body, "public.customer_line_words(i.org_id, it.description, it.import_source, it.import_key, it.edited)")).toBe(1);
      expect(count(body, "'line_kind', it.line_kind")).toBe(1);
      // This file does it their way: the live definition, one replace, one execute.
      expect(code).not.toContain(PROJECTION);
      expect(code).not.toMatch(/function\s+(public\.)?(invoice_document_projection|public_invoice)\s*\(/i);
      expect(count(place, "v_def  := pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure);")).toBe(2); // read, and read back
      expect(count(code, "execute replace(v_def, v_old, v_new);")).toBe(1);
      expect(count(code, "execute ")).toBe(1);
    });

    it("the fragment it replaces is one line, appears exactly once in the body the earlier migrations left, and sits inside the site list", () => {
      expect(vOld).toBe("from public.jobs j where j.id = i.job_id and j.org_id = i.org_id)),");
      expect(vOld).not.toContain("\n");
      const body = live();
      expect(count(body, vOld)).toBe(1);
      expect(count(body, vNew)).toBe(0);
      // The same words stand one more time in the function, broken over two lines (the billing type's
      // own read of the job), which is why the fragment is the whole line and not its tail.
      expect(count(body, "where j.id = i.job_id and j.org_id = i.org_id)),")).toBe(2);
      expect(count(body, "'site_candidates'")).toBe(1);
      const list = body.indexOf("'site_candidates', json_build_array(");
      expect(list).toBeGreaterThan(0);
      expect(body.indexOf(vOld)).toBeGreaterThan(list);
      expect(body.slice(list, body.indexOf(vOld))).toContain("'source', 'job'");
      expect(body.indexOf(vOld)).toBeLessThan(body.indexOf("    'org', (select json_build_object("));
      expect(body).not.toContain("'source', 'quote'");
      expect(body).not.toContain("'source', 'lead'");
      // What it puts back begins with that same line less one parenthesis: the job candidate is not touched.
      expect(vNew.startsWith(`${vOld.slice(0, -"),".length)},\n`)).toBe(true);
      expect(vNew.includes(vOld)).toBe(false);
    });

    it("refuses any ground but that one, and a second run finds its own list and leaves it", () => {
      const patch = place.slice(place.indexOf("do $$"), place.indexOf("-- THE PROOF, as 0342 gave it"));
      for (const step of [
        "v_olds := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);",
        "v_news := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);",
        "  if v_news = 1 and v_olds = 0 then\n    return;\n  end if;",
        "v_list := position('''site_candidates'', json_build_array(' in v_def);",
        "v_at   := position(v_old in v_def);",
        "v_head := case when v_list > 0 and v_at > v_list then substr(v_def, v_list, v_at - v_list) else '' end;",
        "  if v_olds <> 1 or v_news <> 0\n",
        "     or (length(v_def) - length(replace(v_def, '''site_candidates''', ''))) / length('''site_candidates''') <> 1\n",
        "     or position('''source'', ''job''' in v_head) = 0\n",
        "     or position('''source'', ''quote''' in v_def) > 0\n",
        "     or position('''source'', ''lead''' in v_def) > 0 then\n",
        "  if v_news <> 1 or v_olds <> 0 then",
        "  if position('customer_line_words' in v_def) = 0 or position('it.line_kind' in v_def) = 0 then",
      ]) {
        expect(patch).toContain(step);
      }
      // The order: the second run returns before anything is asked of the ground; the refusal stands
      // before the one execute; the read back stands after it.
      const second = patch.indexOf("if v_news = 1 and v_olds = 0 then");
      const refuse = patch.indexOf("if v_olds <> 1 or v_news <> 0");
      const run = patch.indexOf("execute replace(v_def, v_old, v_new);");
      const back = patch.indexOf("if v_news <> 1 or v_olds <> 0 then");
      expect([second, refuse, run, back]).toEqual([...[second, refuse, run, back]].sort((a, b) => a - b));
      expect(second).toBeGreaterThan(0);
      expect((noComments(patch).match(/Nothing was changed\./g) ?? []).length).toBe(4);
    });

    it("the list it leaves: the job as it was, then the estimate's own five, then its lead's five, each in the invoice's own company", () => {
      const patched = once(live(), vOld, vNew);
      const block = patched.slice(patched.indexOf("    'site_candidates', json_build_array("), patched.indexOf("    'org', (select json_build_object("));
      expect(block.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")).toBe(
        [
          "    'site_candidates', json_build_array(",
          "      (select json_build_object('source', 'job', 'parts', json_build_object(",
          "        'address', j.address, 'unit', j.unit, 'city', j.city, 'state', j.state, 'zip', j.zip))",
          "        from public.jobs j where j.id = i.job_id and j.org_id = i.org_id),",
          "      (select json_build_object('source', 'quote', 'parts', json_build_object(",
          "        'address', q.address, 'unit', q.unit, 'city', q.city, 'state', q.state, 'zip', q.zip))",
          "        from public.quotes q where q.id = i.quote_id and q.org_id = i.org_id),",
          "      (select json_build_object('source', 'lead', 'parts', json_build_object(",
          "        'address', inq.address, 'unit', inq.unit, 'city', inq.city, 'state', inq.state, 'zip', inq.zip))",
          "        from public.quotes q",
          "        join public.inquiries inq on inq.id = q.inquiry_id and inq.org_id = q.org_id",
          "       where q.id = i.quote_id and q.org_id = i.org_id)),",
          "",
        ].join("\n"),
      );
      // THE ORDER IS THE APP'S: bornFromEstimateCandidates, less its last entry, which the projection
      // carries beside the list (its own 'customer' key) for the reader to append.
      const sources = [...block.matchAll(/'source', '([a-z]+)'/g)].map((m) => m[1]);
      const app = bornFromEstimateCandidates({}).map((c) => c.source);
      expect(app).toEqual(["job", "quote", "lead", "customer"]);
      expect(sources).toEqual(app.slice(0, -1));
      expect(count(patched, "'customer', (select json_build_object(")).toBe(1);
      // Nothing else in the function moved: outside the list it is the body the earlier migrations left.
      const outside = (body: string) => body.slice(0, body.indexOf("    'site_candidates', json_build_array(")) + body.slice(body.indexOf("    'org', (select json_build_object("));
      expect(outside(patched)).toBe(outside(live()));
      // The job candidate's three lines are 0301's, character for character.
      const job = (body: string) => body.slice(body.indexOf("      (select json_build_object('source', 'job'"), body.indexOf("from public.jobs j where j.id = i.job_id and j.org_id = i.org_id)"));
      expect(job(patched)).toBe(job(body0301));
      // It still closes what it opened (strings and comments aside).
      const bare = patched.replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");
      expect(count(bare, "(")).toBe(count(bare, ")"));
      // The marks the self-check counts are there once each, and the old tail is gone.
      for (const mark of ["'source', 'job'", "'source', 'quote'", "'source', 'lead'"]) expect(count(patched, mark)).toBe(1);
      expect(count(patched, vOld)).toBe(0);
      expect(count(patched, vNew)).toBe(1);
      // The words it leaves in the function say what the list is now, and name the twin.
      expect(vNew).toContain("-- 0409: NOT ONE CANDIDATE ANY MORE.");
      expect(vNew).toContain("bornFromEstimateCandidates (src/lib/quote-site.ts)");
    });

    it("the proof: every invoice read before the patch and again after it, nothing moved but the site list, and its first entry is the one it was", () => {
      // Every invoice, with no filter, before anything is patched.
      expect(sql).toContain("drop table if exists pg_temp._0409_before;\ncreate temp table _0409_before as\nselect i.id, public.invoice_document_projection(i.id)::jsonb as j\n  from public.invoices i;");
      // The helper is 0342's own, with the key it leaves out changed: arrays compared as sets of entries.
      const helper = (text: string, name: string) => {
        const from = text.indexOf(`create or replace function pg_temp.${name}(j jsonb) returns jsonb`);
        return text.slice(from, text.indexOf("end $$;", from) + "end $$;".length);
      };
      expect(helper(sql, "_0409_rest").length).toBeGreaterThan(400);
      expect(helper(sql, "_0409_rest")).toBe(helper(m0342, "_0342_strip").split("_0342_strip").join("_0409_rest").replace("k <> 'line_kind'", "k <> 'site_candidates'"));
      const proof = place.slice(place.indexOf("-- THE PROOF, as 0342 gave it"));
      for (const held of [
        "count(*) filter (where a.j is null),",
        "count(*) filter (where a.j is not null and pg_temp._0409_rest(b.j) is distinct from pg_temp._0409_rest(a.j)),",
        "count(*) filter (where a.j is not null and (b.j -> 'site_candidates' -> 0) is distinct from (a.j -> 'site_candidates' -> 0)),",
        "then jsonb_array_length(a.j -> 'site_candidates') = 3",
        "and (a.j -> 'site_candidates' -> 0 = 'null'::jsonb or a.j -> 'site_candidates' -> 0 ->> 'source' = 'job')",
        "and (a.j -> 'site_candidates' -> 1 = 'null'::jsonb or a.j -> 'site_candidates' -> 1 ->> 'source' = 'quote')",
        "and (a.j -> 'site_candidates' -> 2 = 'null'::jsonb or a.j -> 'site_candidates' -> 2 ->> 'source' = 'lead')",
        "into v_all, v_gone, v_rest, v_first, v_shape, v_placed",
        "from pg_temp._0409_before b\n   cross join lateral (select public.invoice_document_projection(b.id)::jsonb as j) a;",
        "if v_gone > 0 then",
        "if v_rest > 0 then",
        "if v_first > 0 then",
        "if v_shape > 0 then",
      ]) {
        expect(proof).toContain(held);
      }
      expect((noComments(proof).match(/Nothing was changed\./g) ?? []).length).toBe(4);
      expect(proof).toMatch(/raise notice '0409: % invoice document\(s\) read before and after: nothing moved but the site list\./);
      // What it made in the session's temporary schema leaves with it, so a second run starts clean.
      expect(sql.trimEnd().endsWith("drop table pg_temp._0409_before;\ndrop function pg_temp._0409_rest(jsonb);")).toBe(true);
    });
  });

  describe("the one-time backfill: the forward rule applied backward", () => {
    // The backfill's own block: what sits between the stamp switched off and on again.
    const block = backfill.slice(backfill.indexOf("do $$"), backfill.indexOf("alter table public.jobs enable trigger touch_jobs;"));
    const blockCode = noComments(block);

    it("an empty job takes the earliest accepted estimate's words, in its own company, and a job with words is never written", () => {
      expect(block.trimEnd().endsWith("end $$;")).toBe(true);
      expect(block).toContain(
        [
          "  with pick as (",
          "    select distinct on (j.id)",
          "           j.id as job_id, j.org_id,",
          `           nullif(btrim(q.description, ${BLANK}), '') as scope`,
          "      from public.jobs j",
          "      join public.quotes q on q.job_id = j.id and q.org_id = j.org_id",
          `     where btrim(coalesce(j.description, ''), ${BLANK}) = ''`,
          "       and q.status = 'accepted'",
          `       and nullif(btrim(q.description, ${BLANK}), '') is not null`,
          "     order by j.id, coalesce(q.accepted_at, q.created_at), q.created_at, q.id",
          "  ), filled as (",
          "    update public.jobs j",
          "       set description = p.scope",
          "      from pick p",
          "     where j.id = p.job_id and j.org_id = p.org_id",
          `       and btrim(coalesce(j.description, ''), ${BLANK}) = ''`,
          "    returning j.org_id",
          "  )",
          "  select count(*), count(distinct f.org_id) into v_jobs, v_orgs from filled f;",
        ].join("\n"),
      );
      // The order is the brief's, after the one key a DISTINCT ON has to lead with.
      expect(block).toContain("order by j.id, coalesce(q.accepted_at, q.created_at), q.created_at, q.id");
      // One column, one table: the only write outside the function in the whole file.
      const outside = code.replace(noComments(accept.whole), "");
      expect(outside.length).toBe(code.length - noComments(accept.whole).length); // the function really was cut out
      // "update public." stands twice outside it: this statement, and the words the self-check looks
      // for in the stored function, which are a string and write nothing.
      expect(count(outside, "update public.")).toBe(2);
      expect(count(outside, "    update public.jobs j\n")).toBe(1);
      expect(count(outside, "or position('update public.jobs set description = scope_for_job' in v_src) = 0")).toBe(1);
      expect(count(blockCode, "update public.jobs j")).toBe(1);
      expect([...blockCode.matchAll(/\bset\s+(\w+)\s*=/g)].map((m) => m[1])).toEqual(["description"]);
      // No row is inserted or deleted anywhere outside the function. (Read with the strings taken out:
      // the self-check holds the function's own "delete from public.jobs …" as words it looks for.)
      const statements = outside.replace(/\$m\$[\s\S]*?\$m\$/g, "''").replace(/'(?:[^']|'')*'/g, "''");
      expect(statements).toContain("update public.jobs j");
      expect(count(statements, "update public.")).toBe(1);
      expect(statements).not.toMatch(/\binsert\b|\bdelete\b|\btruncate\b|\bmerge\b|\bcopy\b/i);
      expect(block).toMatch(/raise notice '0409: the backfill filled % job\(s\) in % organization\(s\)/);
      // The self-check asks the same question again once it has run: nothing it should have filled is left.
      expect(self).toContain(
        [
          "  select count(*) into v_left",
          "    from public.jobs j",
          `   where btrim(coalesce(j.description, ''), ${BLANK}) = ''`,
          "     and exists (",
          "       select 1 from public.quotes q",
          "        where q.job_id = j.id and q.org_id = j.org_id and q.status = 'accepted'",
          `          and nullif(btrim(q.description, ${BLANK}), '') is not null);`,
          "  if v_left > 0 then",
        ].join("\n"),
      );
    });

    /** Every trigger a migration up to this one puts on public.jobs that fires on an UPDATE. */
    const updateTriggersOnJobs = () => {
      const found = new Set<string>();
      for (const n of names.filter((x) => x < "0410_")) {
        const file = noComments(readFileSync(join(migrations, n), "utf8"));
        for (const m of file.matchAll(/create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+(\w+)\s+((?:before|after|instead\s+of)\b[^;]*?)\s+on\s+(?:public\.)?jobs\b/gi)) {
          if (/\bupdate\b/i.test(m[2])) found.add(m[1]);
        }
        // The first migrations made one trigger per table from a list: touch_<table>, stamp_org_<table>.
        for (const m of file.matchAll(/foreach t in array array\[([^\]]*)\] loop([\s\S]*?)end loop;/g)) {
          if (!m[1].includes("'jobs'")) continue;
          for (const t of m[2].matchAll(/'create trigger (\w+)_%1\$s ((?:before|after)[^']*?) on public\.%1\$s/g)) {
            if (/\bupdate\b/i.test(t[2])) found.add(`${t[1]}_jobs`);
          }
        }
      }
      return [...found].sort();
    };

    it("says what its update sets off, having read every trigger on jobs: the stamp, and nothing that rings or sends", () => {
      const fires = updateTriggersOnJobs();
      expect(fires).toEqual(["jobs_geo_follows_address", "jobs_hold_day", "jobs_unstamp_invoice_pdfs", "touch_jobs"]);
      // Each is named above the backfill, and in the header, with the migration that made it.
      for (const where of [backfill, sql.slice(0, at(GROUND))]) {
        for (const named of ["touch_jobs (0001, BEFORE UPDATE", "jobs_hold_day (0366, BEFORE INSERT OR UPDATE)", "jobs_unstamp_invoice_pdfs (0349)", "jobs_geo_follows_address (0404)"]) {
          expect(where).toContain(named);
        }
      }
      // They are what the comment says they are.
      expect(migration("0001_")).toContain("'create trigger touch_%1$s before update on public.%1$s\n       for each row execute function public.touch_updated_at();', t);");
      expect(migration("0001_")).toContain("  new.updated_at = now();");
      expect(migration("0366_")).toContain("create or replace trigger jobs_hold_day\n  before insert or update on public.jobs");
      expect(migration("0349_")).toMatch(/after update of billing_type, address, unit, city, state, zip on public\.jobs/);
      expect(migration("0404_")).toContain("create trigger jobs_geo_follows_address before update of address, city, state, zip on public.jobs");
      // The two that fire OF other columns do not fire on a Description: it is not in either list.
      for (const p of ["0349_", "0404_"]) expect(migration(p)).not.toMatch(/(?:before|after) update of [^;]*\bdescription\b[^;]* on public\.jobs/);
      // THE STAMP IS READ, so the backfill does not stamp: touch_jobs is switched off for the one
      // statement, by 0298's own method, and on again right after it. Nothing else is switched off.
      expect(sql).toContain("WHY THE STAMP IS SWITCHED OFF: it is READ.");
      expect(backfill).toContain("jobs_hold_day (0366, BEFORE INSERT OR UPDATE) still fires");
      expect(migration("0298_")).toContain("alter table public.customers disable trigger touch_customers;");
      expect(migration("0298_")).toContain("alter table public.customers enable trigger touch_customers;");
      expect(code.match(/disable trigger \w+/gi)).toEqual(["disable trigger touch_jobs"]);
      expect(code.match(/enable trigger \w+/gi)).toEqual(["enable trigger touch_jobs"]);
      expect(code).not.toMatch(/session_replication_role|disable trigger all|disable trigger user/i);
      const off = code.indexOf("alter table public.jobs disable trigger touch_jobs;");
      const on = code.indexOf("alter table public.jobs enable trigger touch_jobs;");
      const update = code.indexOf("update public.jobs j");
      // Immediately around the backfill: the disable is the last statement before its block, the
      // enable the first after it, and nothing but the block sits between them.
      expect(off).toBeGreaterThan(-1);
      expect(off).toBeLessThan(update);
      expect(on).toBeGreaterThan(update);
      expect(code.slice(off, on).match(/\bdo \$\$/g)).toHaveLength(1);
      expect(code.slice(off + "alter table public.jobs disable trigger touch_jobs;".length).trimStart().startsWith("do $$")).toBe(true);
      expect(code.slice(0, on).trimEnd().endsWith("end $$;")).toBe(true);
      // AS LATE AS IT CAN: the ALTER holds a lock on jobs to the commit, so it comes after the proof
      // over every invoice and after the function is replaced.
      expect(off).toBeGreaterThan(code.indexOf("from pg_temp._0409_before b"));
      expect(off).toBeGreaterThan(code.indexOf("create or replace function public.accept_public_quote"));
      // FOUND ENABLED BEFORE, AND ENABLED AGAIN AFTER: a missed enable would stop updated_at for good.
      expect(ground).toContain("if not exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'touch_jobs' and not tgisinternal) then");
      expect(ground).toContain("if (select tgenabled from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'touch_jobs' and not tgisinternal) <> 'O' then");
      expect(self).toContain("if coalesce((select tgenabled from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'touch_jobs' and not tgisinternal), '-') <> 'O' then");
      // The readers it names read what it says they read: a job by its updated_at. (0403 is a
      // migration, held to its words; the two app files are other people's, held only to the read.)
      const moved = "0409's header names it as a reader of jobs.updated_at: re-point the header (before 0409 is applied) or this pin (after)";
      expect(migration("0403_"), moved).toMatch(/and j\.status = 'complete'\s+and j\.updated_at >= p_job_from/);
      expect(src("src/lib/calendar-sync.ts"), moved).toMatch(/\.from\("jobs"\)[\s\S]{0,240}?\.gte\("updated_at",/);
      expect(src("src/lib/calendar-sync.ts"), moved).toMatch(/const JOB_PUSH_COLS =\s*"[^"]*\bdescription\b[^"]*"/);
      expect(src("src/app/(app)/timecards/page.tsx"), moved).toMatch(/\.eq\("status", "complete"\)[\s\S]{0,160}?\.gte\("updated_at",/);
    });
  });

  it("the self-check proves the rule, the door, the projection and the backfill, on the database", () => {
    for (const proof of [
      // the door: what kind of function it is, the guards it kept, the three additions, the body, who may call it
      "or (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = v_accept) <> 'plpgsql'",
      "or (select p.prorettype from pg_proc p where p.oid = v_accept) <> 'json'::regtype",
      "or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = v_accept), false) then",
      "if position('and status = ''sent''' in v_src) = 0 or position('revises_quote_id' in v_src) = 0 then",
      "if position('site_address := cust.address' in v_src) = 0",
      "or position('delete from public.jobs where id = new_job and org_id = q.org_id' in v_src) = 0 then",
      "if (length(v_src) - length(replace(v_src, guard, ''))) / length(guard) <> 2 then",
      `if position($m$scope_for_job := nullif(btrim(q.description, ${BLANK}), '');$m$ in v_src) = 0 then`,
      "if position('address, unit, city, state, zip, description, created_by)' in v_src) = 0",
      "or position('scope_for_job,' in v_src) = 0 then",
      "if position('if q.job_id is not null and scope_for_job is not null then' in v_src) = 0",
      "or position('update public.jobs set description = scope_for_job' in v_src) = 0",
      `or position($m$and btrim(coalesce(description, ''), ${BLANK}) = '';$m$ in v_src) = 0 then`,
      "if not has_function_privilege('anon', v_accept, 'execute') or not has_function_privilege('authenticated', v_accept, 'execute') then",
      "if (public.accept_public_quote('0409 self-check: no estimate has this token') ->> 'ok') is distinct from 'false' then",
      // the projection: what kind of function it is, its candidates, the earlier patches, who may call it
      "or (select p.provolatile from pg_proc p where p.oid = v_projection) <> 's'",
      "or (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = v_projection) <> 'sql'",
      "for r in select * from (values ('''source'', ''job'''), ('''source'', ''quote'''), ('''source'', ''lead''')) as t(mark) loop",
      "if (length(v_def) - length(replace(v_def, r.mark, ''))) / length(r.mark) <> 1 then",
      "if position('customer_line_words' in v_def) = 0 or position('it.line_kind' in v_def) = 0 then",
      "if has_function_privilege('anon', v_projection, 'execute') or has_function_privilege('authenticated', v_projection, 'execute') then",
      "if not has_function_privilege('service_role', v_projection, 'execute')",
      "or not has_function_privilege('anon', 'public.public_invoice(text)', 'execute') then",
      "if public.invoice_document_projection('00000000-0000-0000-0000-000000000000'::uuid) is not null",
      "or public.public_invoice('0409 self-check: no invoice has this token') is not null then",
    ]) {
      expect(self).toContain(proof);
    }
    expect(self).toContain("guard        constant text := 'set job_id = new_job where id = q.id and job_id is null';");
    // What the self-check looks for in the stored body is what this file's body says.
    for (const mark of [
      "and status = 'sent'",
      "revises_quote_id",
      "site_address := cust.address",
      "delete from public.jobs where id = new_job and org_id = q.org_id",
      `scope_for_job := nullif(btrim(q.description, ${BLANK}), '');`,
      "address, unit, city, state, zip, description, created_by)",
      "scope_for_job,",
      "if q.job_id is not null and scope_for_job is not null then",
      "update public.jobs set description = scope_for_job",
      `and btrim(coalesce(description, ''), ${BLANK}) = '';`,
    ]) {
      expect(accept.body).toContain(mark);
    }
    // 0301 left the projection callable by the service role alone, and /i's door open: what is asserted.
    expect(m0301).toContain("revoke execute on function public.invoice_document_projection(uuid) from public, anon, authenticated;");
    expect(m0301).toContain("grant execute on function public.invoice_document_projection(uuid) to service_role;");
    expect(m0301).toContain("if not has_function_privilege('anon', 'public.public_invoice(text)', 'execute') then");
  });

  it("every RAISE has as many arguments as its sentence has places for them", () => {
    // A sentence with one place too many, or one too few, does not compile: the whole file would
    // stop at that block with nothing changed. No database reads this file before the owner's does.
    const raises = [...sql.matchAll(/raise\s+(?:exception|notice)\s+'((?:[^']|'')*)'([^;]*);/g)];
    expect(raises.length).toBe(count(code, "raise exception") + count(code, "raise notice"));
    expect(raises.length).toBe(46);
    for (const m of raises) {
      const places = count(m[1].split("%%").join(""), "%");
      let depth = 0;
      let quoted = false;
      let args = 0;
      let cur = "";
      for (const ch of m[2]) {
        if (ch === "'") quoted = !quoted;
        if (!quoted && (ch === "(" || ch === "{")) depth++;
        if (!quoted && (ch === ")" || ch === "}")) depth--;
        if (!quoted && ch === "," && depth === 0) {
          if (cur.trim()) args++;
          cur = "";
          continue;
        }
        cur += ch;
      }
      if (cur.trim()) args++;
      expect({ sentence: m[1].slice(0, 70), args }).toEqual({ sentence: m[1].slice(0, 70), args: places });
    }
    // Every refusal says nothing was changed, but the two that can only be reached when something was.
    const refusals = [...code.matchAll(/raise exception '((?:[^']|'')*)'/g)].map((m) => m[1]);
    expect(refusals.length).toBe(43);
    const silent = refusals.filter((r) => !r.endsWith("Nothing was changed."));
    expect(silent.length).toBe(2);
    for (const r of silent) expect(r).toMatch(/^0409: this file has to run in ONE transaction .* did not reach this check\. Run it through the migration runner\.$/);
    for (const r of refusals) expect(r.startsWith("0409: ")).toBe(true);
    // The dollar-quote tags come in pairs.
    for (const tag of ["$$", "$old$", "$new$", "$m$", "$function$"]) expect(count(sql, tag) % 2, tag).toBe(0);
  });

  it("names its twins and its readers the day they are added, and they are there", () => {
    for (const named of [
      "scopeForJob and jobTakesScope",
      "(src/lib/estimate/job-scope.ts)",
      "bornFromEstimateCandidates (src/lib/quote-site.ts)",
      "src/lib/born-from-estimate.integration.test.ts",
      "src/app/i/[token]/page.tsx",
      "lib/doc-place projectionPlace",
      "lib/site-address pickSite",
      "lib/schedule/block-extras",
      "lib/gcal-map",
      "createInvoiceForJob",
    ]) {
      expect(sql).toContain(named);
    }
    // A rule nothing reads back is a hole, so what the header names is looked for in the code. If one
    // moves: before 0409 is applied, re-point its header; once it is applied the file is immutable,
    // so re-point THIS pin at where the reading went (and say so here). These files are other
    // people's, so each is held to the NAME the header gives and to the column it says is read,
    // never to how a line of theirs happens to be written.
    const moved = "0409's header names it: re-point the header (before 0409 is applied) or this pin (after)";
    const twin = src("src/lib/estimate/job-scope.ts");
    for (const fn of ["scopeText", "scopeForJob", "jobTakesScope"]) expect(twin, `${fn} is gone from job-scope.ts. ${moved}`).toMatch(new RegExp(`export function ${fn}\\(`));
    expect(src("src/lib/quote-site.ts"), moved).toMatch(/export function bornFromEstimateCandidates\(/);
    expect(existsSync(join(process.cwd(), "src/lib/born-from-estimate.integration.test.ts")), moved).toBe(true);
    expect(src("src/app/i/[token]/page.tsx"), moved).toMatch(/projectionPlace\(/);
    const place = src("src/lib/doc-place.ts");
    const reader = place.slice(place.indexOf("export function projectionPlace("));
    expect(place, moved).toMatch(/export function projectionPlace\(/);
    expect(reader.slice(0, reader.indexOf("\n}\n")), moved).toMatch(/site_candidates/);
    expect(src("src/lib/site-address.ts"), moved).toMatch(/export function pickSite\(/);
    expect(src("src/lib/schedule/block-extras.ts"), moved).toMatch(/job\.description/);
    expect(src("src/lib/gcal-map.ts"), moved).toMatch(/job\.description/);
    const jobsDoor = src("src/app/(app)/jobs/actions.ts");
    const billFromJob = jobsDoor.slice(jobsDoor.indexOf("export async function createInvoiceForJob("));
    expect(jobsDoor, moved).toMatch(/export async function createInvoiceForJob\(/);
    expect(billFromJob.slice(0, billFromJob.indexOf("\nexport ", 1)), moved).toMatch(/\bdescription\b/);
  });

  it("changes nothing else: one function re-made, one patched in place, one column filled; no table altered but the stamp switched off and on, no policy, no trigger made, no grant", () => {
    // Two CREATE FUNCTION statements are written out: the proof's helper in the session's temporary
    // schema, and accept_public_quote. The projection's own comes out of the database (execute).
    const creates = [...code.matchAll(/create (?:or replace )?function\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(creates).toEqual(["pg_temp._0409_rest", "public.accept_public_quote"]);
    expect([...code.matchAll(/drop function\s+([\w.]+)/gi)].map((m) => m[1])).toEqual(["pg_temp._0409_rest"]);
    // The one table it makes is the session's own, and it takes it away again.
    expect([...code.matchAll(/create\s+(temp\s+)?table\s+([\w.]+)/gi)].map((m) => `${m[1] ? "temp " : ""}${m[2]}`)).toEqual(["temp _0409_before"]);
    expect([...code.matchAll(/drop table\s+(?:if exists\s+)?([\w.]+)/gi)].map((m) => m[1])).toEqual(["pg_temp._0409_before", "pg_temp._0409_before"]);
    // The one ALTER TABLE is the stamp switched off and on around the backfill (two statements).
    expect(code.match(/alter table[^;]*;/gi)).toEqual(["alter table public.jobs disable trigger touch_jobs;", "alter table public.jobs enable trigger touch_jobs;"]);
    expect(code).not.toMatch(/add column|drop column|alter column|add constraint|drop constraint/i);
    expect(code).not.toMatch(/create policy|drop policy|create (?:or replace )?trigger|drop trigger|create index|drop index|create type|create extension/i);
    expect(code).not.toMatch(/enable row level security|disable row level security|security invoker/i);
    expect((code.match(/security definer/gi) ?? []).length).toBe(1); // accept_public_quote, as before
    expect(code).not.toMatch(/comment on /i);
    // The files it was written from are untouched (applied migrations are immutable).
    for (const applied of [m0396, m0301, m0315, m0342, migration("0392_")]) {
      expect(applied).not.toContain("0409");
      expect(applied).not.toContain("scope_for_job");
    }
    expect(m0396).not.toMatch(/'source', 'quote'/);
  });
});
