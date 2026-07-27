-- "CAN'T UNASSIGN BRIAN FROM ANY JOB HE IS ON VACATION" — the structural fix.
--
-- THE BUG, in three steps. The board's "— No job —" option DELETES the crew_day_assignments row.
-- Deleting it hands the cell straight back to INFERENCE, and the inference cannot return "nobody":
-- pickMemberCurrentJob ends `?? byNewest.find(in_progress) ?? byNewest[0] ?? null`, and Brian is
-- still in that job's `assigned_to` roster, so it always finds something. One refresh later the
-- same job is back in the same dropdown. The control that looks like unassign is a visible no-op,
-- and there is no value the office can pick that produces an empty cell.
--
-- THE ROOT CAUSE is that ABSENCE MEANT TWO THINGS. "No row" had to serve as both "nobody has
-- planned this day yet, go ahead and guess" and "this person is deliberately not on a job" — and
-- those need opposite behaviour. So the second one gets a row of its own.
--
--   no row          → nothing planned. Infer, as today. Unchanged.
--   kind='job'      → pinned to that job. Wins over inference, as today. Unchanged.
--   kind='off'      → DELIBERATELY not on a job. Short-circuits every inference tier.
--
-- WHY VACATION IS A DAY FACT, NOT A JOB FACT. Stripping Brian from every jobs.assigned_to array
-- would destroy the roster and force somebody to re-add him, from memory, on every job, next
-- Monday. He hasn't left the Miller crew — he just isn't there this week. So `jobs.assigned_to`
-- (who works this job, undated) is left completely alone, and the week is expressed as five OFF
-- rows against the SSOT for "who works which job on which day".

alter table public.crew_day_assignments
  alter column job_id drop not null;

alter table public.crew_day_assignments
  add column if not exists kind text not null default 'job',
  -- Optional, and cheap now / painful to retrofit: it lets the board read "Vacation" rather than
  -- a bare OFF, which is the difference between a plan somebody can trust and one they re-ask about.
  add column if not exists off_reason text;

alter table public.crew_day_assignments
  drop constraint if exists crew_day_assignments_kind_ck;
alter table public.crew_day_assignments
  add constraint crew_day_assignments_kind_ck
  check (kind in ('job', 'off'));

-- A 'job' row must name a job; an 'off' row must not. Without this, a half-written row would read
-- as "pinned to nothing", which is the exact ambiguity this migration exists to remove.
alter table public.crew_day_assignments
  drop constraint if exists crew_day_assignments_shape_ck;
alter table public.crew_day_assignments
  add constraint crew_day_assignments_shape_ck
  check ((kind = 'job' and job_id is not null) or (kind = 'off' and job_id is null));

alter table public.crew_day_assignments
  drop constraint if exists crew_day_assignments_reason_ck;
alter table public.crew_day_assignments
  add constraint crew_day_assignments_reason_ck
  check (off_reason is null or off_reason in ('vacation', 'sick', 'other'));

comment on column public.crew_day_assignments.kind is
  '''job'' = pinned to job_id for that day. ''off'' = deliberately not on any job (vacation, sick, day off) — short-circuits the job inference so the cell reads OFF instead of a guess, and so the tech''s own Clock In lands job-less rather than on a stale roster job. NO ROW still means "nothing planned yet, infer" — that ambiguity is what made "— No job —" a no-op.';

-- The unique key stays (profile_id, work_date): a person is on one job, or off, on a given day.
