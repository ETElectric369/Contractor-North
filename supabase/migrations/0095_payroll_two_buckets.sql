-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0095: payroll two buckets — base pay vs mileage settle SEPARATELY.
-- Base pay lock stays time_entries.paid_at, which now means BASE settled ONLY.
-- Mileage gets its own lock (mileage_paid_at) + its own kind='mileage' run rows.
-- Mileage dollars are only ever HUMAN-STATED at settlement (mileage_amount) —
-- never rate × miles math — so the reimbursement-law question stays open.
-- Nothing anywhere sums the two buckets.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.time_entries
  add column if not exists mileage_paid_at timestamptz;

alter table public.payroll_runs
  add column if not exists kind text not null default 'base'
    check (kind in ('base','mileage'));
alter table public.payroll_runs
  add column if not exists mileage_amount numeric(12,2); -- stated reimbursement $ (kind='mileage' only)

comment on column public.payroll_runs.kind is
  'base = wages (hours×rate ⇒ gross, miles 0) · mileage = reimbursement settlement (miles + stated mileage_amount, gross 0). Never summed.';

-- Shape guard: a run row carries wage dollars OR a stated mileage settlement,
-- never both. Base-row `miles` is deliberately UNCONSTRAINED here: during the
-- migrate→deploy window the old markPeriodPaid still snapshots miles onto base
-- rows; tighten to `miles = 0` in a follow-up migration once the new code is
-- live. (No ADD CONSTRAINT IF NOT EXISTS in Postgres — drop first, project style.)
alter table public.payroll_runs drop constraint if exists payroll_runs_bucket_shape;
alter table public.payroll_runs add constraint payroll_runs_bucket_shape check (
  (kind = 'base' and mileage_amount is null)
  or (kind = 'mileage' and gross = 0 and rate = 0 and hours = 0 and mileage_amount is not null and mileage_amount >= 0)
);

-- Tamper backstop. time_entries_update RLS (0004) lets a tech update their OWN
-- rows — which, via direct PostgREST, includes rows in a paid period and the two
-- paid locks themselves. Non-staff may not touch a settled row, and may never
-- move either lock. All payroll/timeclock server actions run as staff, so app
-- paths are unaffected; this only closes the crafted-request path.
create or replace function public.guard_paid_time_entry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_org_staff() then
    if old.paid_at is not null or old.mileage_paid_at is not null then
      raise exception 'Entry is in a paid period — ask the office to undo it on Payroll first.';
    end if;
    if new.paid_at is distinct from old.paid_at
       or new.mileage_paid_at is distinct from old.mileage_paid_at then
      raise exception 'Only office staff can change payroll locks.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_paid_time_entry on public.time_entries;
create trigger guard_paid_time_entry before update on public.time_entries
  for each row execute function public.guard_paid_time_entry();
