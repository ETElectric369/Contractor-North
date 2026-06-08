-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0018: tasks / to-dos
-- A lightweight task system. Tasks can belong to a job (job_id) or stand alone,
-- and are bucketed into one of three areas: sales | operations | office.
-- Run AFTER 0004 (multitenancy helpers + set_org_id/auth_org_id).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  job_id      uuid references public.jobs(id) on delete cascade,
  title       text not null,
  notes       text,
  category    text not null default 'operations'
              check (category in ('sales', 'operations', 'office')),
  status      text not null default 'open'
              check (status in ('open', 'done')),
  priority    integer not null default 0,        -- higher = more important
  due_date    date,
  assigned_to uuid references public.profiles(id) on delete set null,
  completed_at timestamptz,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tasks_job_idx on public.tasks(job_id);
create index if not exists tasks_org_cat_idx on public.tasks(org_id, category, status);
create index if not exists tasks_due_idx on public.tasks(org_id, status, priority desc, due_date);

drop trigger if exists touch_tasks on public.tasks;
create trigger touch_tasks before update on public.tasks
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_tasks on public.tasks;
create trigger stamp_org_tasks before insert on public.tasks
  for each row execute function public.set_org_id();

alter table public.tasks enable row level security;

-- Everyone in the org can see and manage tasks (collaborative to-do list).
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks
  for select using (org_id = public.auth_org_id());

drop policy if exists tasks_write on public.tasks;
create policy tasks_write on public.tasks
  for all using (org_id = public.auth_org_id())
  with check (org_id = public.auth_org_id());
