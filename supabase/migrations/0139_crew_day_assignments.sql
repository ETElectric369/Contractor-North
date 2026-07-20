-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0139: crew day assignments
-- Erik's week-planning rework of the /timeclock crew board: the office sets who's
-- on which job PER MEMBER PER DAY (plus a per-day crew-leader flag) and steps
-- through the week. ONE assignment per member per day — mid-shift splits stay the
-- switch-job flow. PRECEDENCE LAW: when a day-assignment exists it WINS over every
-- other "which job is this person on" read (the board pick, the job-less clock-in
-- resolution) — payroll math on time_entries never changes from assignments.
-- profiles.crew_lead (0128) stays the debrief CAPABILITY flag; is_crew_lead here
-- is "who leads the crew THAT day".
-- Run AFTER 0004 (needs auth_org_id() / is_org_staff() / set_org_id()).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.crew_day_assignments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  work_date    date not null,
  job_id       uuid not null references public.jobs(id) on delete cascade,
  is_crew_lead boolean not null default false,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  -- ONE assignment per member per day — the day-picker's upsert target. Profile ids
  -- are globally unique, so no org column is needed in the key (RLS scopes reads).
  unique (profile_id, work_date)
);

-- Hot path: the week grid under the timeclock ("this org, these 7 days").
create index if not exists crew_day_assignments_org_date_idx
  on public.crew_day_assignments(org_id, work_date);

-- Auto-stamp org_id from the signed-in assigner (the 0004 pattern — fills only
-- when the insert didn't pass it; org_id stays NOT NULL because the trigger runs
-- BEFORE INSERT, the bug_reports/0128 lineage).
drop trigger if exists stamp_org_crew_day_assignments on public.crew_day_assignments;
create trigger stamp_org_crew_day_assignments before insert on public.crew_day_assignments
  for each row execute function public.set_org_id();

alter table public.crew_day_assignments enable row level security;

-- Org members READ their org's board — a tech may see where the week puts them
-- (the same per-org read pattern as daily_reports_read, 0128).
drop policy if exists crew_day_assignments_read on public.crew_day_assignments;
create policy crew_day_assignments_read on public.crew_day_assignments
  for select using (org_id = public.auth_org_id());

-- Only STAFF write (insert/update/delete) — assignment is office work. Enforced
-- HERE in policy, not just in the server action (RLS is the real write boundary).
drop policy if exists crew_day_assignments_staff on public.crew_day_assignments;
create policy crew_day_assignments_staff on public.crew_day_assignments
  for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
