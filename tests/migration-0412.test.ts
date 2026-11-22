import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A BUG REPORT CARRIES ITS PICTURE IN THE ROW (0412; cn-v1175. The owner, 2026-11-21: "if you
 * cant open screenshots from the bug reports then that needs to be fixed right?"), read from the
 * migration file the way migration-0411.test.ts reads 0411. One column and its one check, nothing
 * else: RLS and its two policies are not touched.
 *
 * NO DATABASE RUNS HERE. What this file can prove is the text: the statements it makes, that each is
 * safe to run twice, that it makes nothing else, and that its self-check refuses what it says it
 * refuses. Applied migrations are immutable: 0412 is pinned the day it is applied.
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
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("migration 0412: a bug report carries its picture in the row, and can wait for later", () => {
  const sql = migration("0412_");
  const code = noComments(sql);
  const flat = squash(code);

  it("is the one 0412, named for what it does, and takes its locks with a timeout", () => {
    expect(names.filter((n) => n.startsWith("0412_"))).toEqual(["0412_a_bug_report_carries_its_picture.sql"]);
    // The newest-migration line moved to migration-0413.test.ts the day 0413 was written.
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
  });

  it("quotes the owner and names its writers and readers the day the column is added", () => {
    expect(sql).toContain("if you cant open screenshots from the bug reports then that needs to be fixed right?");
    expect(sql).toContain("now its a provisional tiny versions of it, just sayin");
    expect(sql).toContain("go for the later list we might as well build it");
    expect(sql).toContain("more than 7 days old");
    expect(sql).not.toMatch(/thumb|small copy|30 days/i);
    expect(sql).toContain("THE WRITERS AND THE READERS, named the day the column is added: src/components/bug-reporter.tsx");
    expect(sql).toContain("src/app/(app)/bug-report-actions.ts");
    expect(sql).toContain("src/lib/storage-sweep.ts");
    expect(sql).toContain("src/lib/export/registry.ts");
  });

  it("adds screenshot_copy as nullable text, only if it is not there", () => {
    expect(flat).toContain("alter table public.bug_reports add column if not exists screenshot_copy text;");
    expect(flat).not.toMatch(/screenshot_copy text not null/);
    expect(flat).not.toMatch(/screenshot_copy text default/);
  });

  it("adds its one check by name, only if it is not there: null, or a JPEG data URL of at most 300,000 characters", () => {
    expect(flat).toContain(
      "if not exists ( select 1 from pg_constraint where conrelid = 'public.bug_reports'::regclass and conname = 'bug_reports_screenshot_copy_shape' ) then alter table public.bug_reports add constraint bug_reports_screenshot_copy_shape check ( screenshot_copy is null or (left(screenshot_copy, 23) = 'data:image/jpeg;base64,' and char_length(screenshot_copy) <= 300000) );",
    );
    // The prefix is 23 characters, and the app's own check uses the same prefix and cap.
    expect("data:image/jpeg;base64,".length).toBe(23);
    const lib = readFileSync(join(process.cwd(), "src/lib/bug-shot-copy.ts"), "utf8");
    expect(lib).toContain('export const COPY_PREFIX = "data:image/jpeg;base64,";');
    expect(lib).toContain("export const COPY_MAX_CHARS = 300_000;");
    expect(code.indexOf("add column if not exists screenshot_copy")).toBeLessThan(code.indexOf("add constraint bug_reports_screenshot_copy_shape"));
  });

  it("does nothing else: one column, two checks, one function replaced with its grants; no policy, trigger, table or data", () => {
    const statements = code
      .replace(/do \$\$[\s\S]*?end \$\$;/g, "")
      .replace(/as \$\$[\s\S]*?end \$\$;/g, "as $$ $$;")
      .replace(/'(?:[^']|'')*'/g, "''")
      .split(";")
      .map((s) => squash(s))
      .filter(Boolean);
    expect(statements.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual([
      "set local lock_timeout",
      "set local statement_timeout",
      "alter table public.bug_reports",
      "comment on column",
      "create or replace",
      "comment on function",
      "revoke execute on",
      "grant execute on",
    ]);
    const bare = code.replace(/'(?:[^']|'')*'/g, "''");
    expect(bare).not.toMatch(/\b(create policy|drop policy|alter policy|create trigger|drop trigger|create table|delete from|insert into|disable row level security)\b/i);
    expect((bare.match(/create or replace function/gi) ?? []).length).toBe(1);
    expect((bare.match(/\bgrant\b/gi) ?? []).length).toBe(1);
    expect((bare.match(/\brevoke\b/gi) ?? []).length).toBe(1);
    // The one update is the function's own (one report's status, by a platform admin): no data step.
    expect(bare.match(/update public\.\w+/gi) ?? []).toEqual(["update public.bug_reports"]);
    expect(bare.slice(bare.indexOf("create or replace function"))).toContain("update public.bug_reports set status = p_status where id = p_id;");
    expect((bare.match(/add column/gi) ?? []).length).toBe(1);
    expect((bare.match(/add constraint/gi) ?? []).length).toBe(2);
  });

  it("the status check allows later: dropped and added again only while its definition lacks later", () => {
    expect(flat).toContain(
      "if v_def is not null and position('later' in v_def) = 0 then alter table public.bug_reports drop constraint bug_reports_status_check; v_def := null; end if; if v_def is null then alter table public.bug_reports add constraint bug_reports_status_check check (status is null or status in ('open', 'later', 'fixed', 'wontfix')); end if;",
    );
  });

  it("platform_set_bug_status is 0354's body word for word, with later in its list and nothing else changed", () => {
    const fn = (s: string) => {
      const from = s.indexOf("create or replace function public.platform_set_bug_status");
      return s.slice(from, s.indexOf("grant execute on function public.platform_set_bug_status", from));
    };
    const old = fn(noComments(migration("0354_")));
    const now = fn(code);
    expect(old.length).toBeGreaterThan(200);
    expect(old).toContain("p_status not in ('open', 'fixed', 'wontfix')");
    // The body and the grants are 0354's; only the list and the comment's words differ.
    const body = (s: string) => squash(s.slice(0, s.indexOf("comment on function")));
    expect(body(now)).toBe(body(old).replace("('open', 'fixed', 'wontfix')", "('open', 'later', 'fixed', 'wontfix')"));
    expect(squash(now.slice(now.indexOf("revoke execute")))).toBe(squash(old.slice(old.indexOf("revoke execute"))));
    expect(code).toContain("grant execute on function public.platform_set_bug_status(uuid, text) to authenticated;");
  });

  it("checks its ground first and changes nothing when it is missing", () => {
    expect(code).toContain("to_regclass('public.bug_reports') is null");
    expect(code).toContain("to_regprocedure('public.platform_set_bug_status(uuid, text)') is null");
    expect(code).toContain("where status is not null and status not in ('open', 'later', 'fixed', 'wontfix')");
    expect(code.indexOf("to_regclass('public.bug_reports')")).toBeLessThan(code.indexOf("add column"));
    expect(code.indexOf("status not in ('open', 'later', 'fixed', 'wontfix')")).toBeLessThan(code.indexOf("drop constraint bug_reports_status_check"));
  });

  it("checks itself after: the column, the copy's check, RLS on, both policies, the status check naming later, no row breaking it, the function", () => {
    const after = code.slice(code.lastIndexOf("do $$"));
    expect(after).toContain("column_name = 'screenshot_copy' and data_type = 'text' and is_nullable = 'YES'");
    expect(after).toContain("conname = 'bug_reports_screenshot_copy_shape'");
    expect(after).toContain("position('data:image/jpeg;base64,' in v_def) = 0 or position('300000' in v_def) = 0");
    expect(after).toContain("select relrowsecurity from pg_class where oid = 'public.bug_reports'::regclass");
    expect(after).toContain("policyname in ('bug_reports_insert', 'bug_reports_staff')) <> 2");
    expect(after).toContain("position('later' in v_def) = 0 or position('wontfix' in v_def) = 0");
    expect(after).toContain("where status is not null and status not in ('open', 'later', 'fixed', 'wontfix')");
    expect(after).toContain("position('later' in pg_get_functiondef('public.platform_set_bug_status(uuid, text)'::regprocedure)) = 0");
    expect(after).toContain("select prosecdef from pg_proc");
    expect(after).toContain("has_function_privilege('anon', 'public.platform_set_bug_status(uuid, text)', 'execute')");
    // A status check under another name that lacks later stops the file (skeptic #78): the swap above
    // goes by the name bug_reports_status_check only.
    expect(squash(after)).toContain(
      "if exists ( select 1 from pg_constraint where conrelid = 'public.bug_reports'::regclass and contype = 'c' and conname <> 'bug_reports_status_check' and position('status' in pg_get_constraintdef(oid)) > 0 and position('later' in pg_get_constraintdef(oid)) = 0 ) then raise exception '0412: another check on bug_reports names status without later. Nothing was changed.'; end if;",
    );
    expect((after.match(/raise exception '0412: [^']*Nothing was changed\.'/g) ?? []).length).toBe(9);
  });

  it("writes no row's status: which reports move to Later is a person's step", () => {
    const bare = code.replace(/as \$\$[\s\S]*?end \$\$;/g, "");
    expect(bare).not.toMatch(/update public\.bug_reports/i);
  });
});
