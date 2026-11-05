-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0403: a bill that names the estimate settles the work
--
-- WHY. The owner, 2026-11-04: Needs You showed June estimates as needing a day on a job long
-- finished and billed. Every row built from an estimate now asks ONE rule
-- (src/lib/action-items/quote-settled.ts quoteSettled), and that rule reads the invoice that NAMES
-- the estimate (invoices.quote_id, 0001) — a bill put on another job, or on none. Done, Not Billed
-- (public.needs_you_done_not_billed, 0371) was blind to the same bill: a finished job whose work was
-- billed on another job's invoice naming this job's estimate kept asking to be billed. And a visit on
-- a job of the retired status invoiced (0127 moved those to complete; the word is still in the enum)
-- was read as unbilled.
--
-- WHAT. needs_you_done_not_billed is replaced (create or replace: the same signature, the same
-- columns, the same grants), with 0371's rules exactly as they were, plus:
--   visits  also leave when a real (not draft, not void) invoice names one of their job's estimates
--           (invoices.quote_id = a quote whose job_id is the visit's job), and when their job's
--           status is invoiced.
--   jobs    also leave when a real invoice names one of the job's estimates. (A job of status
--           invoiced never entered: the arm reads status complete only.)
-- The code side keeps in step: src/lib/action-items/done-not-billed.ts legacyDoneItems (the deploy
-- window's reads) applies the same two rules, and Needs You's ⋯ Already Invoiced
-- (lib/action-items/already-invoiced) writes exactly the fact read here: it names the job's estimate
-- on the invoice when the invoice bills another job.
--
-- WHO. Unchanged from 0371: SECURITY INVOKER, every branch filters org_id = public.auth_org_id()
-- (the joined quotes too: three companies share one database), nothing unless public.is_org_staff(),
-- execute for the signed-in role alone.
--
-- ORDER. Either side of the deploy: before it, the function answers 0371's rules. No table touched,
-- no rows written, no lock on a hot table (a function body only). Twice-safe (create or replace).
-- ONE TRANSACTION: the runners wrap the file in begin/commit; lib/done-not-billed.integration.test
-- applies 0371 and then this file inside its own rolled-back transaction.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.needs_you_done_not_billed(timestamptz, timestamptz, integer)') is null then
    raise exception '0403: needs_you_done_not_billed (0371) is not on this database. Apply 0371 first. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'invoices' and column_name = 'quote_id'
  ) then
    raise exception '0403: invoices.quote_id (0001) is missing. Nothing was changed.';
  end if;
end $$;

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
       -- 0403: or a real invoice NAMES one of its job's estimates, wherever it was put
       and not (a.job_id is not null and exists (
             select 1
               from public.invoices n
               join public.quotes q on q.id = n.quote_id and q.org_id = me.org_id
              where q.job_id = a.job_id
                and n.org_id = me.org_id
                and n.status not in ('draft', 'void')))
       -- 0403: or its job carries the retired status invoiced (billed, by the word of its day)
       and coalesce(j.status::text, '') <> 'invoiced'
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
       -- 0403: nor one that NAMES one of the job's estimates (a job billed on another job's invoice)
       and not exists (
             select 1
               from public.invoices n
               join public.quotes q on q.id = n.quote_id and q.org_id = me.org_id
              where q.job_id = j.id
                and n.org_id = me.org_id
                and n.status not in ('draft', 'void'))
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
  'Needs You''s Done, Not Billed (0371, 0403): finished visits (service_call/job, completed, not absorbed) and complete jobs since the two floors that no bill settles, OLDEST first, with the true total. Visits: not paid through an anchored invoice, not on a job with real billing, not on a job one of whose estimates a real invoice names (0403), not on an invoiced job (0403); open_invoice_id is the anchored unpaid one. Jobs: no invoice but drafts and voids, and no real invoice naming one of its estimates (0403). Staff of the caller''s own company only (security invoker, org filter, is_org_staff).';

revoke all on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) to authenticated;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_fn  regprocedure := 'public.needs_you_done_not_billed(timestamptz, timestamptz, integer)'::regprocedure;
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = v_fn;
  if v_src is null then
    raise exception '0403: needs_you_done_not_billed is missing after the replace. Nothing was changed.';
  end if;
  if (select prosecdef from pg_proc where oid = v_fn) then
    raise exception '0403: needs_you_done_not_billed runs as its owner, past row security. Nothing was changed.';
  end if;
  if (select provolatile from pg_proc where oid = v_fn) <> 's' then
    raise exception '0403: needs_you_done_not_billed is not stable. Nothing was changed.';
  end if;
  if position('join public.quotes q on q.id = n.quote_id' in v_src) = 0 or position('<> ''invoiced''' in v_src) = 0 then
    raise exception '0403: the function does not read the invoice naming the estimate, or the invoiced status. Nothing was changed.';
  end if;
  if position('public.auth_org_id()' in v_src) = 0 or position('public.is_org_staff()' in v_src) = 0 then
    raise exception '0403: the function lost its company filter or its staff gate. Nothing was changed.';
  end if;
  if has_function_privilege('anon', v_fn, 'execute') then
    raise exception '0403: a signed-out caller could read Done, Not Billed. Nothing was changed.';
  end if;
  if not has_function_privilege('authenticated', v_fn, 'execute') then
    raise exception '0403: the signed-in role cannot call Done, Not Billed. Nothing was changed.';
  end if;
  raise notice '0403: a bill that names the estimate settles the work — Done, Not Billed leaves a job or a visit whose estimate a real invoice names, and a visit on an invoiced job.';
end $$;
