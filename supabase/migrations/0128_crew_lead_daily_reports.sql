-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0128: crew leads + daily reports
-- Erik's timeclock rework: a CREW LEAD (any role) answers two questions after
-- clock-out — "What did you do today?" and "What materials do you need
-- tomorrow?" — and Nort files the answers (plus a GPS-derived day summary:
-- total hours, miles, per-job time) for the office to review/edit. One report
-- per person per org-local day (the debrief upserts, so re-filing revises).
-- Run AFTER 0004 (needs auth_org_id() / is_org_staff() / set_org_id()).
-- ═══════════════════════════════════════════════════════════════════════════

-- Who owes the end-of-day debrief. The office toggles this on /team (Edit & Role).
alter table public.profiles add column if not exists crew_lead boolean not null default false;

create table if not exists public.daily_reports (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references public.organizations(id) on delete cascade,
  profile_id         uuid references public.profiles(id),
  report_date        date not null,
  did_today          text,
  materials_tomorrow text,
  -- GPS tells the story: { total_hours, miles, first_in, last_out, jobs:[{ job_id, label, hours }] }
  gps_summary        jsonb,
  status             text not null default 'filed', -- filed | reviewed
  created_at         timestamptz default now(),
  -- One report per person per org-local day — the debrief's upsert target.
  unique (org_id, profile_id, report_date)
);

-- Hot path: the boss's My Day card ("today's reports, newest first").
create index if not exists daily_reports_org_date_idx
  on public.daily_reports(org_id, report_date desc);

-- Auto-stamp org_id from the signed-in filer (the 0004 pattern).
drop trigger if exists stamp_org_daily_reports on public.daily_reports;
create trigger stamp_org_daily_reports before insert on public.daily_reports
  for each row execute function public.set_org_id();

alter table public.daily_reports enable row level security;

-- Org members read their org's reports (mirrors the per-org read pattern, e.g. 0103).
drop policy if exists daily_reports_read on public.daily_reports;
create policy daily_reports_read on public.daily_reports
  for select using (org_id = public.auth_org_id());

-- A member files their OWN report (the clock-out debrief); always org-scoped.
drop policy if exists daily_reports_insert on public.daily_reports;
create policy daily_reports_insert on public.daily_reports
  for insert with check (org_id = public.auth_org_id() and profile_id = auth.uid());

-- Re-filing the same day updates the filer's OWN row; staff can edit/review anyone's
-- ("filed for office editing").
drop policy if exists daily_reports_update on public.daily_reports;
create policy daily_reports_update on public.daily_reports
  for update using (org_id = public.auth_org_id() and (profile_id = auth.uid() or public.is_org_staff()))
  with check (org_id = public.auth_org_id() and (profile_id = auth.uid() or public.is_org_staff()));

-- Only staff remove a filed report.
drop policy if exists daily_reports_delete on public.daily_reports;
create policy daily_reports_delete on public.daily_reports
  for delete using (org_id = public.auth_org_id() and public.is_org_staff());
