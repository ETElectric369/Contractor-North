import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ESTIMATE_FORMATS } from "@/lib/doc-style";
import { coerceTaskDetail, partMoney, taskMoney } from "@/lib/estimate/task-lines";

/**
 * ONE MATERIALS LINE UNDER EACH TASK (0408; cn-v1158 — Erik, 2026-11-10: "an option to list out all the
 * materials shown as it is now and an option to group the materials into one materials line as im
 * finding that different people require different solutions"), read from the migration file the way
 * migration-0407.test.ts reads 0407. Three things and nothing else:
 *   1. the check on quotes.estimate_format takes a third word, 'grouped' — found by what it reads,
 *      never by an assumed name;
 *   2. public.task_parts_total(jsonb), the SQL twin of taskMoney(detail).parts, callable only inside
 *      the database;
 *   3. public.public_quote replaced from 0395's body (the last migration that made it) with the format
 *      resolved once, the resolved word on the quote object, the 'detailed' arm word for word, and a
 *      'grouped' arm that ships the labor and ONE figure for the parts, never a part.
 * NO DATABASE RUNS HERE. What this file can prove is the text, and that the arithmetic the text
 * describes is the app's: the self-check's own cases are run through taskMoney, and the formula is
 * fuzzed against partMoney. That the SQL does what it says is the DB suite's
 * (src/lib/estimate/one-materials-line.integration.test.ts) and the migration's own self-check.
 * Applied migrations are immutable: 0408 is pinned the day it is applied.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const names = readdirSync(migrations).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
const migration = (prefix: string) => {
  const f = names.find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};
/** The statements alone, without the header's words. */
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const count = (s: string, needle: string) => s.split(needle).length - 1;

const PUBLIC_QUOTE = "create or replace function public.public_quote(p_token text)";
/** A function's text from its header to the `$$;` that closes it, and the body between the quotes. */
const fnText = (sql: string, header: string) => {
  const at = sql.indexOf(header);
  if (at < 0) throw new Error(`no ${header}`);
  const open = sql.indexOf("as $$", at) + "as $$".length;
  const close = sql.indexOf("$$", open);
  return { whole: sql.slice(at, close + 2), body: sql.slice(open, close) };
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
/** A body's statement lines: comment lines dropped, nothing else touched. */
const statementLines = (body: string) => body.split("\n").filter((l) => !/^\s*--/.test(l));

describe("migration 0408: one Materials line under each task", () => {
  const sql = migration("0408_");
  const code = noComments(sql);
  const m0395 = migration("0395_");
  const quote = fnText(sql, PUBLIC_QUOTE);
  const quoteCode = noComments(quote.body);
  const total = fnText(sql, "create or replace function public.task_parts_total(p_detail jsonb)");

  it("is the one 0408 (what sits past it is the newest migration's own test: migration-0409.test.ts)", () => {
    expect(names.filter((n) => n.startsWith("0408_"))).toEqual(["0408_one_materials_line_under_each_task.sql"]);
  });

  it("names itself, quotes the owner, runs under the house timeouts, and opens no transaction of its own", () => {
    expect(sql).toContain("migration 0408: one Materials line under each task");
    expect(sql).toContain("an option to group the materials into one materials line as");
    expect(sql).toContain('ONE "Materials" line UNDER EACH TASK');
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0408: one Materials line under each task/);
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(30);
    // The runner wraps the file in ONE transaction: no begin / commit / rollback statement here
    // (a plpgsql block's own `begin` has no semicolon).
    expect(code).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\b[^;\n]*;/im);
    expect(code).not.toMatch(/\bsavepoint\b/i);
  });

  it("checks its ground before it touches anything, and refuses in a plain sentence", () => {
    const ground = sql.slice(sql.indexOf("-- ── The ground it stands on"), sql.indexOf("-- ── 1. The check accepts the third word"));
    expect(ground.length).toBeGreaterThan(1500);
    for (const stands of [
      "if to_regclass('public.quotes') is null then",
      "if to_regclass('public.quote_line_items') is null then",
      "if to_regclass('public.organizations') is null then",
      "if (select count(*) from pg_roles where rolname in ('anon', 'authenticated')) <> 2 then",
      "table_name = 'quote_line_items' and column_name = 'detail' and data_type = 'jsonb'",
      "table_name = 'quotes' and column_name = 'estimate_format' and data_type = 'text'",
      "if to_regprocedure('public.public_quote(text)') is null then",
      "if not has_function_privilege('anon', 'public.public_quote(text)', 'execute')",
      "or not has_function_privilege('authenticated', 'public.public_quote(text)', 'execute') then",
    ]) {
      expect(ground).toContain(stands);
    }
    // Nothing is changed inside the ground check: it only reads (and notes the grants for later).
    expect(noComments(ground)).not.toMatch(/\balter\b|\bcreate\b|\bdrop\b|\bgrant\b|\brevoke\b|\binsert\b|\bupdate\b|\bdelete\b/i);
    // What it stands on was born where it says.
    expect(m0395).toContain("alter table public.quotes add column if not exists estimate_format text null check (estimate_format in ('tasks','detailed'));");
    expect(migration("0386_")).toContain("alter table public.quote_line_items add column if not exists detail jsonb;");
  });

  it("finds the check by what it reads — 0395 never named it — and refuses a row outside the words it allows", () => {
    // 0395's check is inline and unnamed, so the name is Postgres's to give: it is read, not assumed.
    expect(m0395).not.toMatch(/constraint\s+\w*estimate_format\w*\s+check/i);
    // The columns a check reads, by name — the expression 0401's self-check already ran on the database.
    const reads = "(select array_agg(a.attname::text) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array[";
    expect(migration("0401_")).toContain(`${reads}'stripe_session_id']`);
    const finder = `where c.conrelid = 'public.quotes'::regclass and c.contype = 'c'\n     and ${reads}'estimate_format']`;
    expect(sql).toContain(`select count(*), min(pg_get_constraintdef(c.oid)) into v_n, v_def\n    from pg_constraint c\n   ${finder};`);
    // The ground check, the swap and the self-check all find it the same way.
    expect(count(sql, finder)).toBe(3);
    expect(sql).toContain("if v_n <> 1 then");
    // The words come out of the live definition…
    expect(sql).toContain("from regexp_matches(v_def, '''([^'']*)''', 'g') as w;");
    expect(sql).toContain("if v_words <> array['detailed', 'tasks'] and v_words <> array['detailed', 'grouped', 'tasks'] then");
    // …and no stored word may sit outside them (on a first run: the two old words).
    expect(sql).toContain("where estimate_format is not null and estimate_format <> all (v_words);");
    expect(sql).toContain("if v_bad > 0 then");
    // The drop names whatever the catalog said; the name is never typed into a drop.
    expect(sql).toContain("execute format('alter table public.quotes drop constraint %I', v_name);");
    expect(code).not.toMatch(/drop constraint (if exists )?quotes_/i);
    expect(count(code, "drop constraint")).toBe(1);
  });

  it("the check takes the three words the app knows, and no row is rewritten", () => {
    expect(sql).toContain(
      "alter table public.quotes\n    add constraint quotes_estimate_format_check check (estimate_format in ('tasks','detailed','grouped'));",
    );
    const words = [...sql.match(/add constraint quotes_estimate_format_check check \(estimate_format in \(([^)]*)\)\)/)![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(words).toEqual([...ESTIMATE_FORMATS]);
    expect(words).toEqual(["tasks", "detailed", "grouped"]);
    // A second run leaves the three-word check where it is.
    expect(sql).toContain("if v_name = 'quotes_estimate_format_check' and position('''grouped''' in v_def) > 0 then\n    return;");
    // No data step: nothing is inserted, updated or deleted, and the column is not touched.
    expect(code).not.toMatch(/\bupdate public\.\w+\s+set\b/i);
    expect(code).not.toMatch(/\binsert into\b|\bdelete from\b/i);
    expect(code).not.toMatch(/alter column|add column|drop column|set not null|set default/i);
    expect(count(code, "alter table")).toBe(2); // the drop (inside execute format) and the add
    expect(code).not.toMatch(/alter table public\.(?!quotes\b)/i);
  });

  it("0395 is the last migration that made public_quote, and the ground check holds the live body to it", () => {
    const makers = names.filter((n) => /function\s+(public\.)?public_quote\s*\(/i.test(readFileSync(join(migrations, n), "utf8")));
    expect(makers.slice(-2)).toEqual(["0395_a_task_has_labor_rows.sql", "0408_one_materials_line_under_each_task.sql"]);
    const between = names.filter((x) => x >= "0396_" && x < "0408_");
    expect(between.length).toBe(12); // 0396 … 0407
    for (const n of between) {
      const text = readFileSync(join(migrations, n), "utf8").replace(/accept_public_quote|decline_public_quote/g, "");
      expect(text, n).not.toContain("public_quote");
    }
    // The md5 the ground check compares the live body with IS 0395's body (statements only).
    const want = statementsMd5(fnText(m0395, PUBLIC_QUOTE).body);
    expect(want).toBe("ad93e87a89404dcaa57e3898d742e245");
    // …or, on a second run, exactly this file's own: never a body a later migration made, which a
    // stray re-run of this file would otherwise put back to what it was on the day of 0408.
    const mine = statementsMd5(quote.body);
    expect(mine).not.toBe(want);
    const reading = "coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\\n]*', '', 'g'), E' \\t\\n\\r', '')), '')";
    expect(sql).toContain(`  if ${reading}\n       not in ('${want}', '${mine}') then`);
    expect(sql).toContain("select p.prosrc into v_src from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure;");
    // The self-check reads the body it just stored the same way and wants this file's own md5: that
    // is what proves, on the first run, that a second run will pass the ground check.
    expect(sql).toContain(`  if ${reading} <> '${mine}' then`);
    expect(count(sql, reading)).toBe(2);
    expect(count(code, mine)).toBe(2);
    expect(count(code, want)).toBe(1);
    // The hashes are of statements only: a comment, a blank line or an indent changes neither.
    expect(statementsMd5(`-- a note\n${quote.body.replace(/\n/g, "\n\t ")}\n\n   -- another\n`)).toBe(mine);
    expect(quote.body).toContain("'estimate_format', fmt.word");
    expect(fnText(m0395, PUBLIC_QUOTE).body).not.toContain("fmt.word");
    // In both bodies two hyphens only ever open a whole-line comment (never sit inside a string or
    // after a statement), so taking comments out cannot eat a statement: the hash covers every one.
    for (const body of [fnText(m0395, PUBLIC_QUOTE).body, quote.body]) {
      const hyphened = body.split("\n").filter((l) => l.includes("--"));
      expect(hyphened.length).toBeGreaterThan(5);
      for (const line of hyphened) expect(line).toMatch(/^\s*--/);
    }
  });

  describe("public.task_parts_total: the parts of one task, added up as the app adds them", () => {
    it("one pure function of the breakdown, pinned and private", () => {
      expect(total.whole).toContain(
        "create or replace function public.task_parts_total(p_detail jsonb)\nreturns numeric\nlanguage sql\nimmutable\nset search_path = public\nas $$",
      );
      expect(total.whole).not.toMatch(/security definer/i);
      expect(noComments(total.body)).not.toMatch(/\bfrom\s+public\./i); // it reads its argument, never a table
      expect(sql).toContain("revoke all on function public.task_parts_total(jsonb) from public, anon, authenticated;");
      // The same three it is revoked from as 0369's helpers.
      expect(migration("0369_")).toMatch(/revoke all on function public\.job_name_key\(text\) from public, anon, authenticated;/);
      expect(sql).toContain("comment on function public.task_parts_total(jsonb) is");
      expect(code).not.toMatch(/grant [^;]*task_parts_total/i);
    });

    it("mirrors `named` and partMoney, and says why the two roundings are one", () => {
      const body = noComments(total.body);
      // named: `name` is a string with something in it once trimmed.
      expect(body).toContain("where jsonb_typeof(m) = 'object'");
      expect(body).toContain("and jsonb_typeof(m->'name') = 'string'");
      expect(body).toMatch(/and btrim\(m->>'name', E'[^']+'\) <> ''/);
      // partMoney: each figure to two places, multiplied, to two places; a hole or a figure below zero is 0.
      expect(body).toContain("round(greatest(case when jsonb_typeof(m->'qty')  = 'number' then (m->>'qty')::numeric  else 0 end, 0), 2)");
      expect(body).toContain("* round(greatest(case when jsonb_typeof(m->'sell') = 'number' then (m->>'sell')::numeric else 0 end, 0), 2),");
      expect(body.replace(/\s+/g, " ")).toMatch(/select coalesce\(sum\(round\( round\(greatest\(.*\* round\(greatest\(.*, 2\)\), 0\) from jsonb_array_elements\(/);
      expect(body).toContain("case when jsonb_typeof(p_detail->'materials') = 'array' then p_detail->'materials' else '[]'::jsonb end");
      // It reads a part's name only to ask whether there is one, and its count and price: nothing else.
      expect([...body.matchAll(/m->>?'([a-z_]+)'/g)].map((x) => x[1]).sort()).toEqual(["name", "name", "qty", "qty", "sell", "sell"]);
      // The comment the next reader needs: numeric rounds a half away from zero, Math.round a half up.
      const says = sql.slice(sql.indexOf("-- ── 2. The parts of one task, added up"), sql.indexOf("create or replace function public.task_parts_total"));
      expect(says).toContain("taskMoney(detail).parts");
      expect(says).toContain("AWAY FROM ZERO");
      expect(says).toContain("Math.round rounds a half UP");
      expect(says).toContain("never below");
      expect(says).toContain("m.name.trim().length > 0");
    });

    it("trims exactly what JavaScript's trim() trims — no more, no fewer", () => {
      const lit = total.body.match(/btrim\(m->>'name', E'([^']+)'\)/)![1];
      const sqlSet = new Set<number>();
      for (let i = 0; i < lit.length; i++) {
        if (lit[i] !== "\\") {
          sqlSet.add(lit.codePointAt(i)!);
          continue;
        }
        const e = lit[i + 1];
        if (e === "u") {
          sqlSet.add(parseInt(lit.slice(i + 2, i + 6), 16));
          i += 5;
        } else if (e === "x") {
          sqlSet.add(parseInt(lit.slice(i + 2, i + 4), 16));
          i += 3;
        } else {
          const one: Record<string, number> = { t: 9, n: 10, f: 12, r: 13 };
          expect(one[e], `an escape Postgres does not know: \\${e}`).toBeDefined();
          sqlSet.add(one[e]);
          i += 1;
        }
      }
      const jsSet = new Set<number>();
      for (let cp = 0; cp <= 0x10ffff; cp++) if (String.fromCodePoint(cp).trim() === "") jsSet.add(cp);
      expect([...sqlSet].sort((a, b) => a - b)).toEqual([...jsSet].sort((a, b) => a - b));
      expect(sqlSet.size).toBe(25);
      // Written as escapes, never as the characters themselves: the literal is plain ASCII.
      expect(/^[\x20-\x7e]+$/.test(lit)).toBe(true);
    });

    it("no statement line hides a character: plain ASCII everywhere but the notice's dash", () => {
      // An invisible space or a line separator pasted into a statement reads the same on a screen and
      // not to Postgres. (The first draft of this file had the trim set as the characters themselves.)
      const odd: string[] = [];
      sql.split("\n").forEach((line, i) => {
        if (/^\s*--/.test(line)) return;
        const bad = [...line].filter((c) => c.codePointAt(0)! > 0x7e || c.codePointAt(0)! < 0x20);
        if (bad.length) odd.push(`line ${i + 1}: ${bad.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`);
      });
      expect(odd).toHaveLength(1);
      expect(odd[0]).toMatch(/: U\+2014$/);
      const noticeAt = sql.split("\n").findIndex((l) => l.includes("raise notice '0408:"));
      expect(odd[0].startsWith(`line ${noticeAt + 1}:`)).toBe(true);
      // The self-check's no-break space is the JSON escape, six plain characters.
      const BS = String.fromCharCode(92); // a backslash, spelled so no tool can read an escape into this line
      expect(sql).toContain('{"name":"' + BS + 't","qty":1,"sell":5},{"name":"' + BS + 'u00a0 ","qty":1,"sell":5}');
    });

    /** The self-check's own table, as written: (why, the stored breakdown, the figure it demands). */
    const cases = [...sql.matchAll(/^\s*\('([^']*)', '(\{[^']*\})'::jsonb, (-?\d+(?:\.\d+)?)\),?$/gm)].map((m) => ({
      why: m[1],
      detail: JSON.parse(m[2]) as unknown,
      want: Number(m[3]),
    }));

    it("the self-check's cases are the app's answers: each stored breakdown, read by the one reader and added by taskMoney", () => {
      expect(cases.length).toBe(14);
      for (const k of cases) {
        const d = coerceTaskDetail(k.detail);
        expect(d, k.why).not.toBeNull();
        expect({ why: k.why, parts: taskMoney(d!).parts }).toEqual({ why: k.why, parts: k.want });
      }
      // The cases the wave asked for by name are there, by their figures.
      const by = (re: RegExp) => cases.find((k) => re.test(k.why))!;
      expect(by(/^2\.5 at 1\.99/).want).toBe(4.98);
      expect(by(/rounded first/).want).toBe(10.38);
      expect(by(/no name is not counted/).want).toBe(3.99);
      expect(by(/null count/).want).toBe(0);
      expect(by(/null price/).want).toBe(0);
      expect(by(/^no parts is 0/).want).toBe(0);
      expect(sql).toContain("if public.task_parts_total(r.detail) is distinct from r.want then");
      expect(sql).toContain("if public.task_parts_total(null) is distinct from 0 or public.task_parts_total('[]'::jsonb) is distinct from 0 then");
    });

    it("the formula the SQL states is partMoney's, to the cent, over every half-cent it can meet", () => {
      // The SQL: round(q, 2) × round(s, 2), rounded to 2 places, numeric (exact; a half goes away from
      // zero). In whole cents, for figures never below zero, that is floor((Q × S + 50) / 100).
      const sqlCents = (qty: number | null, sell: number | null) => {
        const Q = BigInt(Math.round(Math.max(qty ?? 0, 0) * 100));
        const S = BigInt(Math.round(Math.max(sell ?? 0, 0) * 100));
        return Number((Q * S + 50n) / 100n);
      };
      const cents = (n: number) => Math.round(n * 100);
      let seed = 0x0408;
      const next = (max: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % (max + 1);
      };
      let halves = 0;
      for (let i = 0; i < 40_000; i++) {
        const qty = next(50_000) / 100; // up to 500.00 of a part
        const sell = next(250_000) / 100; // up to $2,500.00 each
        if ((Math.round(qty * 100) * Math.round(sell * 100)) % 100 === 50) halves++;
        expect(cents(partMoney({ qty, sell })), `${qty} × ${sell}`).toBe(sqlCents(qty, sell));
      }
      // Every exact half cent for small counts, where the float product is the one that goes wrong.
      for (let q = 1; q <= 400; q++) {
        for (let s = 1; s <= 400; s++) {
          if ((q * s) % 100 !== 50) continue;
          halves++;
          expect(cents(partMoney({ qty: q / 100, sell: s / 100 })), `${q / 100} × ${s / 100}`).toBe(sqlCents(q / 100, s / 100));
        }
      }
      expect(halves).toBeGreaterThan(500);
      expect(cents(partMoney({ qty: 2.5, sell: 1.99 }))).toBe(498);
      expect(sqlCents(2.5, 1.99)).toBe(498);
      expect(sqlCents(null, 9)).toBe(0);
      expect(sqlCents(3, null)).toBe(0);
    });
  });

  describe("public.public_quote: 0395's body, and only these changes", () => {
    const was = fnText(m0395, PUBLIC_QUOTE);

    it("the same door: its signature, its security, its search path and its grant, as 0395 left them", () => {
      const head = "create or replace function public.public_quote(p_token text)\nreturns json language sql stable security definer set search_path = public as $$";
      expect(was.whole.startsWith(head)).toBe(true);
      expect(quote.whole.startsWith(head)).toBe(true);
      const grant = "grant execute on function public.public_quote(text) to anon, authenticated;";
      expect(m0395).toContain(grant);
      expect(sql).toContain(grant);
      expect(sql.indexOf(grant)).toBeGreaterThan(sql.indexOf(quote.whole));
      // The only grant and the only revoke in the file.
      expect((code.match(/^\s*grant\b/gim) ?? []).length).toBe(1);
      expect((code.match(/^\s*revoke\b/gim) ?? []).length).toBe(1);
    });

    it("every statement line of 0395's body is still there but three, and what was added is exactly this", () => {
      const { removed, added } = lineDiff(statementLines(was.body), statementLines(quote.body));
      expect(removed).toEqual([
        "      'doc_type', q.doc_type, 'created_at', q.created_at),",
        "        when jsonb_typeof(li.detail) = 'object'",
        "         and coalesce(q.estimate_format, (select o.settings->'doc_style'->>'estimate_format' from public.organizations o where o.id = q.org_id)) = 'detailed'",
      ]);
      expect(added).toEqual([
        "      'doc_type', q.doc_type, 'created_at', q.created_at,",
        "      'estimate_format', fmt.word),",
        "        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'detailed'",
        "        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'grouped'",
        "        then jsonb_build_object(",
        "          'hours', li.detail->'hours',",
        "          'rate', li.detail->'rate',",
        "          'units', li.detail->'units',",
        "          'labor', coalesce((select jsonb_agg(jsonb_build_object(",
        "              'label', l->'label', 'hours', l->'hours', 'rate', l->'rate') order by ord)",
        "            from jsonb_array_elements(case when jsonb_typeof(li.detail->'labor') = 'array' then li.detail->'labor' else '[]'::jsonb end) with ordinality as lab(l, ord)), '[]'::jsonb),",
        "          'materials', '[]'::jsonb,",
        "          'materials_total', nullif(public.task_parts_total(li.detail), 0))",
        "  cross join lateral (",
        "    select case when said.word in ('tasks', 'detailed', 'grouped') then said.word else 'tasks' end as word",
        "      from (select coalesce(q.estimate_format, (select o.settings->'doc_style'->>'estimate_format' from public.organizations o where o.id = q.org_id)) as word) said",
        "  ) fmt",
      ]);
    });

    it("the 'detailed' arm is textually the one in 0395: not one key more or less", () => {
      const arm = (body: string) => {
        const from = body.indexOf("        then jsonb_build_object(");
        const end = "with ordinality as mats(m, ord)), '[]'::jsonb))\n";
        return body.slice(from, body.indexOf(end, from) + end.length);
      };
      expect(arm(was.body).split("\n").length).toBe(11);
      expect(arm(quote.body)).toBe(arm(was.body));
      // …and it sits under the 'detailed' test, with the 'grouped' test right after it.
      expect(quote.body).toContain(`        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'detailed'\n${arm(was.body)}        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'grouped'\n`);
    });

    it("the 'grouped' arm: the labor as 'detailed' ships it, an empty parts list, and the one figure", () => {
      const from = quote.body.indexOf("        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'grouped'\n");
      const arm = quote.body.slice(from, quote.body.indexOf("        else null end)", from));
      expect(arm).toBe(
        [
          "        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'grouped'",
          "        then jsonb_build_object(",
          "          'hours', li.detail->'hours',",
          "          'rate', li.detail->'rate',",
          "          'units', li.detail->'units',",
          "          'labor', coalesce((select jsonb_agg(jsonb_build_object(",
          "              'label', l->'label', 'hours', l->'hours', 'rate', l->'rate') order by ord)",
          "            from jsonb_array_elements(case when jsonb_typeof(li.detail->'labor') = 'array' then li.detail->'labor' else '[]'::jsonb end) with ordinality as lab(l, ord)), '[]'::jsonb),",
          "          'materials', '[]'::jsonb,",
          "          'materials_total', nullif(public.task_parts_total(li.detail), 0))",
          "",
        ].join("\n"),
      );
      // Its labor lines are the 'detailed' arm's own, character for character.
      const laborEnd = "with ordinality as lab(l, ord)), '[]'::jsonb),\n";
      const labor = (text: string) => text.slice(text.indexOf("          'labor', coalesce("), text.indexOf(laborEnd) + laborEnd.length);
      expect(labor(was.body).split("\n").length).toBe(4);
      expect(labor(arm)).toBe(labor(was.body));
      // No part is read: not a name, not a count, not a price, not the list itself.
      expect(arm).not.toMatch(/\bm->/);
      expect(arm).not.toContain("li.detail->'materials'");
      expect(arm).not.toMatch(/'(name|qty|sell)'/);
    });

    it("the format is resolved ONCE, beside the estimate, and the quote object says the word", () => {
      expect(count(quoteCode, "coalesce(q.estimate_format,")).toBe(1);
      expect(count(quoteCode, "->>'estimate_format'")).toBe(1);
      const detail = quote.body.slice(quote.body.indexOf("'detail', case"), quote.body.indexOf("else null end"));
      expect(detail).not.toContain("q.estimate_format");
      expect(detail).not.toContain("o.settings");
      // In the FROM clause: after the estimate, before the token and status gate. One row, always.
      const from = quote.body.slice(quote.body.lastIndexOf("  from public.quotes q\n"));
      expect(noComments(from).replace(/\n\s*\n/g, "\n")).toBe(
        [
          "  from public.quotes q",
          "  cross join lateral (",
          "    select case when said.word in ('tasks', 'detailed', 'grouped') then said.word else 'tasks' end as word",
          "      from (select coalesce(q.estimate_format, (select o.settings->'doc_style'->>'estimate_format' from public.organizations o where o.id = q.org_id)) as word) said",
          "  ) fmt",
          "  where q.public_token = p_token",
          "    and q.status in ('sent', 'accepted', 'declined', 'expired');",
          "",
        ].join("\n"),
      );
      // The three words it knows are the app's three, and the fallback is the app's.
      const known = [...from.match(/when said\.word in \(([^)]*)\)/)![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
      expect(known).toEqual([...ESTIMATE_FORMATS]);
      // The word rides the quote object, the last key before the items.
      expect(quote.body.replace(/^\s*--.*\n/gm, "")).toContain("'doc_type', q.doc_type, 'created_at', q.created_at,\n      'estimate_format', fmt.word),\n    'items', coalesce(");
      // Read in three places and nowhere else: the key, and the test at the head of each arm.
      expect(count(quoteCode, "fmt.word")).toBe(3);
      expect(count(quoteCode, "said.word")).toBe(2);
    });

    it("no labor money is computed in SQL and there is no adds-up gate: the gap is said, known and carried", () => {
      // The door does no arithmetic of its own: the one figure comes from task_parts_total.
      expect(quoteCode).not.toMatch(/\bround\(|\bsum\(|[^a-z_]\*[^a-z_]|\bunit_price\s*[=<>]|\babs\(/);
      expect(count(quoteCode, "public.task_parts_total(")).toBe(1);
      expect(noComments(total.body)).not.toMatch(/'labor'|'hours'|'rate'/);
      expect(sql).toContain("KNOWN AND CARRIED");
      expect(sql).toMatch(/NO\n-- LABOR MONEY is computed in SQL and no adds-up gate is added/);
      expect(sql).toContain("laborMoney is a float product in the app");
      expect(quote.body).toContain("NO LABOR MONEY and no adds-up gate here: known and carried");
    });
  });

  it("the self-check proves the check, the twin, who may call what, and the door, on the database", () => {
    const self = sql.slice(sql.indexOf("-- ── Self-check"));
    for (const proof of [
      // the check
      "if v_n <> 1 or v_name <> 'quotes_estimate_format_check' then",
      "if v_words <> array['detailed', 'grouped', 'tasks'] then",
      "where c.conrelid = 'public.quotes'::regclass and c.conname = 'quotes_estimate_format_check') then",
      // who may call what
      "if has_function_privilege('anon', v_total, 'execute') or has_function_privilege('authenticated', v_total, 'execute') then",
      "if not has_function_privilege(pg_get_userbyid((select p.proowner from pg_proc p where p.oid = v_quote)), v_total, 'execute') then",
      "if not has_function_privilege('anon', v_quote, 'execute') or not has_function_privilege('authenticated', v_quote, 'execute') then",
      "v_was := current_setting('cn.m0408_public_quote_acl', true);",
      "if v_now is distinct from v_was then",
      // the door
      "if position('''estimate_format'', fmt.word' in v_src) = 0 then",
      "if position('fmt.word = ''detailed''' in v_src) = 0 or position('fmt.word = ''grouped''' in v_src) = 0 then",
      "or position('''materials_total'', nullif(public.task_parts_total(li.detail), 0)' in v_src) = 0 then",
      "if (length(v_src) - length(replace(v_src, 'm->''name''', ''))) / length('m->''name''') <> 1 then",
      "if v_src ~ '''(cost|code|words|task_id|kit_id|person_id|rate_from|from_kit|hours_from_kit)''\\s*,' then",
      "if position('q.status in (''sent'', ''accepted'', ''declined'', ''expired'')' in v_src) = 0 then",
      "if public.public_quote('0408 self-check: no estimate has this token') is not null then",
    ]) {
      expect(self).toContain(proof);
    }
    // The grants noted before the change and compared after it are read the same way both times.
    expect(sql).toContain("'acl:' || coalesce((select p.proacl::text from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure), ''),");
    expect(sql).toContain("select 'acl:' || coalesce(p.proacl::text, '') into v_now from pg_proc p where p.oid = v_quote;");
    expect(count(code, "p.proacl::text")).toBe(2);
    expect(sql).toContain("perform set_config(\n    'cn.m0408_public_quote_acl',");
    // What the self-check looks for in the stored body is what this file's body says.
    for (const mark of [
      "'estimate_format', fmt.word",
      "fmt.word = 'detailed'",
      "fmt.word = 'grouped'",
      "'materials', '[]'::jsonb",
      "'materials_total', nullif(public.task_parts_total(li.detail), 0)",
      "q.status in ('sent', 'accepted', 'declined', 'expired')",
    ]) {
      expect(quote.body).toContain(mark);
    }
    expect(count(quote.body, "m->'name'")).toBe(1);
    expect(quote.body).not.toMatch(/'(cost|code|words|task_id|kit_id|person_id|rate_from|from_kit|hours_from_kit)'\s*,/);
  });

  it("names its readers the day they are added, and they are there", () => {
    for (const reader of ["src/app/q/[token]/page.tsx", "src/lib/estimate/task-lines.ts paperBreakdown", "lib/doc-style (ESTIMATE_FORMATS, estimateFormatFor)", "detailExplains", "partMoney", "coerceTaskDetail"]) {
      expect(sql).toContain(reader);
    }
    // A word nothing reads back is a hole, so the readers the header names are looked for in the code.
    // If one moves: before 0408 is applied, re-point its header; once it is applied the file is
    // immutable, so re-point THIS pin at where the reading went (and say so here).
    const moved = "0408's header names it as a reader: re-point the header (before 0408 is applied) or this pin (after)";
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(existsSync(join(process.cwd(), "src/app/q/[token]/page.tsx"))).toBe(true);
    expect(src("src/app/q/[token]/page.tsx"), `the customer's page no longer reads quote.estimate_format. ${moved}`).toMatch(/estimate_format/);
    const lines = src("src/lib/estimate/task-lines.ts");
    for (const fn of ["paperBreakdown", "taskMoney", "partMoney", "detailExplains", "coerceTaskDetail"]) {
      expect(lines, `${fn} is gone from task-lines.ts. ${moved}`).toMatch(new RegExp(`export function ${fn}\\(`));
    }
    expect(lines).toMatch(/materials_total/);
    expect(src("src/lib/doc-style.ts")).toMatch(/export function estimateFormatFor\(/);
  });

  it("changes nothing else: two functions, one check, no table, no policy, no trigger, no row", () => {
    expect((code.match(/create (or replace )?function/gi) ?? []).length).toBe(2);
    expect(code).not.toMatch(/drop function|drop table|drop index|drop column|drop policy|drop trigger|drop type/i);
    expect(code).not.toMatch(/create policy|create trigger|create table|create index|create type|create extension/i);
    expect(code).not.toMatch(/enable row level security|disable row level security|security invoker/i);
    expect((code.match(/security definer/gi) ?? []).length).toBe(1); // public_quote, as before
    // 0395 itself is untouched (applied migrations are immutable).
    expect(m0395).not.toContain("0408");
    expect(m0395).not.toContain("grouped");
  });
});
