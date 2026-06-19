-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0062: payroll runs + paid-hours lock
-- "Mark as paid" stamps a pay period's closed time entries with paid_at (so they
-- drop off the unpaid total and can't be paid twice) and records a payroll_runs
-- snapshot per employee for the accountant export. Staff-only, org-scoped —
-- follows the petty_cash/0056 financial pattern.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.time_entries add column if not exists paid_at timestamptz;

create table if not exists public.payroll_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references public.organizations(id) on delete cascade,
  profile_id   uuid references public.profiles(id) on delete set null,
  period_start date not null,
  period_end   date not null, -- exclusive
  hours        numeric(10,2) not null default 0,
  miles        numeric(10,2) not null default 0,
  rate         numeric(12,2) not null default 0,
  gross        numeric(12,2) not null default 0,
  note         text,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create index if not exists payroll_runs_org_idx on public.payroll_runs(org_id, period_start);

drop trigger if exists stamp_org_payroll_runs on public.payroll_runs;
create trigger stamp_org_payroll_runs before insert on public.payroll_runs
  for each row execute function public.set_org_id();

alter table public.payroll_runs enable row level security;

drop policy if exists payroll_runs_read on public.payroll_runs;
create policy payroll_runs_read on public.payroll_runs
  for select using (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists payroll_runs_write on public.payroll_runs;
create policy payroll_runs_write on public.payroll_runs
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
