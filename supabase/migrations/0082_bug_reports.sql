-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0082: bug reports (the debug channel)
-- A one-tap "Report a bug" button (staff only) files a report tagged with the page,
-- the captured console errors, browser/viewport, the reporter, and their note. Each
-- org sees its own reports; the dev (Claude) reads across orgs directly.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.bug_reports (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references public.organizations(id) on delete cascade,
  reported_by  uuid references public.profiles(id) on delete set null,
  page         text,
  note         text not null,
  console      jsonb not null default '[]',
  user_agent   text,
  viewport     text,
  status       text not null default 'open',  -- open | fixed | wontfix
  created_at   timestamptz not null default now()
);
create index if not exists bug_reports_org_idx on public.bug_reports(org_id, created_at desc);

drop trigger if exists stamp_org_bug_reports on public.bug_reports;
create trigger stamp_org_bug_reports before insert on public.bug_reports
  for each row execute function public.set_org_id();

alter table public.bug_reports enable row level security;

-- Anyone in the org can FILE a report (so the button can later open to field crew too);
-- only staff READ / update / delete them (the debug team).
drop policy if exists bug_reports_insert on public.bug_reports;
create policy bug_reports_insert on public.bug_reports
  for insert with check (org_id = public.auth_org_id());

drop policy if exists bug_reports_staff on public.bug_reports;
create policy bug_reports_staff on public.bug_reports
  for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
