-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0411: a daily report belongs to one job
--
-- The owner, 2026-11-21, on My Day: "Daily reports should be stored with each job's file so it
-- reflects the days work are is recorded where it applies". And, asked how a report finds its job:
-- "ask which job the report is being made for at the time of the report if not determined or split
-- (part of crew leader responsibilities if one is assigned)".
--
-- WHY. A daily report was one row per person per company-local day (0128's key), and the only trace
-- of a job on it was inside its frozen GPS summary (gps_summary.jobs[]), a list written for reading,
-- not a link anything could be filed under. A job's file cannot hold a report that names no job, and
-- a crew lead who ran two jobs in one day had one report for both: the second filing overwrote the
-- first.
--
-- WHAT, three things and nothing else:
--
--  1. daily_reports.job_id: the ONE job the report is for. Null is a real answer (the person filed
--     with no job, and the sheet told him the report is in no job's file). A plain reference, with
--     NO on-delete action: a job with reports on it cannot be deleted (the app's Delete refuses first,
--     in one sentence: set the job to Cancelled instead). Not "set null", which was the first draft:
--     the key below counts no job as one value, so nulling a deleted job's reports collides with the
--     same person's no-job report that day (or with another deleted job's), and the delete, or a
--     cascade from above it, would fail midway on a raw error. A report is somebody's day: it stays
--     with its job.
--  2. THE KEY. 0128's unique (org_id, profile_id, report_date) becomes (org_id, profile_id,
--     report_date, job_id) NULLS NOT DISTINCT (Postgres 15+). Filing again the same day for the SAME
--     job, or again with no job, updates that report as before; a report for another job that day is
--     its own row and no longer overwrites the first. The app's upsert names exactly these four.
--  3. THE BACKFILL. A report already on file takes the job its frozen summary names, only when it
--     names exactly one job, that job is still there and in the same company, and the report has no
--     job yet. A summary naming none, or more than one, is left with no job: nothing is guessed.
--
-- Safe to run twice: the column is added if it is not there, the old key dropped if it is there,
-- the new key added if it is not there, and the backfill touches only rows with no job.
-- NOT TOUCHED: row level security and its four policies (0128, 0130, 0133), the status check
-- (0133) and the one trigger, stamp_org_daily_reports (0128). The self-check at the end says so.
--
-- THE READERS AND THE WRITER, named the day the column is added: src/app/(app)/timeclock/actions.ts
-- fileDailyReport (writes it, upserts on the new key), src/app/(app)/planner/page.tsx (the bell's
-- link sends a report with a job to its job's Time tab), and the job page's Time tab (lists the
-- reports whose job_id is that job). Each read tolerates the column being absent, because the code
-- may land a moment before this file.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.daily_reports') is null then
    raise exception '0411: public.daily_reports is not on this database (0128). Nothing was changed.';
  end if;
  if to_regclass('public.jobs') is null then
    raise exception '0411: public.jobs is not on this database. Nothing was changed.';
  end if;
  if current_setting('server_version_num')::int < 150000 then
    raise exception '0411: unique nulls not distinct needs Postgres 15 or later. Nothing was changed.';
  end if;
end $$;

-- 1. The one job the report is for.
alter table public.daily_reports
  add column if not exists job_id uuid references public.jobs(id);

comment on column public.daily_reports.job_id is
  'The one job this report is for (0411). Null: filed with no job, so it is in no job''s file. Asked at clock-out when the day''s punches name none or more than one job.';

-- 2. The key: one report per person, per company-local day, per job (no job counts as one).
alter table public.daily_reports
  drop constraint if exists daily_reports_org_id_profile_id_report_date_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.daily_reports'::regclass
       and conname = 'daily_reports_one_per_job_per_day'
  ) then
    alter table public.daily_reports
      add constraint daily_reports_one_per_job_per_day
      unique nulls not distinct (org_id, profile_id, report_date, job_id);
  end if;
end $$;

-- 3. The backfill: a report whose frozen summary names exactly one job, still there, same company.
--    The CASE hands jsonb_array_elements an empty array whenever jobs is not an array, so a summary
--    of any other shape can never throw, whatever order the planner reads the conditions in.
update public.daily_reports r
   set job_id = j.id
  from public.jobs j
 where r.job_id is null
   and jsonb_typeof(r.gps_summary -> 'jobs') = 'array'
   and (
     select count(distinct x ->> 'job_id')
       from jsonb_array_elements(case when jsonb_typeof(r.gps_summary -> 'jobs') = 'array' then r.gps_summary -> 'jobs' else '[]'::jsonb end) x
      where nullif(x ->> 'job_id', '') is not null
   ) = 1
   and j.id::text = (
     select min(x ->> 'job_id')
       from jsonb_array_elements(case when jsonb_typeof(r.gps_summary -> 'jobs') = 'array' then r.gps_summary -> 'jobs' else '[]'::jsonb end) x
      where nullif(x ->> 'job_id', '') is not null
   )
   and j.org_id = r.org_id;

-- The self-check: what this file made is there, what it left is as it was.
do $$
declare
  v_index oid;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'daily_reports'
       and column_name = 'job_id' and data_type = 'uuid' and is_nullable = 'YES'
  ) then
    raise exception '0411: daily_reports.job_id is not a nullable uuid. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.daily_reports'::regclass and contype = 'f'
       and confrelid = 'public.jobs'::regclass and confdeltype = 'a'
       and conkey = array[(select attnum from pg_attribute
                            where attrelid = 'public.daily_reports'::regclass and attname = 'job_id')]::smallint[]
  ) then
    raise exception '0411: daily_reports.job_id does not reference jobs with no on-delete action. Nothing was changed.';
  end if;
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.daily_reports'::regclass
       and conname = 'daily_reports_org_id_profile_id_report_date_key'
  ) then
    raise exception '0411: the old one-report-a-day key is still there. Nothing was changed.';
  end if;
  select conindid into v_index from pg_constraint
   where conrelid = 'public.daily_reports'::regclass and contype = 'u'
     and conname = 'daily_reports_one_per_job_per_day';
  if v_index is null or not (select indnullsnotdistinct from pg_index where indexrelid = v_index) then
    raise exception '0411: the key (org_id, profile_id, report_date, job_id) nulls not distinct is not there. Nothing was changed.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.daily_reports'::regclass) then
    raise exception '0411: row level security is off on daily_reports. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.daily_reports'::regclass and tgname = 'stamp_org_daily_reports' and not tgisinternal
  ) then
    raise exception '0411: the stamp_org_daily_reports trigger is missing. Nothing was changed.';
  end if;
end $$;
