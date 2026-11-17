-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0410: a worker reads his own pay periods
--
-- The owner, 2026-11-16: "yes for tech sees all their own data and past pay periods". A locked pay
-- period's gross is FROZEN on its payroll_runs row at the rate paid then (markPeriodPaid), and a
-- raise applies forward only. A worker's own statement cannot be right without that frozen half: a
-- page that re-priced locked hours at today's rate would restate last month the day of a raise.
--
-- WHAT THIS CHANGES: payroll_runs_read, and nothing else. Staff still read the whole company; anyone
-- else now reads the rows whose profile_id is his own, inside his own company. It is the shape
-- pay_payments has had since 0264 and profile_pay since 0215. The write policy (0062) is untouched:
-- recording a lock or a mileage settlement stays an office act. An owner has no rows here (0286).
--
-- THE READER, named the day it is added: src/app/(app)/timeclock/pay (My Pay Periods).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.payroll_runs') is null then
    raise exception '0410: public.payroll_runs is not on this database (0062). Nothing was changed.';
  end if;
  if to_regprocedure('public.auth_org_id()') is null then
    raise exception '0410: public.auth_org_id() is missing (0158). Nothing was changed.';
  end if;
  if to_regprocedure('public.is_org_staff()') is null then
    raise exception '0410: public.is_org_staff() is missing (0158). Nothing was changed.';
  end if;
end $$;

drop policy if exists payroll_runs_read on public.payroll_runs;
create policy payroll_runs_read on public.payroll_runs
  for select using (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or profile_id = auth.uid())
  );

comment on policy payroll_runs_read on public.payroll_runs is
  'Staff read the company''s pay runs; anyone else only his own (0410), so a worker''s statement reads each locked period at the gross it locked at. Writes stay staff-only (payroll_runs_write, 0062).';

do $$
declare
  v_qual text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.payroll_runs'::regclass) then
    raise exception '0410: row level security is off on payroll_runs. Nothing was changed.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'payroll_runs' and cmd = 'SELECT') <> 1 then
    raise exception '0410: payroll_runs does not have its one select policy. Nothing was changed.';
  end if;
  select qual into v_qual from pg_policies
   where schemaname = 'public' and tablename = 'payroll_runs' and policyname = 'payroll_runs_read';
  if v_qual is null or position('auth_org_id()' in v_qual) = 0 or position('auth.uid()' in v_qual) = 0
     or position('is_org_staff()' in v_qual) = 0 then
    raise exception '0410: payroll_runs_read is not "own company, and staff or his own row". Nothing was changed.';
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'payroll_runs' and cmd <> 'SELECT'
       and (coalesce(position('is_org_staff()' in qual), 0) = 0
            or coalesce(position('is_org_staff()' in with_check), 0) = 0)
  ) then
    raise exception '0410: a payroll_runs write policy is not staff-only. Nothing was changed.';
  end if;
  raise notice '0410: a worker reads his own pay runs; staff read the company''s; only staff write.';
end $$;
