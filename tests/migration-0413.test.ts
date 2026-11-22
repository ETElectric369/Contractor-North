import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sureCustomerMatch, type DupCustomer } from "@/lib/crm/duplicates";
import { usualBillingKind } from "@/lib/schedule-options";
import { EXPORT_TABLES } from "@/lib/export/registry";

/**
 * WHO SAID YES (0413; cn-v1176. The owner, 2026-11-21: "... pop into the new job having a proper
 * record and simplify our environment while safeguarding the data at the same time? check the math
 * on that"), read from the migration file the way migration-0409.test.ts reads 0409:
 *   1. quotes.accepted_how and quotes.accepted_by, with their two named checks, no backfill;
 *   2. public.accept_public_quote re-made from 0409's body with FOUR changes and no others: (a) the
 *      lead read in the estimate's company, (b) the sure match, the SQL twin of sureCustomerMatch with
 *      the lead's own customer first, (c) the flip says 'customer_link' and names nobody, (d) the job
 *      names its billing kind through 0379's usual_billing_type.
 * NO DATABASE RUNS HERE. What this file proves is the text: the two md5s the ground check holds the
 * live function to, recomputed from the two files; that cutting the changed blocks out of 0409's body
 * and out of this one leaves the same text to the character; the self-check's marks; and a table of
 * leads and books fed to the app's matcher, with the SQL's answer said beside it and checked against a
 * line-by-line reading of the SQL's own steps. That the SQL does it is src/lib/sure-accept.integration.test.ts.
 * Applied migrations are immutable: 0413 is pinned the day it is applied.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const names = readdirSync(migrations).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
const migration = (prefix: string) => {
  const f = names.find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const count = (s: string, needle: string) => s.split(needle).length - 1;
const BS = String.fromCharCode(92);
const NBSP = String.fromCharCode(160);

const ACCEPT = "create or replace function public.accept_public_quote(p_token text)";
const acceptText = (sql: string) => {
  const at = sql.indexOf(ACCEPT);
  if (at < 0) throw new Error(`no ${ACCEPT}`);
  const open = sql.indexOf("as $function$", at) + "as $function$".length;
  const close = sql.indexOf("$function$", open);
  return { whole: sql.slice(at, close + "$function$".length), body: sql.slice(open, close) };
};
/** The ground check's reading of a body: statements only (the JS twin of
 *  md5(translate(regexp_replace(prosrc, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', ''))). */
const statementsMd5 = (body: string) =>
  createHash("md5").update(body.replace(/-{2}[^\n]*/g, "").replace(/[ \t\n\r]/g, ""), "utf8").digest("hex");

const M0409_MD5 = "883480080186365bab3f9607c236bdaa";
const M0413_MD5 = "12278c3bde6fe0e7ab556cfa50a85634";
const M0379_USUAL_MD5 = "6580468629986ba2ff89f11fc7c3cabe";

/** THE FOUR CHANGES, each as 0409 had it and as 0413 has it, plus one comment's wording (the owner is
 *  not named by name in this file). Cut out of both bodies, what is left must be the same text. */
const CHANGES: { part: string; was: string; now: string }[] = [
  {
    part: "c",
    was: "  update public.quotes set status = 'accepted', accepted_at = now() where id = q.id and status = 'sent';\n",
    now: [
      "  -- 0413: (c) WHO SAID YES. The customer, on their own link: accepted_how says so, and accepted_by is",
      "  -- written empty ON PURPOSE. An estimate the office marked accepted, walked back to sent and then",
      "  -- accepted on the link still carries the office person's id; left there, it would break the check",
      "  -- quotes_accepted_by_not_on_link and the customer's tap would be refused.",
      "  update public.quotes set status = 'accepted', accepted_at = now(), accepted_how = 'customer_link', accepted_by = null",
      "   where id = q.id and status = 'sent';",
      "",
    ].join("\n"),
  },
  {
    part: "a",
    was: "    select * into inq from public.inquiries where id = q.inquiry_id;\n",
    now: [
      "    -- 0413: (a) THE LEAD IS READ IN THE ESTIMATE'S OWN COMPANY. This function runs as its owner for",
      "    -- somebody holding a token and nothing else: no row of another company is read on their behalf.",
      "    select * into inq from public.inquiries where id = q.inquiry_id and org_id = q.org_id;",
      "",
    ].join("\n"),
  },
  {
    part: "b",
    was: [
      `    inq_phone := regexp_replace(coalesce(inq.phone, ''), '${BS}D', '', 'g');`,
      "    inq_email := btrim(lower(coalesce(inq.email, '')));",
      "    inq_name  := regexp_replace(lower(coalesce(inq.name, '')), '[^a-z0-9]', '', 'g');",
      "",
      "    select c.id into cust_id",
      "    from public.customers c",
      "    where c.org_id = q.org_id",
      "      and (",
      "        (length(inq_phone) >= 7",
      `          and right(regexp_replace(coalesce(c.phone, ''), '${BS}D', '', 'g'), 10) = right(inq_phone, 10))`,
      "        or (inq_email <> '' and btrim(lower(coalesce(c.email, ''))) = inq_email)",
      "        or (inq_name <> '' and regexp_replace(lower(coalesce(c.name, '')), '[^a-z0-9]', '', 'g') = inq_name)",
      "      )",
      "    order by c.created_at asc",
      "    limit 1;",
      "",
    ].join("\n"),
    now: [
      "    -- 0413: (b) THE SURE MATCH, the SQL twin of sureCustomerMatch (src/lib/crm/duplicates.ts), with",
      "    -- the lead's own customer first, as customerForInquiry (src/lib/actions/win-customer.ts) has it.",
      "    -- Every read is in the estimate's own company, and each step runs only while nothing is found.",
      "    -- 1. A LEAD ALREADY TIED TO A CUSTOMER KEEPS IT: that customer, when it is in this company.",
      "    if inq.customer_id is not null then",
      "      select c.id into cust_id from public.customers c",
      "       where c.id = inq.customer_id and c.org_id = q.org_id;",
      "    end if;",
      "",
      "    -- The keys, as normPhone, normEmail and normName make them: the last ten digits (the ASCII digits",
      "    -- alone, spelled [^0-9], never the class that follows the locale), the e-mail lowered and",
      "    -- trimmed, the name lowered with everything but a to z and 0 to 9 taken out.",
      "    inq_phone := right(regexp_replace(coalesce(inq.phone, ''), '[^0-9]', '', 'g'), 10);",
      "    inq_email := btrim(lower(coalesce(inq.email, '')));",
      "    inq_name  := regexp_replace(lower(coalesce(inq.name, '')), '[^a-z0-9]', '', 'g');",
      "",
      "    -- 2. A PHONE IS ONE PERSON: seven digits at least; the oldest record first, then by id.",
      "    if cust_id is null and length(inq_phone) >= 7 then",
      "      select c.id into cust_id",
      "      from public.customers c",
      "      where c.org_id = q.org_id",
      "        and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = inq_phone",
      "      order by c.created_at, c.id",
      "      limit 1;",
      "    end if;",
      "",
      "    -- 3. AN E-MAIL IS ONE PERSON, the same way.",
      "    if cust_id is null and inq_email <> '' then",
      "      select c.id into cust_id",
      "      from public.customers c",
      "      where c.org_id = q.org_id",
      "        and btrim(lower(coalesce(c.email, ''))) = inq_email",
      "      order by c.created_at, c.id",
      "      limit 1;",
      "    end if;",
      "",
      "    -- 4. A NAME ONLY WHEN IT IS SURE: not a placeholder (a fragment's Unknown caller, or digits",
      "    -- alone), the ONE customer in this company with that name, and no phone or e-mail on that record",
      "    -- saying it is somebody else (both sides have one, and they differ). When the HAVING fails the",
      "    -- select returns no row, and a SELECT INTO that finds no row sets cust_id to null: it stays",
      "    -- null, and a NEW customer is made just below. Find Duplicates still shows the pair by name.",
      "    if cust_id is null and inq_name <> '' and inq_name <> 'unknowncaller' and inq_name !~ '^[0-9]+$' then",
      "      select (array_agg(c.id))[1] into cust_id",
      "      from public.customers c",
      "      where c.org_id = q.org_id",
      "        and regexp_replace(lower(coalesce(c.name, '')), '[^a-z0-9]', '', 'g') = inq_name",
      "      having count(*) = 1",
      "         and not bool_or(",
      "               (length(inq_phone) >= 7",
      "                and length(right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)) >= 7",
      "                and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) <> inq_phone)",
      "            or (inq_email <> ''",
      "                and btrim(lower(coalesce(c.email, ''))) <> ''",
      "                and btrim(lower(coalesce(c.email, ''))) <> inq_email));",
      "    end if;",
      "",
    ].join("\n"),
  },
  {
    part: "d1",
    was: "    insert into public.jobs (org_id, customer_id, inquiry_id, name, status,\n",
    now: [
      "    -- 0413: (d) THE JOB SAYS HOW IT BILLS: the company's usual kind, counted in its own company",
      "    -- before this row exists, by public.usual_billing_type (0379; the SQL twin of usualBillingKind in",
      "    -- src/lib/schedule-options.ts): fixed only when its fixed jobs outnumber its time and material",
      "    -- ones, else time and material. 0379's trigger gave a job that named none the same answer; the",
      "    -- door says it out loud now, as every door that makes a job in the app does.",
      "    insert into public.jobs (org_id, customer_id, inquiry_id, name, status, billing_type,",
      "",
    ].join("\n"),
  },
  {
    part: "d2",
    was: "            'to_be_scheduled',\n",
    now: "            'to_be_scheduled',\n            public.usual_billing_type(q.org_id),\n",
  },
  {
    part: "the owner, not by name (a comment)",
    was: `(0369; Erik 2026-09-28, "street number and\n`,
    now: `(0369; the owner 2026-09-28, "street number and\n`,
  },
];

describe("migration 0413: the customer's own Accept finds the right customer, and says who said yes", () => {
  const sql = migration("0413_");
  const code = noComments(sql);
  const accept = acceptText(sql);
  const was = acceptText(migration("0409_"));
  const at = (heading: string) => {
    const i = sql.indexOf(heading);
    if (i < 0) throw new Error(`no heading: ${heading}`);
    return i;
  };
  const GROUND = "-- ── The ground it stands on";
  const COLUMNS = "-- ── 1. Who said yes";
  const FUNCTION = "-- ── 2. The customer's own Accept finds the right customer";
  const SELF = "-- ── Self-check";
  const ground = sql.slice(at(GROUND), at(COLUMNS));
  const columns = sql.slice(at(COLUMNS), at(FUNCTION));
  const self = sql.slice(at(SELF));

  it("is the newest migration, the one 0413, under the house timeouts, with no transaction of its own", () => {
    expect(names.filter((n) => n.startsWith("0413_"))).toEqual(["0413_who_said_yes.sql"]);
    expect(names[names.length - 1]).toBe("0413_who_said_yes.sql");
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    expect(code).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\b[^;\n]*;/im);
    expect(code).not.toMatch(/\bsavepoint\b/i);
    expect([GROUND, COLUMNS, FUNCTION, SELF].map(at)).toEqual([GROUND, COLUMNS, FUNCTION, SELF].map(at).sort((a, b) => a - b));
  });

  it("quotes the owner, names its twins, its readers and its writers, and says where the two rules can still differ", () => {
    const unwrapped = sql.replace(/\n\s*-- ?/g, " ").replace(/ {2,}/g, " ");
    expect(unwrapped).toContain(
      '"if the inspector were to be generating an estimated total while being recorded could that then be an instant create and approve estimate button at the bottom which would run the proper cycle of things, streamline the new workflow properly and pop into the new job having a proper record and simplify our environment while safeguarding the data at the same time? check the math on that"',
    );
    expect(unwrapped).toContain('"id like to re-explore the idea of fragment first so we dont piss anyone off forcing them to do something in order to do something else"');
    for (const named of [
      "sureCustomerMatch and findCustomerMatch",
      "(src/lib/crm/duplicates.ts)",
      "customerForInquiry (src/lib/actions/win-customer.ts)",
      "usualBillingKind (src/lib/schedule-options.ts)",
      "src/lib/sure-accept.integration.test.ts",
      "updateQuoteStatus (src/app/(app)/quotes/actions.ts",
      "src/lib/export/registry.ts",
      "WHERE THE TWO CAN STILL DIFFER",
      "ORDER.",
      "TRIM.",
      "CASE.",
      "THE BOOK.",
      "THE NEW CUSTOMER'S PHONE.",
      "NO BACKFILL.",
      "BEFORE the deploy",
      "Twice-safe",
    ]) {
      expect(sql).toContain(named);
    }
    // The twins it names are there.
    const dup = readFileSync(join(process.cwd(), "src/lib/crm/duplicates.ts"), "utf8");
    expect(dup).toMatch(/export function sureCustomerMatch\(/);
    expect(dup).toMatch(/export function findCustomerMatch\(/);
    expect(readFileSync(join(process.cwd(), "src/lib/actions/win-customer.ts"), "utf8")).toMatch(/export async function customerForInquiry\(/);
    expect(existsSync(join(process.cwd(), "src/lib/sure-accept.integration.test.ts"))).toBe(true);
    // tests/migration-0408.test.ts strips the accept function's name before it looks for the public
    // projection's: neither the header nor anything else here names that projection as a function.
    expect(sql.replace(/accept_public_quote|decline_public_quote/g, "")).not.toContain("public_quote(");
    expect(sql).not.toMatch(/function\s+(public\.)?public_quote\s*\(/i);
    // No person, street or company by name.
    expect(sql).not.toMatch(/\bErik\b/);
  });

  describe("the ground it stands on", () => {
    it("checks before it changes anything, refuses in a plain sentence, and only reads", () => {
      for (const stands of [
        "for r in select t.tbl from (values ('quotes'), ('inquiries'), ('customers'), ('jobs'), ('profiles'), ('organizations')) as t(tbl) loop",
        "if to_regclass('public.' || r.tbl) is null then",
        "if (select count(*) from pg_roles where rolname in ('anon', 'authenticated')) <> 2 then",
        "where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col and c.data_type = r.kind",
        "if v_kind is not null and v_kind <> 'text' then",
        "if v_kind is not null and v_kind <> 'uuid' then",
        "if to_regprocedure('public.usual_billing_type(uuid)') is null then",
        "if to_regprocedure('public.accept_public_quote(text)') is null then",
        "if not has_function_privilege('anon', 'public.accept_public_quote(text)', 'execute')",
        "or not has_function_privilege('authenticated', 'public.accept_public_quote(text)', 'execute') then",
      ]) {
        expect(ground).toContain(stands);
      }
      expect(noComments(ground)).not.toMatch(/\balter\b|\bcreate\b|\bdrop\b|\bgrant\b|\brevoke\b|\binsert\b|\bupdate\b|\bdelete\b/i);
      expect((noComments(ground).match(/Nothing was changed\./g) ?? []).length).toBe(10);
      // The ground runs first: nothing is added before it.
      expect(code.indexOf("do $$")).toBeLessThan(code.indexOf("add column"));
    });

    it("every column it names is added by the migration it names", () => {
      const rows = [...ground.matchAll(/^\s*\('(\w+)',\s*'(\w+)',\s*'([a-z ]+)',\s*'(\d{4})'\),?$/gm)].map((m) => ({ table: m[1], column: m[2], kind: m[3], born: m[4] }));
      expect(rows.length).toBe(17);
      const type = (k: string) => ({ text: "text", uuid: "uuid", "timestamp with time zone": "timestamptz" })[k]!;
      for (const r of rows) {
        const file = noComments(migration(`${r.born}_`));
        const altered = new RegExp(`alter table (?:public\\.)?${r.table}\\s+add column if not exists ${r.column}\\s+${type(r.kind)}\\b`, "i").test(file);
        const made = file.search(new RegExp(`create table (?:if not exists )?(?:public\\.)?${r.table}\\s*\\(`, "i"));
        const inCreate = made >= 0 && new RegExp(`^\\s*${r.column}\\s+${type(r.kind)}\\b`, "im").test(file.slice(made, file.indexOf("\n);", made)));
        const orgLoop = r.column === "org_id" && r.born === "0004" && file.includes(`'${r.table}'`) && file.includes("add column if not exists org_id uuid");
        expect(altered || inCreate || orgLoop, `${r.table}.${r.column} (${r.kind}) is not added by ${r.born}`).toBe(true);
      }
    });

    it("holds the live function to 0409's body or its own, and 0379's usual kind to its body, by the statements alone", () => {
      const makers = names.filter((n) => /function\s+(public\.)?accept_public_quote\s*\(/i.test(readFileSync(join(migrations, n), "utf8")));
      expect(makers.slice(-2)).toEqual(["0409_born_from_an_estimate.sql", "0413_who_said_yes.sql"]);
      for (const n of names.filter((x) => x >= "0410_" && x < "0413_")) expect(readFileSync(join(migrations, n), "utf8"), n).not.toContain("accept_public_quote");
      expect(statementsMd5(was.body)).toBe(M0409_MD5);
      expect(statementsMd5(accept.body)).toBe(M0413_MD5);
      const reading = `coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^${BS}n]*', '', 'g'), E' ${BS}t${BS}n${BS}r', '')), '')`;
      expect(ground).toContain(`  if ${reading}\n       not in ('${M0409_MD5}', '${M0413_MD5}') then`);
      expect(self).toContain(`  if ${reading} <> '${M0413_MD5}' then`);
      expect(count(code, M0413_MD5)).toBe(2);
      expect(count(code, M0409_MD5)).toBe(1);
      // A comment, a blank line or an indent changes neither reading.
      expect(statementsMd5(`-- a note\n${accept.body.replace(/\n/g, "\n   ")}\n\n-- another\n`)).toBe(M0413_MD5);
      // Two hyphens in the body only ever open a comment, never sit inside a string.
      const hyphened = accept.body.split("\n").filter((l) => l.includes("--"));
      expect(hyphened.length).toBeGreaterThan(40);
      for (const line of hyphened) expect(count(line.slice(0, line.indexOf("--")), "'") % 2, line).toBe(0);

      // 0379's usual_billing_type: the only maker, and its body is the one the ground check holds.
      const usualMakers = names.filter((n) => /function\s+(public\.)?usual_billing_type\s*\(/i.test(readFileSync(join(migrations, n), "utf8")));
      expect(usualMakers).toEqual(["0379_a_job_is_born_billing_the_way_this_company_bills.sql"]);
      const m0379 = migration("0379_");
      const from = m0379.indexOf("create or replace function public.usual_billing_type(p_org uuid)");
      const open = m0379.indexOf("as $$", from) + "as $$".length;
      const usualBody = m0379.slice(open, m0379.indexOf("$$", open));
      expect(statementsMd5(usualBody)).toBe(M0379_USUAL_MD5);
      expect(ground).toContain(`  if ${reading} <> '${M0379_USUAL_MD5}' then`);
      expect(ground).toContain("select p.prosrc into v_src from pg_proc p where p.oid = 'public.usual_billing_type(uuid)'::regprocedure;");
    });

    it("notes who owns the function and who may call it, and the self-check reads it back", () => {
      const reading = "'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '')";
      expect(ground).toContain(`perform set_config(\n    'cn.m0413_accept_was',\n    (select ${reading} from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure),\n    true);`);
      expect(self).toContain("v_was := current_setting('cn.m0413_accept_was', true);");
      expect(self).toContain(`select ${reading} into v_now from pg_proc p where p.oid = v_accept;`);
      expect(self).toContain("if v_now is distinct from v_was then");
    });
  });

  describe("1. who said yes: two columns, two checks, no backfill", () => {
    it("adds both columns only if they are not there, nullable, no default, the person a profile set null when it goes", () => {
      const flat = squash(noComments(columns));
      expect(flat).toContain("alter table public.quotes add column if not exists accepted_how text;");
      expect(flat).toContain("alter table public.quotes add column if not exists accepted_by uuid references public.profiles(id) on delete set null;");
      expect(flat).not.toMatch(/accepted_(how|by) [a-z]+ (not null|default)/);
      expect(columns).toContain("comment on column public.quotes.accepted_how is");
      expect(columns).toContain("comment on column public.quotes.accepted_by is");
    });

    it("adds each check by its name, only if it is not there", () => {
      const flat = squash(noComments(columns));
      expect(flat).toContain(
        "if not exists ( select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_accepted_how_known' ) then alter table public.quotes add constraint quotes_accepted_how_known check (accepted_how is null or accepted_how in ('customer_link', 'in_person', 'office')); end if;",
      );
      expect(flat).toContain(
        "if not exists ( select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_accepted_by_not_on_link' ) then alter table public.quotes add constraint quotes_accepted_by_not_on_link check (accepted_how is distinct from 'customer_link' or accepted_by is null); end if;",
      );
      expect(code.indexOf("add column if not exists accepted_how")).toBeLessThan(code.indexOf("add constraint quotes_accepted_how_known"));
    });

    it("writes no row: no backfill, no data step outside the function", () => {
      const outside = code.replace(noComments(accept.whole), "");
      const bare = outside.replace(/\$m\$[\s\S]*?\$m\$/g, "''").replace(/'(?:[^']|'')*'/g, "''");
      expect(bare).not.toMatch(/\bupdate\s+public\.|\binsert\s+into\b|\bdelete\s+from\b|\btruncate\b/i);
    });
  });

  describe("2. accept_public_quote: 0409's body, and only the four changes", () => {
    it("the same door: its signature, its language, its security and its search path; no grant, revoke or owner here", () => {
      const head = "create or replace function public.accept_public_quote(p_token text)\nreturns json\nlanguage plpgsql\nsecurity definer\nset search_path to 'public'\nas $function$";
      expect(was.whole.startsWith(head)).toBe(true);
      expect(accept.whole.startsWith(head)).toBe(true);
      expect(accept.whole.endsWith("\nend $function$")).toBe(true);
      expect(code).not.toMatch(/^\s*grant\b/im);
      expect(code).not.toMatch(/^\s*revoke\b/im);
      expect(code).not.toMatch(/\balter function\b|\bowner to\b/i);
      expect((code.match(/security definer/gi) ?? []).length).toBe(1);
      expect([...code.matchAll(/create (?:or replace )?function\s+([\w.]+)/gi)].map((m) => m[1])).toEqual(["public.accept_public_quote"]);
      for (const n of names) expect(readFileSync(join(migrations, n), "utf8"), n).not.toMatch(/revoke[^;]*accept_public_quote/i);
    });

    it("cut the changed blocks out of 0409's body and out of this one: what is left is the same, to the character", () => {
      let old = was.whole;
      let now = accept.whole;
      for (const [i, ch] of CHANGES.entries()) {
        expect(count(old, ch.was), `0409 has the ${ch.part} block once`).toBe(1);
        expect(count(now, ch.now), `0413 has the ${ch.part} block once`).toBe(1);
        old = old.replace(ch.was, () => `<<${i}>>`);
        now = now.replace(ch.now, () => `<<${i}>>`);
      }
      expect(now).toBe(old);
      // Each statement change carries a comment that names 0413 and its letter; the comment's wording
      // is the one change that is not a statement.
      for (const ch of CHANGES.slice(0, 4)) expect(ch.now, ch.part).toContain(`-- 0413: (${ch.part[0]})`);
      const line = (whole: string, frag: string) => whole.split("\n").find((l) => l.includes(frag.trim()))!;
      expect(line(was.whole, CHANGES[5].was).trim().startsWith("-- ")).toBe(true);
      expect(line(accept.whole, CHANGES[5].now).trim().startsWith("-- ")).toBe(true);
      // The 0413 marks are exactly these four.
      expect(count(accept.body, "-- 0413: (")).toBe(4);
      expect(count(accept.body, "0413")).toBe(4);
    });

    it("a: the lead is read in the estimate's company; every other read in the function already was", () => {
      const body = noComments(accept.body);
      expect(body).toContain("select * into inq from public.inquiries where id = q.inquiry_id and org_id = q.org_id;");
      // Every FROM of a table names the estimate's company, or is keyed on the estimate itself.
      for (const m of body.matchAll(/from public\.(\w+)( \w+)?\s+where ([^;]*?);/g)) {
        const where = m[3];
        expect(/org_id = q\.org_id|o\.id = q\.org_id|public_token = p_token|id = q\.id\b/.test(where), `${m[0]}`).toBe(true);
      }
      expect(body).toContain("select o.settings->>'timezone' into org_tz from public.organizations o where o.id = q.org_id;");
    });

    it("b: the lead's own customer first, then a phone, then an e-mail, then a sure name; the any-name arm is gone", () => {
      const body = noComments(accept.body);
      const steps = [
        "if inq.customer_id is not null then",
        "if cust_id is null and length(inq_phone) >= 7 then",
        "if cust_id is null and inq_email <> '' then",
        "if cust_id is null and inq_name <> '' and inq_name <> 'unknowncaller' and inq_name !~ '^[0-9]+$' then",
        "    if cust_id is null then\n      insert into public.customers",
      ].map((s) => body.indexOf(s));
      expect(steps.every((i) => i > 0)).toBe(true);
      expect(steps).toEqual([...steps].sort((a, b) => a - b));
      // The keys are set after the lead's own customer is read and before the phone is asked.
      expect(body.indexOf("inq_phone := right(")).toBeGreaterThan(steps[0]);
      expect(body.indexOf("inq_phone := right(")).toBeLessThan(steps[1]);
      // ASCII digits only, never the locale's class.
      expect(body).not.toContain(`'${BS}D'`);
      expect(count(body, "'[^0-9]'")).toBe(4);
      // Every customer read is in the estimate's company.
      expect(count(body, "from public.customers c")).toBe(4);
      expect(count(body, "where c.org_id = q.org_id")).toBe(3);
      expect(body).toContain("where c.id = inq.customer_id and c.org_id = q.org_id;");
      // Ties: the oldest record, then its id.
      expect(count(body, "order by c.created_at, c.id")).toBe(2);
      expect(body).not.toContain("order by c.created_at asc");
      expect(body).not.toContain("or (inq_name <> '' and regexp_replace(");
      // The insert of a new customer, the link of the lead and of the estimate: as 0409 had them.
      const tail = (b: string) => b.slice(b.indexOf("    if cust_id is null then\n      insert into public.customers"), b.indexOf("  -- A REVISION TAKES THE ORIGINAL'S JOB"));
      expect(tail(accept.body)).toBe(tail(was.body));
      expect(tail(accept.body).length).toBeGreaterThan(1000);
    });

    it("c: the guarded flip says the customer accepted on their link and names nobody", () => {
      const body = noComments(accept.body);
      expect(squash(body)).toContain("update public.quotes set status = 'accepted', accepted_at = now(), accepted_how = 'customer_link', accepted_by = null where id = q.id and status = 'sent';");
      expect(count(body, "accepted_how")).toBe(1);
      expect(count(body, "accepted_by")).toBe(1);
      // The early answer for an estimate already accepted writes nothing: a second tap changes nothing.
      expect(accept.body.indexOf("if q.status = 'accepted' then\n    return json_build_object('ok', true);")).toBeLessThan(accept.body.indexOf("update public.quotes set status = 'accepted'"));
    });

    it("d: the job names its billing kind through 0379's usual_billing_type, in the estimate's company", () => {
      const insert = noComments(accept.body).slice(noComments(accept.body).indexOf("insert into public.jobs ("), noComments(accept.body).indexOf("returning id into new_job;"));
      const cols = insert.slice(insert.indexOf("(") + 1, insert.indexOf(")")).split(",").map((s) => s.trim());
      expect(cols).toEqual(["org_id", "customer_id", "inquiry_id", "name", "status", "billing_type", "address", "unit", "city", "state", "zip", "description", "created_by"]);
      expect(insert).toContain("'to_be_scheduled',\n            public.usual_billing_type(q.org_id),\n            site_address,");
      expect(count(noComments(accept.body), "usual_billing_type")).toBe(1);
      // 0379's function is the app's usualBillingKind: more fixed than tm is fixed; a tie and none are tm.
      const m0379 = noComments(migration("0379_"));
      expect(squash(m0379)).toContain(
        "select case when (select count(*) from public.jobs where org_id = p_org and billing_type = 'fixed') > (select count(*) from public.jobs where org_id = p_org and billing_type = 'tm') then 'fixed' else 'tm' end;",
      );
      const sqlKind = (tm: number, fixed: number) => (fixed > tm ? "fixed" : "tm");
      for (const [tm, fixed] of [[0, 0], [1, 1], [2, 1], [1, 2], [0, 3], [27, 9]]) expect(usualBillingKind({ tm, fixed }), `${tm} tm, ${fixed} fixed`).toBe(sqlKind(tm, fixed));
    });

    it("what the earlier makers put there still reads as the readers of the latest definer want it", () => {
      expect(sql).toMatch(/public\.job_name_from\(null, q\.title,/);
      expect(sql).toMatch(/case when coalesce\(site_address, ''\) <> '' then site_unit else cust\.unit end,\s*inq\.name,/);
      expect(noComments(sql.slice(sql.indexOf(ACCEPT)))).not.toMatch(/'Job from '/);
      expect(count(noComments(accept.body), "set job_id = new_job where id = q.id and job_id is null")).toBe(2);
      expect(accept.body).toContain("scope_for_job");
    });
  });

  describe("the self-check", () => {
    it("proves the columns, the checks, the door, the marks of every maker, the four changes, and that it runs", () => {
      for (const proof of [
        "column_name = 'accepted_how' and data_type = 'text' and is_nullable = 'YES' and column_default is null",
        "column_name = 'accepted_by' and data_type = 'uuid' and is_nullable = 'YES' and column_default is null",
        "k.confrelid = 'public.profiles'::regclass and k.confdeltype = 'n'",
        "k.conname = 'quotes_accepted_how_known'",
        "k.conname = 'quotes_accepted_by_not_on_link'",
        "or position('accepted_how is distinct from ''customer_link''::text' in v_def) = 0",
        "or (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = v_accept) <> 'plpgsql'",
        "or (select p.prorettype from pg_proc p where p.oid = v_accept) <> 'json'::regtype",
        "or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = v_accept), false) then",
        "if not has_function_privilege('anon', v_accept, 'execute') or not has_function_privilege('authenticated', v_accept, 'execute') then",
        "if (length(v_src) - length(replace(v_src, guard, ''))) / length(guard) <> 2 then",
        "if (public.accept_public_quote('0413 self-check: no estimate has this token') ->> 'ok') is distinct from 'false' then",
        "if public.usual_billing_type('00000000-0000-0000-0000-000000000000'::uuid) is distinct from 'tm' then",
      ]) {
        expect(self).toContain(proof);
      }
      // Every mark the self-check looks for in the stored body IS in this file's body; the marks of
      // the arm it replaced are NOT.
      const marks = [...self.matchAll(/^\s*\('(\w+)', ('(?:[^']|'')*'|\$m\$[\s\S]*?\$m\$)\),?$/gm)].map((m) => ({
        part: m[1],
        mark: m[2].startsWith("$m$") ? m[2].slice(3, -3) : m[2].slice(1, -1).split("''").join("'"),
      }));
      expect(marks.length).toBe(21);
      for (const m of marks) expect(accept.body, `${m.part}: ${m.mark}`).toContain(m.mark);
      expect(marks.filter((m) => /^\d{4}$/.test(m.part)).map((m) => m.part)).toEqual(["0392", "0392", "0396", "0396", "0369", "0409", "0409", "0409", "0409"]);
      expect(marks.filter((m) => /^[abcd]$/.test(m.part)).map((m) => m.part).sort().join("")).toBe("abbbbbbbbcdd");
      for (const gone of ["or (inq_name <> '' and regexp_replace(", "order by c.created_at asc", `'${BS}D'`]) {
        expect(accept.body).not.toContain(gone);
        expect(was.body).toContain(gone);
      }
      expect(self).toContain("if position('or (inq_name <> '''' and regexp_replace(' in v_src) > 0");
      expect(self).toContain("or position('order by c.created_at asc' in v_src) > 0");
      expect(self).toContain(`or position($m$'${BS}D'$m$ in v_src) > 0 then`);
    });

    it("every RAISE has as many arguments as places, every refusal names 0413, and all but one say nothing was changed", () => {
      const raises = [...sql.matchAll(/raise\s+(?:exception|notice)\s+'((?:[^']|'')*)'([^;]*);/g)];
      expect(raises.length).toBe(count(code, "raise exception") + count(code, "raise notice"));
      for (const m of raises) {
        const places = count(m[1].split("%%").join(""), "%");
        let depth = 0;
        let quoted = false;
        let args = 0;
        let cur = "";
        for (const ch of m[2]) {
          if (ch === "'") quoted = !quoted;
          if (!quoted && ch === "(") depth++;
          if (!quoted && ch === ")") depth--;
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
      const refusals = [...code.matchAll(/raise exception '((?:[^']|'')*)'/g)].map((m) => m[1]);
      expect(refusals.length).toBe(25);
      for (const r of refusals) expect(r.startsWith("0413: ")).toBe(true);
      const silent = refusals.filter((r) => !r.endsWith("Nothing was changed."));
      expect(silent).toHaveLength(1);
      expect(silent[0]).toMatch(/^0413: this file has to run in ONE transaction/);
      for (const tag of ["$$", "$m$", "$function$"]) expect(count(sql, tag) % 2, tag).toBe(0);
    });

    it("no statement hides a character: plain ASCII everywhere outside the comments", () => {
      const odd: string[] = [];
      sql.split("\n").forEach((line, i) => {
        const bad = [...line.replace(/--.*$/, "")].filter((ch) => ch.codePointAt(0)! > 0x7e || ch.codePointAt(0)! < 0x20);
        if (bad.length) odd.push(`line ${i + 1}`);
      });
      expect(odd).toEqual([]);
      expect(sql).not.toContain(NBSP);
    });
  });

  it("the company export carries both columns (records, not secrets)", () => {
    const quotes = EXPORT_TABLES.find((t) => t.table === "quotes")!;
    expect(quotes.columns).toEqual(expect.arrayContaining(["accepted_at", "accepted_how", "accepted_by"]));
  });

  it("does nothing else: two columns, two checks, two comments, one function; no table, policy, trigger, index or type", () => {
    const statements = code
      .replace(/do \$\$[\s\S]*?end \$\$;/g, "")
      .replace(/as \$function\$[\s\S]*?end \$function\$;/g, "as $f$;")
      .replace(/'(?:[^']|'')*'/g, "''")
      .split(";")
      .map((s) => squash(s))
      .filter(Boolean);
    expect(statements.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual([
      "set local lock_timeout",
      "set local statement_timeout",
      "alter table public.quotes",
      "alter table public.quotes",
      "comment on column",
      "comment on column",
      "create or replace",
    ]);
    expect((code.match(/\bdo \$\$/g) ?? []).length).toBe(3);
    expect(code).not.toMatch(/create (?:temp )?table|drop table|create policy|drop policy|create (?:or replace )?trigger|drop trigger|create index|drop index|create type|create extension|drop column|alter column|drop constraint/i);
    expect((code.match(/add column/gi) ?? []).length).toBe(2);
    expect((code.match(/add constraint/gi) ?? []).length).toBe(2);
  });
});

// ── THE MATCH, the app's and the SQL's, side by side ───────────────────────────────────────────────
type Book = (DupCustomer & { created_at: string })[];
type Lead = { name: string | null; phone: string | null; email: string | null; customer_id: string | null };

/** The SQL's steps, read line by line from 0413 (b) and written out here so the table below can say
 *  the SQL's answer and have it checked: the lead's own customer in this company; a phone (the last ten
 *  ASCII digits, seven at least), oldest then id; an e-mail (lower, btrim of the plain space), oldest
 *  then id; a name only when sure. null = a NEW customer. The database suite asks the database. */
function sqlReading(lead: Lead, book: Book): string | null {
  const digits = (s: string | null) => (s ?? "").replace(/[^0-9]/g, "").slice(-10);
  const email = (s: string | null) => (s ?? "").toLowerCase().replace(/^ +| +$/g, "");
  const name = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const oldest = (xs: Book) => [...xs].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))[0];
  if (lead.customer_id && book.some((c) => c.id === lead.customer_id)) return lead.customer_id;
  const p = digits(lead.phone);
  const e = email(lead.email);
  const n = name(lead.name);
  if (p.length >= 7) {
    const hits = book.filter((c) => digits(c.phone) === p);
    if (hits.length) return oldest(hits).id;
  }
  if (e !== "") {
    const hits = book.filter((c) => email(c.email) === e);
    if (hits.length) return oldest(hits).id;
  }
  if (n !== "" && n !== "unknowncaller" && !/^[0-9]+$/.test(n)) {
    const hits = book.filter((c) => name(c.name) === n);
    if (hits.length === 1) {
      const c = hits[0];
      const onPhone = digits(c.phone);
      const onEmail = email(c.email);
      const contradicts = (p.length >= 7 && onPhone.length >= 7 && onPhone !== p) || (e !== "" && onEmail !== "" && onEmail !== e);
      if (!contradicts) return c.id;
    }
  }
  return null;
}
/** The app's office door (customerForInquiry): the lead's own customer, else sureCustomerMatch over the
 *  book in the order it was read. */
const appAnswer = (lead: Lead, book: Book) => lead.customer_id ?? sureCustomerMatch(lead, book)?.id ?? null;

const person = (id: string, name: string, created_at: string, o: { phone?: string; email?: string } = {}) => ({
  id,
  name,
  company_name: null,
  phone: o.phone ?? null,
  email: o.email ?? null,
  created_at,
});
const OLD = "2026-01-01T00:00:00Z";
const NEW = "2026-06-01T00:00:00Z";

/** want = the SQL's answer, said in full; app = the office door's. They differ only where the header
 *  says they can (ORDER, TRIM), and each such row says which. */
const CASES: { why: string; book: Book; lead: Lead; want: string | null; app: string | null }[] = [
  {
    why: "a same-name stranger with another phone: a NEW customer",
    book: [person("c1", "Sam Tillery", OLD, { phone: "530-555-0101" })],
    lead: { name: "Sam Tillery", phone: "(530) 555-0199", email: null, customer_id: null },
    want: null,
    app: null,
  },
  {
    why: "a phone match under another spelling is taken",
    book: [person("c1", "Dana Rook", OLD, { phone: "(530) 555-0102" })],
    lead: { name: "Dana R.", phone: "+1 530.555.0102", email: null, customer_id: null },
    want: "c1",
    app: "c1",
  },
  {
    why: "a phone on a younger record wins over an older stranger of the same name",
    book: [person("c1", "Theo Vance", OLD, { phone: "530-555-0103" }), person("c2", "Theo Vance", NEW, { phone: "530-555-0104" })],
    lead: { name: "Theo Vance", phone: "5305550104", email: null, customer_id: null },
    want: "c2",
    app: "c2",
  },
  {
    why: "an e-mail match is taken, case and plain spaces aside",
    book: [person("c1", "Casey Loam", OLD, { email: "casey.loam@example.test" })],
    lead: { name: "C. Loam", phone: null, email: "  Casey.Loam@Example.TEST ", customer_id: null },
    want: "c1",
    app: "c1",
  },
  {
    why: "the only such name, with nothing on file to contradict it, is taken",
    book: [person("c1", "Dana Rook", OLD)],
    lead: { name: "dana  rook", phone: "530-555-0105", email: "dana@example.test", customer_id: null },
    want: "c1",
    app: "c1",
  },
  {
    why: "two of the same name: a NEW customer",
    book: [person("c1", "Sam Tillery", OLD), person("c2", "Sam Tillery", NEW)],
    lead: { name: "Sam Tillery", phone: null, email: null, customer_id: null },
    want: null,
    app: null,
  },
  {
    why: "an e-mail on file that contradicts the lead's: a NEW customer",
    book: [person("c1", "Casey Loam", OLD, { email: "casey@example.test" })],
    lead: { name: "Casey Loam", phone: null, email: "other.casey@example.test", customer_id: null },
    want: null,
    app: null,
  },
  {
    why: "Unknown caller is a placeholder, never a name: a NEW customer",
    book: [person("c1", "Unknown caller", OLD)],
    lead: { name: "Unknown Caller", phone: null, email: null, customer_id: null },
    want: null,
    app: null,
  },
  {
    why: "a name of digits alone is a placeholder: a NEW customer",
    book: [person("c1", "530-555-0111", OLD)],
    lead: { name: "530 555 0111", phone: null, email: null, customer_id: null },
    want: null,
    app: null,
  },
  {
    why: "a phone of fewer than seven digits links nobody",
    book: [person("c1", "Theo Vance", OLD, { phone: "555-01" })],
    lead: { name: "T. Vance", phone: "555-01", email: null, customer_id: null },
    want: null,
    app: null,
  },
  {
    why: "a lead already tied to a customer keeps it, even when its phone is another record's",
    book: [person("c1", "Casey Loam", OLD), person("c2", "Dana Rook", OLD, { phone: "530-555-0106" })],
    lead: { name: "Casey Loam", phone: "530-555-0106", email: null, customer_id: "c1" },
    want: "c1",
    app: "c1",
  },
  {
    why: "ORDER (said in the header): the phone on one record, the e-mail on an older one read first",
    book: [person("c1", "Dana Rook", OLD, { email: "dana@example.test" }), person("c2", "Dana Rook", NEW, { phone: "530-555-0107" })],
    lead: { name: "Dana Rook", phone: "530-555-0107", email: "dana@example.test", customer_id: null },
    want: "c2",
    app: "c1",
  },
  {
    why: "TRIM (said in the header): a pasted no-break space at the end of the lead's e-mail",
    book: [person("c1", "Casey Loam", OLD, { email: "casey@example.test" })],
    lead: { name: "Casey Loam", phone: null, email: `casey@example.test${NBSP}`, customer_id: null },
    want: null,
    app: "c1",
  },
];

describe("the match: the app's office door and the customer's Accept, side by side", () => {
  it("each case: the app's answer, and the SQL's answer as 0413's steps give it", () => {
    for (const k of CASES) {
      expect({ why: k.why, app: appAnswer(k.lead, k.book) }).toEqual({ why: k.why, app: k.app });
      expect({ why: k.why, sql: sqlReading(k.lead, k.book) }).toEqual({ why: k.why, sql: k.want });
    }
    // They differ only on the two rows the header names.
    expect(CASES.filter((k) => k.want !== k.app).map((k) => k.why.split(" ")[0])).toEqual(["ORDER", "TRIM"]);
  });
});
