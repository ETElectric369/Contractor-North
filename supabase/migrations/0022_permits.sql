-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0022: permits & inspections
-- Tracks permits pulled for a job and their inspections. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.permits (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references public.organizations(id) on delete cascade,
  job_id             uuid references public.jobs(id) on delete cascade,
  permit_number      text,
  type               text not null default 'Electrical',
  authority          text,                       -- issuing jurisdiction / dept
  status             text not null default 'applied',
                     -- not_submitted | applied | issued | scheduled | passed | failed | closed
  applied_date       date,
  issued_date        date,
  expires_date       date,
  fee                numeric(12,2) not null default 0,
  inspection_date    date,
  inspector          text,
  inspection_result  text not null default 'pending',  -- pending | passed | failed | partial
  notes              text,
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists permits_job_idx on public.permits(job_id);
create index if not exists permits_org_idx on public.permits(org_id, status);

drop trigger if exists touch_permits on public.permits;
create trigger touch_permits before update on public.permits
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_permits on public.permits;
create trigger stamp_org_permits before insert on public.permits
  for each row execute function public.set_org_id();

alter table public.permits enable row level security;

drop policy if exists permits_read on public.permits;
create policy permits_read on public.permits
  for select using (org_id = public.auth_org_id());

drop policy if exists permits_write on public.permits;
create policy permits_write on public.permits
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
