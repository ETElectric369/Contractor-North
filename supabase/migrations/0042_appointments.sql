-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0042: appointments & inspections
-- A lightweight scheduled-event entity, separate from jobs: site visits,
-- estimate appointments, and code inspections. Shows on the calendar at its
-- actual time (unlike date-only job scheduling). Can link to a job/customer.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.appointments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  job_id      uuid references public.jobs(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  type        text not null default 'appointment'
              check (type in ('appointment', 'inspection')),
  title       text not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  location    text,
  notes       text,
  status      text not null default 'scheduled'
              check (status in ('scheduled', 'completed', 'cancelled')),
  assigned_to uuid references public.profiles(id) on delete set null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists appointments_org_time_idx on public.appointments(org_id, starts_at);
create index if not exists appointments_job_idx on public.appointments(job_id);

drop trigger if exists stamp_org_appointments on public.appointments;
create trigger stamp_org_appointments before insert on public.appointments
  for each row execute function public.set_org_id();

alter table public.appointments enable row level security;

drop policy if exists appointments_rw on public.appointments;
create policy appointments_rw on public.appointments
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
