-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0385: a visit knows what it became, and a T&M job reports back
--
-- 1. The visit → estimate link lives INSIDE the capture (capture.quote_id, stamped by saveQuote).
--    Every door that closes a visit from the estimate's side (0205's outcome stamp, the quote → job
--    door) looked the visit up by inquiry_id or job_id only, so a visit that had neither stayed
--    "still open business" after its estimate became a job or was declined. cn-v1069 makes ONE
--    function read all three links; this backfills the rows those doors missed. Twice-safe: every
--    write is guarded by the column still being null.
-- 2. jobs.report_back_at — when the office told a time-and-materials customer where the job stands
--    ("I'll let you know when I get into it far enough"). Null = not yet. Read by the Needs You
--    item and the job page's Report Back card (cn-v1069).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.jobs add column if not exists report_back_at timestamptz;
comment on column public.jobs.report_back_at is
  'When the office told a T&M customer where the job stands (cn-v1069, Told Them on the job page). Null = not yet; the Needs You report-back item asks until it is set.';

do $$
declare
  v_jobs int := 0;
  v_outcomes int := 0;
begin
  -- The visit's estimate has a job and the visit has none: attach (NOT absorbed — an attached
  -- inspection stays a live record, 0237).
  with linked as (
    select a.id as appt_id, q.job_id
      from public.appointments a
      join public.quotes q
        on q.id = nullif(a.capture->>'quote_id', '')::uuid
       and q.org_id = a.org_id
     where a.job_id is null and q.job_id is not null
  )
  update public.appointments a
     set job_id = l.job_id, updated_at = now()
    from linked l
   where a.id = l.appt_id;
  get diagnostics v_jobs = row_count;

  -- The visit's estimate was decided and the visit never heard: won / lost, where still open. An
  -- estimate that became a job was won whatever its status says (a draft can be turned straight
  -- into the job; the work is the acceptance).
  with decided as (
    select a.id as appt_id,
           case
             when q.job_id is not null or q.status = 'accepted' then 'won'
             when q.status in ('declined', 'expired') then 'lost'
           end as outcome
      from public.appointments a
      join public.quotes q
        on q.id = nullif(a.capture->>'quote_id', '')::uuid
       and q.org_id = a.org_id
     where a.outcome is null
       and (q.job_id is not null or q.status in ('accepted', 'declined', 'expired'))
  )
  update public.appointments a
     set outcome = d.outcome, outcome_at = now(), updated_at = now()
    from decided d
   where a.id = d.appt_id;
  get diagnostics v_outcomes = row_count;

  raise notice '0385: % visit(s) attached to the job their estimate became; % visit(s) given their estimate''s outcome', v_jobs, v_outcomes;
end $$;
