-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0030: safety / OSHA records
-- Incident reports (OSHA recordables) and toolbox-talk / safety-meeting logs.
-- Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.safety_records (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  kind        text not null default 'incident',   -- incident | toolbox
  record_date date not null default current_date,
  title       text not null,
  profile_id  uuid references public.profiles(id) on delete set null,
  job_id      uuid references public.jobs(id) on delete set null,
  severity    text,                                -- first_aid | recordable | lost_time
  recordable  boolean not null default false,
  description text,
  attendees   text,                                -- toolbox-talk attendees (free text)
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists safety_org_idx on public.safety_records(org_id, kind, record_date);

drop trigger if exists stamp_org_safety on public.safety_records;
create trigger stamp_org_safety before insert on public.safety_records
  for each row execute function public.set_org_id();

alter table public.safety_records enable row level security;

drop policy if exists safety_read on public.safety_records;
create policy safety_read on public.safety_records
  for select using (org_id = public.auth_org_id());

drop policy if exists safety_write on public.safety_records;
create policy safety_write on public.safety_records
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
