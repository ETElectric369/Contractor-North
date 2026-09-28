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
-- ── B. THE CUSTOMER'S PICK LANDS AT ITS TIME, FOR THE JOB'S LENGTH, BESIDE ITS OTHER DAYS ──────
--
-- choose_schedule_slot / choose_schedule_date (the /pick/<token> link's two writers) were last
-- defined in 0222 (read back from the test database with pg_get_functiondef: identical, word for
-- word). They wrote a job's day as the picked time + 8 hours, or a fixed 08:00-16:00 with no time,
-- ignoring the company's work day and the job's planned length, and then REPLACED every segment the
-- job had with the picked day: the worked days kept as history went, and so did the other days of a
-- job over several. Both are re-created below FROM THOSE BODIES, verbatim but for the times and the
-- job's days:
--   · the start is the picked time, else the company's work-day start (Settings, work_day_start),
--     never 08:00 (the appointment branch's default start too);
--   · the end is the start + the job's planned length (planned_minutes), else the two-hour default
--     (lib/schedule/job-block DEFAULT_JOB_MINUTES); a job sized a day or more runs to closing; never
--     past the end of the day. The job's planned length is left as it was (blank stays blank);
--   · the day is ADDED, like placeJobOnDay (schedule/actions): a job with no live plan (no day, or
--     on hold with an old one) gets it as its plan, its worked days kept as history and its stale
--     unworked days dropped, and an on-hold job wakes (its reason with it; jobs_hold_day, 0366, clears
--     its day and who held it); a job with a live plan keeps every day it has, the picked day joins
--     with ITS OWN HOURS, the span grows to cover it, and every other day whose drawn block that
--     growth would change keeps the block it had (freezeDrawnDays' rule). The job's one day picked
--     again is its time. The status moves like placeJobOnDay's: To Be Scheduled becomes Scheduled, a
--     job In Progress stays In Progress (the old write turned it back to Scheduled).
--   · a finished job (Complete, Cancelled) takes no day: the pick is refused in the same words as the
--     other refusals, instead of silently reviving it as Scheduled.
-- The job's part is one internal function both writers call (job_takes_picked_day), with the block
-- rule in SQL beside it (job_day_block_min, the twin of jobDayBlock) and the one-day hours setter
-- (job_segment_set_day). All three are revoked from the signed-in and anonymous roles: they are
-- reached only through the two token doors, which keep their grants.
--
-- Runs twice without complaint (add column if not exists, the checks added only when missing,
-- create or replace).
-- Locks: ALTER TABLE on job_schedule_segments takes ACCESS EXCLUSIVE for an instant (two nullable
-- columns, no rewrite); the checks validate a table of a few hundred rows.
--
-- ONE TRANSACTION. apply-migration.cjs (production) and scripts/test-db/rebuild.cjs (the test
-- database) wrap the file in begin/commit; the file holds none of its own, so a suite can run it
-- inside its own rolled-back transaction (lib/each-day-hours.integration.test). lock_timeout 5s /
-- statement_timeout 15s: queued behind a long transaction on job_schedule_segments, it gives up and
-- changes nothing instead of stalling the app.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '15s';

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

-- ── B. The customer's pick ─────────────────────────────────────────────────────────────────────

-- WHERE A JOB SITS ON ONE DAY, by its usual hours: the twin of lib/schedule/job-block jobDayBlock
-- (without a day's own hours, which the caller checks first). Minutes past the company's midnight.
--   one day:    its start to its stored end; a job sized under a day whose end is just closing (or
--               missing) draws its size; an end missing or not after the start runs to closing.
--   many days:  the first day from its start to closing, the middle days full, the last day from the
--               opening to its end. A day outside the span (history) is full.
create or replace function public.job_day_block_min(
  p_day date,
  p_start timestamptz,
  p_end timestamptz,
  p_planned integer,
  p_tz text,
  p_wd_start integer,
  p_wd_end integer,
  out start_min integer,
  out end_min integer
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_first   date;
  v_end_day date;
  v_last    date;
  v_sized   integer;
  v_s       integer;
  v_e       integer;
  v_real    integer;
  v_local   timestamp;
begin
  start_min := p_wd_start;
  end_min := p_wd_end;
  if p_start is null then return; end if;
  v_local := p_start at time zone p_tz;
  v_first := v_local::date;
  v_end_day := case when p_end is null then v_first else (p_end at time zone p_tz)::date end;
  v_last := greatest(v_first, v_end_day);
  if p_day < v_first or p_day > v_last then return; end if;

  v_sized := greatest(0, coalesce(p_planned, 0));
  v_s := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  v_e := case
           when p_end is not null and v_end_day = p_day
           then extract(hour from (p_end at time zone p_tz))::integer * 60 + extract(minute from (p_end at time zone p_tz))::integer
         end;

  if v_first <> v_last then
    if p_day = v_first then
      start_min := v_s;
      end_min := case when p_wd_end > v_s then p_wd_end else least(1440, v_s + 60) end;
    elsif p_day = v_last then
      start_min := p_wd_start;
      end_min := case when v_e is not null and v_e > p_wd_start then v_e else p_wd_end end;
    end if;
    return;
  end if;

  v_real := case when v_e is not null and v_e > v_s then v_e end;
  start_min := v_s;
  if v_sized > 0 and v_sized < 480 and (v_real is null or v_real = p_wd_end) then
    end_min := least(1440, v_s + v_sized);
  elsif v_real is not null then
    end_min := v_real;
  else
    end_min := case when p_wd_end > v_s then p_wd_end else least(1440, v_s + 60) end;
  end if;
end $$;

comment on function public.job_day_block_min(date, timestamptz, timestamptz, integer, text, integer, integer) is
  'Where a job sits on one day by its usual hours, in minutes past the company''s midnight (0370): the SQL twin of lib/schedule/job-block jobDayBlock. Internal: called by job_takes_picked_day.';

-- ONE DAY'S HOURS SET (its own, or both null for the job's usual), the job's other days untouched: the
-- range holding the day is split around it. The SQL twin of lib/schedule-math setDayHours.
create or replace function public.job_segment_set_day(
  p_job uuid,
  p_org uuid,
  p_day date,
  p_start time,
  p_end time
)
returns void
language plpgsql
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select id, org_id, start_date, end_date, start_time, end_time
      from public.job_schedule_segments
     where job_id = p_job and start_date <= p_day and end_date >= p_day
  loop
    delete from public.job_schedule_segments where id = r.id;
    if r.start_date < p_day then
      insert into public.job_schedule_segments (org_id, job_id, start_date, end_date, start_time, end_time)
        values (coalesce(r.org_id, p_org), p_job, r.start_date, p_day - 1, r.start_time, r.end_time);
    end if;
    if r.end_date > p_day then
      insert into public.job_schedule_segments (org_id, job_id, start_date, end_date, start_time, end_time)
        values (coalesce(r.org_id, p_org), p_job, p_day + 1, r.end_date, r.start_time, r.end_time);
    end if;
  end loop;
  insert into public.job_schedule_segments (org_id, job_id, start_date, end_date, start_time, end_time)
    values (p_org, p_job, p_day, p_day, p_start, p_end);
end $$;

comment on function public.job_segment_set_day(uuid, uuid, date, time, time) is
  'One day of a job gets its own hours (or the usual, both null), its other days untouched (0370). Internal: called by job_takes_picked_day.';

-- THE JOB'S PART OF A CUSTOMER'S PICK (the header, part B). `p_time` is the picked "HH:MM", or null.
create or replace function public.job_takes_picked_day(p_job uuid, p_day date, p_time text)
returns void
language plpgsql
set search_path = public
as $$
declare
  j            record;
  v_settings   jsonb;
  v_tz         text;
  v_hm         text;
  v_wd_start   integer;
  v_wd_end     integer;
  v_start      integer;
  v_end        integer;
  v_size       integer;
  v_today      date;
  v_first      date;
  v_last       date;
  v_new_first  date;
  v_new_last   date;
  v_start_min  integer;
  v_new_start  timestamptz;
  v_new_end    timestamptz;
  v_days       date[];
  v_day        date;
  v_old        record;
  v_new        record;
begin
  select id, org_id, status, scheduled_start, scheduled_end, planned_minutes
    into j
    from public.jobs
   where id = p_job
     for update;
  if not found then return; end if;

  -- A FINISHED JOB TAKES NO DAY (it used to come back as Scheduled, with no word to anyone).
  if j.status::text in ('complete', 'invoiced', 'cancelled') then
    raise exception 'This job is no longer open — please call us and we''ll find you a time';
  end if;

  -- THE COMPANY'S CLOCK AND WORK DAY (lib/org-settings workDayWindowHm + job-block workDayMinutes):
  -- 08:00 to 17:00 when never set, and the day at least an hour long.
  select settings into v_settings from public.organizations where id = j.org_id;
  v_tz := coalesce(v_settings ->> 'timezone', 'America/Los_Angeles');
  v_hm := v_settings ->> 'work_day_start';
  v_wd_start := case when v_hm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                     then split_part(v_hm, ':', 1)::integer * 60 + split_part(v_hm, ':', 2)::integer
                     else 8 * 60 end;
  v_hm := v_settings ->> 'work_day_end';
  v_wd_end := case when v_hm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                   then split_part(v_hm, ':', 1)::integer * 60 + split_part(v_hm, ':', 2)::integer
                   else 17 * 60 end;
  v_wd_end := greatest(v_wd_start + 60, v_wd_end);
  v_today := (now() at time zone v_tz)::date;

  -- THE PICKED DAY'S HOURS: the picked time, else the work day's start; the job's length, else two
  -- hours; a day or more runs to closing; never past 23:59.
  v_start := case when coalesce(p_time, '') ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]'
                  then split_part(p_time, ':', 1)::integer * 60 + substr(split_part(p_time, ':', 2), 1, 2)::integer
                  else v_wd_start end;
  v_start := least(v_start, 23 * 60 + 58);
  v_size := greatest(0, coalesce(j.planned_minutes, 0));
  v_end := case
             when v_size >= 480 then case when v_wd_end > v_start then v_wd_end else v_start + 60 end
             when v_size > 0 then v_start + v_size
             else v_start + 120
           end;
  v_end := greatest(v_start + 1, least(23 * 60 + 59, v_end));

  if j.scheduled_start is null or j.status::text = 'on_hold' then
    -- NO LIVE PLAN: the picked day is the plan. The worked days stay as history (a time entry clocked
    -- in that day, or a visit closed out as done, on or before today: workedDaysFrom), keeping their
    -- hours; stale unworked days go.
    with kept as (
      select distinct on (d::date) d::date as day, s.start_time, s.end_time
        from public.job_schedule_segments s
        cross join lateral generate_series(s.start_date::timestamp, s.end_date::timestamp, interval '1 day') d
       where s.job_id = p_job
         and d::date <= v_today
         and d::date <> p_day
         and (
           exists (select 1 from public.time_entries te
                    where te.job_id = p_job and te.clock_in <= now() and (te.clock_in at time zone v_tz)::date = d::date)
           or exists (select 1 from public.appointments a
                       where a.job_id = p_job and a.status = 'completed' and a.starts_at <= now()
                         and (a.starts_at at time zone v_tz)::date = d::date)
         )
       order by d::date
    ), gone as (
      delete from public.job_schedule_segments where job_id = p_job
    )
    insert into public.job_schedule_segments (org_id, job_id, start_date, end_date, start_time, end_time)
    select j.org_id, p_job, k.day, k.day, k.start_time, k.end_time from kept k;

    insert into public.job_schedule_segments (org_id, job_id, start_date, end_date, start_time, end_time)
      values (j.org_id, p_job, p_day, p_day, null, null);

    update public.jobs
       set scheduled_start = (p_day + make_time(v_start / 60, v_start % 60, 0)) at time zone v_tz,
           scheduled_end   = (p_day + make_time(v_end / 60, v_end % 60, 0)) at time zone v_tz,
           status = case when status::text in ('on_hold', 'to_be_scheduled', 'estimate') then 'scheduled'::job_status else status end,
           hold_reason = case when status::text = 'on_hold' then null else hold_reason end,
           updated_at = now()
     where id = p_job;
    return;
  end if;

  -- A LIVE PLAN: every day it has stays.
  v_first := (j.scheduled_start at time zone v_tz)::date;
  v_last := greatest(v_first, coalesce((j.scheduled_end at time zone v_tz)::date, v_first));
  -- A job from before segments: its days are its span (loadJobDaySegments' fallback).
  if not exists (select 1 from public.job_schedule_segments where job_id = p_job) then
    insert into public.job_schedule_segments (org_id, job_id, start_date, end_date, start_time, end_time)
      values (j.org_id, p_job, v_first, v_last, null, null);
  end if;

  if exists (select 1 from public.job_schedule_segments where job_id = p_job and start_date <= p_day and end_date >= p_day) then
    if v_first = v_last and p_day = v_first then
      -- THE JOB'S ONE DAY, PICKED AGAIN: the pick is its time (the day's own hours give way).
      perform public.job_segment_set_day(p_job, j.org_id, p_day, null, null);
      update public.jobs
         set scheduled_start = (p_day + make_time(v_start / 60, v_start % 60, 0)) at time zone v_tz,
             scheduled_end   = (p_day + make_time(v_end / 60, v_end % 60, 0)) at time zone v_tz,
             status = case when status::text in ('to_be_scheduled', 'estimate') then 'scheduled'::job_status else status end,
             updated_at = now()
       where id = p_job;
    else
      -- A DAY IT ALREADY HAS, of several: that day runs at the picked time.
      perform public.job_segment_set_day(p_job, j.org_id, p_day, make_time(v_start / 60, v_start % 60, 0), make_time(v_end / 60, v_end % 60, 0));
      update public.jobs
         set status = case when status::text in ('to_be_scheduled', 'estimate') then 'scheduled'::job_status else status end,
             updated_at = now()
       where id = p_job;
    end if;
    return;
  end if;

  -- A NEW DAY FOR IT: the span grows to cover the day (the start's time and the length kept, several
  -- days are full days: planJobTimes), and no other day moves.
  v_new_first := least(v_first, p_day);
  v_new_last := greatest(v_last, p_day);
  if v_new_first <> v_first or v_new_last <> v_last then
    v_start_min := extract(hour from (j.scheduled_start at time zone v_tz))::integer * 60
                 + extract(minute from (j.scheduled_start at time zone v_tz))::integer;
    v_start_min := least(v_start_min, 23 * 60 + 58);
    v_new_start := (v_new_first + make_time(v_start_min / 60, v_start_min % 60, 0)) at time zone v_tz;
    -- (closing never past 23:59, so no work-day setting can make the customer's tap an error)
    v_new_end := (v_new_last + make_time(least(v_wd_end, 23 * 60 + 59) / 60, least(v_wd_end, 23 * 60 + 59) % 60, 0)) at time zone v_tz;

    select array_agg(x.day order by x.day) into v_days
      from (
        select distinct d::date as day
          from public.job_schedule_segments s
          cross join lateral generate_series(s.start_date::timestamp, s.end_date::timestamp, interval '1 day') d
         where s.job_id = p_job and s.start_time is null
         limit 400
      ) x;
    foreach v_day in array coalesce(v_days, '{}'::date[]) loop
      select * into v_old from public.job_day_block_min(v_day, j.scheduled_start, j.scheduled_end, j.planned_minutes, v_tz, v_wd_start, v_wd_end);
      select * into v_new from public.job_day_block_min(v_day, v_new_start, v_new_end, j.planned_minutes, v_tz, v_wd_start, v_wd_end);
      if (v_old.start_min, v_old.end_min) is distinct from (v_new.start_min, v_new.end_min)
         and least(v_old.end_min, 23 * 60 + 59) > v_old.start_min then
        perform public.job_segment_set_day(
          p_job, j.org_id, v_day,
          make_time(v_old.start_min / 60, v_old.start_min % 60, 0),
          make_time(least(v_old.end_min, 23 * 60 + 59) / 60, least(v_old.end_min, 23 * 60 + 59) % 60, 0)
        );
      end if;
    end loop;

    update public.jobs
       set scheduled_start = v_new_start,
           scheduled_end = v_new_end,
           status = case when status::text in ('to_be_scheduled', 'estimate') then 'scheduled'::job_status else status end,
           updated_at = now()
     where id = p_job;
  else
    update public.jobs
       set status = case when status::text in ('to_be_scheduled', 'estimate') then 'scheduled'::job_status else status end,
           updated_at = now()
     where id = p_job;
  end if;

  perform public.job_segment_set_day(p_job, j.org_id, p_day, make_time(v_start / 60, v_start % 60, 0), make_time(v_end / 60, v_end % 60, 0));
end $$;

comment on function public.job_takes_picked_day(uuid, date, text) is
  'A job''s part of a customer''s pick-a-date tap (0370): the day lands at the picked time (else the work day''s start) for the job''s length (else two hours), ADDED beside the job''s other days like placeJobOnDay. Internal: called by choose_schedule_slot and choose_schedule_date.';

revoke all on function public.job_day_block_min(date, timestamptz, timestamptz, integer, text, integer, integer) from public, anon, authenticated;
revoke all on function public.job_segment_set_day(uuid, uuid, date, time, time) from public, anon, authenticated;
revoke all on function public.job_takes_picked_day(uuid, date, text) from public, anon, authenticated;

-- ── the two writers, from 0222's bodies ────────────────────────────────────────────────────────
create or replace function public.choose_schedule_slot(p_token text, p_index integer)
returns json language plpgsql security definer set search_path = public as $$
declare
  v       record;
  v_slot  jsonb;
  v_date  date;
  v_time  text;
  v_tz    text;
  v_start timestamptz;
  -- 0370: a day with no time starts at the company's work day, never 08:00.
  v_day_start text;
begin
  select * into v from public.schedule_proposals where token = p_token for update;
  if not found then raise exception 'Unknown link'; end if;
  if v.status <> 'pending' then raise exception 'This link was already used'; end if;
  if v.expires_at is not null and v.expires_at < now() then
    raise exception 'This scheduling link has expired — please call us and we''ll find you a time';
  end if;

  v_slot := v.dates -> p_index;
  if v_slot is null then raise exception 'That option is no longer available'; end if;

  if jsonb_typeof(v_slot) = 'string' then
    v_date := (v_slot #>> '{}')::date;
    v_time := null;
  else
    v_date := (v_slot ->> 'date')::date;
    v_time := nullif(v_slot ->> 'time', '');
  end if;

  v_tz := coalesce((select settings ->> 'timezone' from public.organizations where id = v.org_id), 'America/Los_Angeles');
  v_day_start := coalesce(
    (select settings ->> 'work_day_start' from public.organizations
      where id = v.org_id and settings ->> 'work_day_start' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    '08:00');

  -- INDEPENDENT OF THE WINDOW. A link three weeks old is inside 30 days and may still be
  -- offering last Tuesday. Compared in the ORG's timezone, because "today" on a schedule is the
  -- contractor's today, not UTC's.
  if v_date < (now() at time zone v_tz)::date then
    raise exception 'That day has already passed — please call us and we''ll find you a time';
  end if;

  v_start := (v_date::text || ' ' || coalesce(v_time, v_day_start))::timestamp at time zone v_tz;

  update public.schedule_proposals
    set status = 'confirmed', chosen_date = v_date, chosen_at = v_start
    where id = v.id;

  if v.appointment_id is not null then
    -- Only revive a still-tentative appointment; a cancelled/completed one stays closed.
    update public.appointments
      set starts_at = v_start,
          ends_at = coalesce(ends_at, v_start + interval '1 hour'),
          status = 'scheduled'
      where id = v.appointment_id and status = 'proposed';
    if not found then raise exception 'This appointment is no longer available'; end if;
  elsif v.job_id is not null then
    -- 0370: the picked time (else the work day's start) for the job's length (else two hours),
    -- ADDED beside the job's other days: never start + 8 hours, never 08:00-16:00, and never every
    -- other day of the job (its worked days too) wiped for this one.
    perform public.job_takes_picked_day(v.job_id, v_date, v_time);
  end if;

  return json_build_object('ok', true, 'chosen_at', v_start);
end $$;
grant execute on function public.choose_schedule_slot(text, integer) to anon, authenticated;

create or replace function public.choose_schedule_date(p_token text, p_date date)
returns json language plpgsql security definer set search_path = public as $$
declare
  v    record;
  v_tz text;
begin
  select * into v from public.schedule_proposals where token = p_token for update;
  if not found then raise exception 'Unknown link'; end if;
  if v.status <> 'pending' then raise exception 'This link was already used'; end if;
  if v.expires_at is not null and v.expires_at < now() then
    raise exception 'This scheduling link has expired — please call us and we''ll find you a time';
  end if;
  if not (v.dates ? p_date::text) then raise exception 'That date is not one of the offered options'; end if;

  v_tz := coalesce((select settings ->> 'timezone' from public.organizations where id = v.org_id), 'America/Los_Angeles');

  if p_date < (now() at time zone v_tz)::date then
    raise exception 'That day has already passed — please call us and we''ll find you a time';
  end if;

  update public.schedule_proposals
    set status = 'confirmed', chosen_date = p_date
    where id = v.id;

  -- 0370: the company's work day start for the job's length (else two hours), ADDED beside the
  -- job's other days: never 08:00-16:00, and never every other day of the job wiped for this one.
  if v.job_id is not null then
    perform public.job_takes_picked_day(v.job_id, p_date, null);
  end if;

  return json_build_object('ok', true, 'chosen_date', p_date);
end $$;
grant execute on function public.choose_schedule_date(text, date) to anon, authenticated;
