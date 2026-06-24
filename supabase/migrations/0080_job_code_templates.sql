-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0080: job-code templates
-- A template is a named group of the org's job codes for a TYPE of job (e.g. a
-- "Full deck build" template = DEMO/FOOT/FRAME/DECK/RAIL/STAIR/FINISH). Apply one
-- to a job and the crew's clock-in/clock-out code pickers show only that job's
-- codes — so people pick the right code for the work. Run AFTER 0079.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.job_code_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  name        text not null,
  codes       text[] not null default '{}',
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists job_code_templates_org_idx on public.job_code_templates(org_id);

-- Stamp org_id from the signed-in user (set_org_id from 0004).
drop trigger if exists stamp_org_job_code_templates on public.job_code_templates;
create trigger stamp_org_job_code_templates before insert on public.job_code_templates
  for each row execute function public.set_org_id();

alter table public.job_code_templates enable row level security;

-- Everyone in the org can READ templates (the timeclock needs them); only staff
-- create/edit/delete (templates are configuration).
drop policy if exists job_code_templates_read on public.job_code_templates;
create policy job_code_templates_read on public.job_code_templates
  for select using (org_id = public.auth_org_id());

drop policy if exists job_code_templates_write on public.job_code_templates;
create policy job_code_templates_write on public.job_code_templates
  for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- Which template's codes a job uses (null = all org codes).
alter table public.jobs add column if not exists code_template_id uuid
  references public.job_code_templates(id) on delete set null;
