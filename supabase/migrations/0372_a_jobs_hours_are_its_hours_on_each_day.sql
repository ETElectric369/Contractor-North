-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0372: a job's hours are its hours on each of its days
--
-- Erik, 2026-09-29, on 700 North Lake Boulevard: a second date range turned his 10–12 job into "full
-- days", stamped the end at closing over the end he set, and hid the End box and the length chips.
-- The "several days are full days" rule (cn-v1030) was written for one contiguous stretch and fired
-- for two separate days. lib/schedule/job-block jobDayBlock now reads a job's usual hours the same
-- way on every day it has: its start to its stored end AS TIMES OF DAY (the end is stored on the
-- last day; its clock time is the end on each day). A day that keeps its own hours (0370) still
-- draws its own.
--
-- job_day_block_min (0370) is that rule's SQL twin, read by job_takes_picked_day when a customer's
-- pick grows a job's span: every other day whose drawn block that growth would change keeps the
-- block it had. Left on the old rule it would have frozen days at hours the app no longer draws
-- (the first day to closing, the middle days full, the last from the opening), and the DB suite
-- that pins the twin (lib/each-day-hours.integration.test.ts) said so. This is the same function,
-- FROM 0370'S BODY, with only the many-days branch gone: one rule for any day of the plan.
--
-- What does NOT change: the signature, the grants (internal; revoked from every role below, as
-- 0370 left it), job_takes_picked_day and job_segment_set_day, and the pick's own write (the span
-- grows with its start kept and the new last day to closing, as before).
--
-- Safe to run twice: create or replace + revoke.
-- ═══════════════════════════════════════════════════════════════════════════

-- WHERE A JOB SITS ON ONE DAY, by its usual hours: the twin of lib/schedule/job-block jobDayBlock
-- (without a day's own hours, which the caller checks first). Minutes past the company's midnight.
--   any day of the plan: its start to its stored end, as times of day; a job sized under a day whose
--               end is just closing (or missing) draws its size; an end missing or not after the
--               start runs to closing.
--   outside:    a day outside the span (history) is full.
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
  -- The end's clock time is the end on EVERY day of the plan, whatever day it is stored on.
  v_e := case
           when p_end is not null
           then extract(hour from (p_end at time zone p_tz))::integer * 60 + extract(minute from (p_end at time zone p_tz))::integer
         end;

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
  'Where a job sits on one day by its usual hours, in minutes past the company''s midnight (0370, one rule for every day of the plan since 0372): the SQL twin of lib/schedule/job-block jobDayBlock. Internal: called by job_takes_picked_day.';

revoke all on function public.job_day_block_min(date, timestamptz, timestamptz, integer, text, integer, integer) from public, anon, authenticated;
