import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A DAILY REPORT BELONGS TO ONE JOB (0411; cn-v1174. The owner, 2026-11-21: "Daily reports should be
 * stored with each job's file"), read from the migration file the way migration-0410.test.ts reads
 * 0410. Three things and nothing else: daily_reports.job_id, the key that counts the job, and the
 * backfill from a frozen summary that names exactly one job. RLS, the status check and the one
 * trigger are not named.
 *
 * NO DATABASE RUNS HERE. What this file can prove is the text: the statements it makes, that each is
 * safe to run twice, that it makes nothing else, and that its self-check refuses what it says it
 * refuses. Applied migrations are immutable: 0411 is pinned the day it is applied.
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

describe("migration 0411: a daily report belongs to one job", () => {
  const sql = migration("0411_");
  const code = noComments(sql);
  const flat = squash(code);

  it("is the next migration, named for what it does, and takes its locks with a timeout", () => {
    expect(names.filter((n) => n.startsWith("0411_"))).toEqual(["0411_a_daily_report_belongs_to_one_job.sql"]);
    expect(names[names.length - 1]).toBe("0411_a_daily_report_belongs_to_one_job.sql");
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
  });

  it("quotes the owner and names its writer and readers the day the column is added", () => {
    expect(sql).toContain("Daily reports should be");
    expect(sql).toContain("ask which job the report is being made for at the time of the report");
    expect(sql).toContain("THE READERS AND THE WRITER, named the day the column is added: src/app/(app)/timeclock/actions.ts");
    expect(sql).toContain("src/app/(app)/planner/page.tsx");
  });

  it("adds job_id as a nullable uuid that references jobs with NO on-delete action, only if it is not there", () => {
    expect(flat).toContain("alter table public.daily_reports add column if not exists job_id uuid references public.jobs(id);");
    expect(flat).not.toMatch(/job_id uuid not null/);
    // Not set null: the key counts no job as one value, so nulling a deleted job's reports would
    // collide with the same person's no-job report that day and fail the delete on a raw error.
    expect(code).not.toMatch(/on delete/i);
    expect(sql).toContain("set the job to Cancelled instead");
  });

  it("swaps the key: drops 0128's by its name if it is there, adds the four-column one nulls not distinct only if it is not", () => {
    // 0128's key, unnamed in its file, is the default name Postgres gave it.
    expect(squash(noComments(migration("0128_")))).toContain("unique (org_id, profile_id, report_date)");
    expect(flat).toContain("alter table public.daily_reports drop constraint if exists daily_reports_org_id_profile_id_report_date_key;");
    expect(flat).toContain(
      "if not exists ( select 1 from pg_constraint where conrelid = 'public.daily_reports'::regclass and conname = 'daily_reports_one_per_job_per_day' ) then alter table public.daily_reports add constraint daily_reports_one_per_job_per_day unique nulls not distinct (org_id, profile_id, report_date, job_id);",
    );
    // The drop comes before the add, and both before the backfill.
    expect(code.indexOf("drop constraint if exists")).toBeLessThan(code.indexOf("add constraint daily_reports_one_per_job_per_day"));
    expect(code.indexOf("add constraint daily_reports_one_per_job_per_day")).toBeLessThan(code.indexOf("update public.daily_reports"));
  });

  it("backfills only rows with no job, whose summary names exactly one job that is still there in the same company", () => {
    const backfill = flat.slice(flat.indexOf("update public.daily_reports"));
    expect(backfill).toContain("where r.job_id is null");
    expect(backfill).toContain("jsonb_typeof(r.gps_summary -> 'jobs') = 'array'");
    expect(backfill).toContain(
      "select count(distinct x ->> 'job_id') from jsonb_array_elements(case when jsonb_typeof(r.gps_summary -> 'jobs') = 'array' then r.gps_summary -> 'jobs' else '[]'::jsonb end) x where nullif(x ->> 'job_id', '') is not null ) = 1",
    );
    // A summary whose jobs is not an array can never throw: every jsonb_array_elements is guarded.
    const unrolls = backfill.match(/jsonb_array_elements\([^)]*\)/g) ?? [];
    expect(unrolls.length).toBe(2);
    expect(backfill.match(/jsonb_array_elements\(case when jsonb_typeof\(r\.gps_summary -> 'jobs'\) = 'array' then r\.gps_summary -> 'jobs' else '\[\]'::jsonb end\)/g)?.length).toBe(2);
    expect(backfill).toContain("and j.org_id = r.org_id;");
    // Compared as text, so a summary holding something that is not a uuid never breaks the file.
    expect(backfill).toContain("j.id::text = (");
  });

  it("does nothing else: no policy, no trigger, no grant, no function, no table, no other column", () => {
    const statements = code
      .replace(/do \$\$[\s\S]*?end \$\$;/g, "")
      .replace(/'(?:[^']|'')*'/g, "''")
      .split(";")
      .map((s) => squash(s))
      .filter(Boolean);
    expect(statements.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual([
      "set local lock_timeout",
      "set local statement_timeout",
      "alter table public.daily_reports",
      "comment on column",
      "alter table public.daily_reports",
      "update public.daily_reports r",
    ]);
    const bare = code.replace(/'(?:[^']|'')*'/g, "''");
    expect(bare).not.toMatch(/\b(create policy|drop policy|create trigger|drop trigger|grant|revoke|create table|create or replace function|delete from|insert into)\b/i);
    expect((bare.match(/add column/gi) ?? []).length).toBe(1);
  });

  it("checks its ground first and changes nothing when it is missing", () => {
    for (const need of ["to_regclass('public.daily_reports') is null", "to_regclass('public.jobs') is null", "current_setting('server_version_num')::int < 150000"]) {
      expect(code, need).toContain(need);
    }
    expect(code.indexOf("to_regclass('public.daily_reports')")).toBeLessThan(code.indexOf("add column"));
  });

  it("checks itself after: the column, its reference, the old key gone, the new key nulls not distinct, RLS on, the trigger there", () => {
    const after = code.slice(code.indexOf("update public.daily_reports"));
    expect(after).toContain("column_name = 'job_id' and data_type = 'uuid' and is_nullable = 'YES'");
    expect(after).toContain("confrelid = 'public.jobs'::regclass and confdeltype = 'a'");
    expect(after).toContain("conname = 'daily_reports_org_id_profile_id_report_date_key'");
    expect(after).toContain("select indnullsnotdistinct from pg_index where indexrelid = v_index");
    expect(after).toContain("select relrowsecurity from pg_class where oid = 'public.daily_reports'::regclass");
    expect(after).toContain("tgname = 'stamp_org_daily_reports'");
    expect((after.match(/raise exception '0411: [^']*Nothing was changed\.'/g) ?? []).length).toBe(6);
  });

  it("the app upserts on exactly the four columns of the new key", () => {
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/actions.ts"), "utf8");
    expect(actions).toContain('onConflict: "org_id,profile_id,report_date,job_id"');
    expect(actions).not.toContain('onConflict: "org_id,profile_id,report_date" }');
  });
});
