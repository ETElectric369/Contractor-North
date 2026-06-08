-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0010: per-job time allocations
-- Lets a tech split a day's clock entry across multiple jobs at clock-out,
-- each with hours, a job code, and a description. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.time_allocations (
  id            uuid primary key default gen_random_uuid(),
  time_entry_id uuid not null references public.time_entries(id) on delete cascade,
  org_id        uuid references public.organizations(id) on delete cascade,
  job_id        uuid references public.jobs(id) on delete set null,
  job_code      text,
  hours         numeric(6,2) not null default 0,
  description   text,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists time_allocations_entry_idx
  on public.time_allocations(time_entry_id);

-- Stamp org_id from the signed-in user (set_org_id from 0004).
drop trigger if exists stamp_org_time_allocations on public.time_allocations;
create trigger stamp_org_time_allocations before insert on public.time_allocations
  for each row execute function public.set_org_id();

alter table public.time_allocations enable row level security;

-- A tech manages allocations on their own entries; staff manage all in the org.
drop policy if exists time_allocations_all on public.time_allocations;
create policy time_allocations_all on public.time_allocations
  for all
  using (
    org_id = public.auth_org_id()
    and exists (
      select 1 from public.time_entries te
      where te.id = time_entry_id
        and (te.profile_id = auth.uid() or public.is_org_staff())
    )
  )
  with check (
    org_id = public.auth_org_id()
    and exists (
      select 1 from public.time_entries te
      where te.id = time_entry_id
        and (te.profile_id = auth.uid() or public.is_org_staff())
    )
  );
