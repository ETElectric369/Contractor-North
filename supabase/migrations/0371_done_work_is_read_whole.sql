-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0371: done work is read whole
--
-- WHY. Needs You's "Done, Not Billed" pile (money already earned and not yet asked for: a service
-- call or a job-day finished with no bill, or a job flipped to Complete with no invoice) read the
-- candidates first and dropped the billed ones afterwards, in code:
--   · completed visits since the books start, NEWEST first, limit 100;
--   · finished jobs since the books start, newest first, limit 50;
--   · "is this job billed?" from an unordered read of up to 5,000 invoices.
-- Once the newest 100 visits were mostly billed, the OLDEST unbilled service call was the one cut:
-- the worst one to lose, and nothing on screen said so. The pile's "N+" and See All only knew what
-- had been read.
--
-- WHAT. One function, public.needs_you_done_not_billed, answers the billed-or-not question in SQL
-- over EVERY candidate since the floors and hands back only the unbilled ones, OLDEST first, each
-- with the true total (count(*) over ()), so a cut never drops the oldest earned work and the pile
-- says "N+" only when there really are more. The rules are exactly the ones the code applied
-- (src/lib/action-items/done-not-billed.ts legacyDoneItems, before this):
--   visits  appointments with absorbed = false, type service_call or job, status completed, starts
--           at or after p_visit_from; NOT settled (a non-void invoice anchored to the visit with
--           amount_paid > 0); NOT on a job that has real billing (a job invoice not draft or void).
--           The anchored, unpaid, non-void invoice rides along as open_invoice_id (the row's
--           "Billed, Not Paid" chip and its Get Paid). 0233 allows one live invoice per visit.
--   jobs    status complete, updated at or after p_job_from, with no invoice that is not draft or
--           void.
-- What still depends on other rows of the build stays in code: a visit whose open invoice is already
-- a Late Invoices row, and a finished job whose bill is a draft on Now.
--
-- THE FLOORS ARE INSTANTS (timestamptz): the org's midnight of the floor day, exactly the value the
-- two reads it replaces filtered on (lib/action-items/query.ts dayStartIso). A bare date here would
-- be read as UTC midnight, 5 PM the day before in Pacific time, and the row set would not be today's.
--
-- WHO. SECURITY INVOKER: every table read is the caller's own, under its row security. Every branch
-- also filters org_id = public.auth_org_id() itself (three companies share one database), and it
-- returns nothing unless public.is_org_staff() (a tech's build never asks, and gets nothing if it
-- did). Execute is the signed-in role's alone.
--
-- THE CODE DEPLOYS BEFORE THIS RUNS. Until it is applied, the call answers PGRST202 / 42883 and the
-- build runs the two reads it replaced, unchanged, and says so once to the ops sink (reportError);
-- any other failure is a "Couldn't Check" line on Needs You, never a quiet zero.
--
-- A new function: nothing it replaces, no table touched, no rows written, no locks on a hot table.
-- Runs twice without complaint (create or replace). ONE TRANSACTION: the runners wrap the file in
-- begin/commit; lib/done-not-billed.integration.test applies it inside its own rolled-back
-- transaction when the test database doesn't carry it yet.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '15s';

create or replace function public.needs_you_done_not_billed(
  p_visit_from timestamptz,
  p_job_from timestamptz,
  p_limit integer default 200
)
returns table (
  src text,
  id uuid,
  job_id uuid,
  title text,
  job_number text,
  job_name text,
  customer_name text,
  at timestamptz,
  open_invoice_id uuid,
  total_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with me as (
    select public.auth_org_id() as org_id, public.is_org_staff() as staff
  ),
  visits as (
    select 'visit'::text as src,
           a.id,
           a.job_id,
           a.title,
           j.job_number,
           j.name as job_name,
           coalesce(c.name, i.name) as customer_name,
           a.starts_at as at,
           open_inv.id as open_invoice_id
      from me
      join public.appointments a on a.org_id = me.org_id
      left join public.customers c on c.id = a.customer_id and c.org_id = me.org_id
      left join public.inquiries i on i.id = a.inquiry_id and i.org_id = me.org_id
      left join public.jobs j on j.id = a.job_id and j.org_id = me.org_id
      left join lateral (
        select v.id
          from public.invoices v
         where v.appointment_id = a.id
           and v.org_id = me.org_id
           and v.status <> 'void'
           and coalesce(v.amount_paid, 0) <= 0
         order by v.created_at, v.id
         limit 1
      ) open_inv on true
     where me.staff
       and a.absorbed = false
       and a.type in ('service_call', 'job')
       and a.status = 'completed'
       and a.starts_at >= p_visit_from
       -- settled: a live invoice anchored to the visit that has collected money
       and not exists (
             select 1
               from public.invoices p
              where p.appointment_id = a.id
                and p.org_id = me.org_id
                and p.status <> 'void'
                and p.amount_paid > 0)
       -- its job carries real billing (a draft is work in progress, not a decision)
       and not (a.job_id is not null and exists (
             select 1
               from public.invoices b
              where b.job_id = a.job_id
                and b.org_id = me.org_id
                and b.status not in ('draft', 'void')))
  ),
  finished_jobs as (
    select 'job'::text as src,
           j.id,
           j.id as job_id,
           null::text as title,
           j.job_number,
           j.name as job_name,
           c.name as customer_name,
           j.updated_at as at,
           null::uuid as open_invoice_id
      from me
      join public.jobs j on j.org_id = me.org_id
      left join public.customers c on c.id = j.customer_id and c.org_id = me.org_id
     where me.staff
       and j.status = 'complete'
       and j.updated_at >= p_job_from
       and not exists (
             select 1
               from public.invoices b
              where b.job_id = j.id
                and b.org_id = me.org_id
                and b.status not in ('draft', 'void'))
  ),
  done as (
    select * from visits
    union all
    select * from finished_jobs
  )
  select d.src, d.id, d.job_id, d.title, d.job_number, d.job_name, d.customer_name, d.at, d.open_invoice_id,
         count(*) over () as total_count
    from done d
   order by d.at asc, d.src, d.id
   limit greatest(coalesce(p_limit, 200), 0);
$$;

comment on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) is
  'Needs You''s Done, Not Billed (0371): finished visits (service_call/job, completed, not absorbed) and complete jobs since the two floors that no bill settles, OLDEST first, with the true total. Visits: not paid through an anchored invoice, not on a job with real billing; open_invoice_id is the anchored unpaid one. Jobs: no invoice but drafts and voids. Staff of the caller''s own company only (security invoker, org filter, is_org_staff).';

revoke all on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) to authenticated;
