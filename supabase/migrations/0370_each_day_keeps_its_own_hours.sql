-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0370: each day keeps its own hours
--
-- Erik, 2026-09-28, on the Schedule page at night: "im on the schedule page and i want to put
-- heringbone on the page for the rest of the day after Seiler but theres no way to add to the
-- schedule from the schedule page unless its already scripted". Herringbone (J-011) runs 9/18, 9/22
-- and 9/24. A job carried ONE time of day for every one of its days (jobs.scheduled_start/end), so a
-- new afternoon for it could only land at the job's usual hours, a full day, on top of Seiler.
--
-- ── A. A DAY'S OWN HOURS ─────────────────────────────────────────────────────────────────────
--
-- job_schedule_segments gets start_time and end_time: the company's wall clock (a `time`, never an
-- instant: 12:00 is noon on that day in the company's timezone whatever the clocks are doing).
--   both null   the job's usual hours (its scheduled_start/end block): exactly today's behavior.
--   both set    that day's own hours. The calendar draws the day by them (lib/schedule/job-block
--               jobDayBlock), the schedule tile's This Day time sets them (setJobDayTimes), and Add
--               To Schedule puts a day on a job with them (addJobDay). The job page's time control
--               still sets the usual hours: every day without its own.
-- Two checks: the pair is set together or not at all, and the end is after the start.
--
-- RLS: unchanged. The row policies (0040 job_schedule_segments_rw: staff write; 0266
-- job_schedule_segments_read: every member reads) are row predicates, so they cover the new columns.
-- GRANTS: this table carries TABLE-LEVEL privileges for the signed-in role (checked on the test
-- database: authenticated holds SELECT, INSERT, UPDATE, DELETE on the table), and a table-level
-- privilege covers a column added later. 0366's lesson was the opposite shape (appointments' SELECT is
-- per column since 0366, so a new appointments column is private until granted). The column grant
-- below is belt and braces: if this table's privileges ever go per column the way appointments' did,
-- the office's hours still read and write.
--
-- THE CODE DEPLOYS BEFORE THIS RUNS. Every read of the two columns asks with them and, only when the
-- database says they are missing, again without (lib/schedule/segment-hours withDayHours): no per-day
-- editing and today's behavior until then, never an error page. Every rewrite of a job's days
-- (schedule/actions writeScheduleRanges, which deletes and re-inserts them) reads each day's hours
-- first and carries them onto every day still on the schedule: never dropped.
--
-- Runs twice without complaint (add column if not exists, the checks added only when missing).
-- Locks: ALTER TABLE on job_schedule_segments takes ACCESS EXCLUSIVE for an instant (two nullable
-- columns, no rewrite); the checks validate a table of a few hundred rows.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A. A day's own hours ───────────────────────────────────────────────────────────────────────
alter table public.job_schedule_segments
  add column if not exists start_time time,
  add column if not exists end_time time;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'job_schedule_segments_hours_pair' and conrelid = 'public.job_schedule_segments'::regclass) then
    alter table public.job_schedule_segments
      add constraint job_schedule_segments_hours_pair check ((start_time is null) = (end_time is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'job_schedule_segments_hours_order' and conrelid = 'public.job_schedule_segments'::regclass) then
    alter table public.job_schedule_segments
      add constraint job_schedule_segments_hours_order check (start_time is null or end_time is null or end_time > start_time);
  end if;
end $$;

comment on column public.job_schedule_segments.start_time is
  'The days'' OWN start (0370), company wall clock. Null with end_time: the job''s usual hours (jobs.scheduled_start/end). Set: these days run from here, drawn and fitted by it (lib/schedule/job-block jobDayBlock).';
comment on column public.job_schedule_segments.end_time is
  'The days'' OWN end (0370), company wall clock, after start_time. Null with start_time: the job''s usual hours.';

-- Belt and braces (see the header): the table-level privileges already cover these.
grant select (start_time, end_time), insert (start_time, end_time), update (start_time, end_time)
  on public.job_schedule_segments to authenticated;
