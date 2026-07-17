-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0133: daily_reports status spine + write guard
-- Audit 2026-07-16 (sanitize-on-read doctrine's sibling: RLS, not the server
-- action, is the real write boundary):
--   1. 0128 documented status as "filed | reviewed" in a comment only — no CHECK,
--      so a direct PostgREST PATCH could store any string.
--   2. daily_reports_update granted the FILER a full own-row update, so a member
--      could flip their own report to 'reviewed' (or insert it pre-reviewed),
--      bypassing the requireStaff gate in markDailyReportReviewed.
-- Fix: a real CHECK constraint + the review flip becomes staff-only in the
-- policy itself (a member's own writes must land status = 'filed', which is
-- exactly what the clock-out debrief upsert sends).
-- DELIBERATELY NOT locked down: gps_summary stays writable by the filer's own
-- upsert (it's server-computed but written through the user's RLS client, and
-- it's badge/display-only — time_entries remain payroll-authoritative).
-- Run AFTER 0130.
-- ═══════════════════════════════════════════════════════════════════════════

-- The status spine, enforced (0128 shipped it as a comment).
alter table public.daily_reports
  drop constraint if exists daily_reports_status_check;
alter table public.daily_reports
  add constraint daily_reports_status_check check (status in ('filed', 'reviewed'));

-- A member re-files (revises) their OWN report but every write of theirs lands
-- back at status 'filed'; only staff mark reviewed (or edit anyone's row —
-- 0128's "filed for office editing" design).
drop policy if exists daily_reports_update on public.daily_reports;
create policy daily_reports_update on public.daily_reports
  for update
  using (org_id = public.auth_org_id() and (profile_id = auth.uid() or public.is_org_staff()))
  with check (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or (profile_id = auth.uid() and status = 'filed'))
  );

-- Same rule at the door: a member can't INSERT a report born 'reviewed'.
drop policy if exists daily_reports_insert on public.daily_reports;
create policy daily_reports_insert on public.daily_reports
  for insert with check (
    org_id = public.auth_org_id()
    and profile_id = auth.uid()
    and (status = 'filed' or public.is_org_staff())
  );
