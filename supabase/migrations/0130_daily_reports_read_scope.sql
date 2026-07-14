-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0130: daily_reports read scope
-- 0128's daily_reports_read was org-wide (any member), but a report's
-- gps_summary carries a colleague's hours / miles / per-job breakdown — the
-- exact data the time_entries select policy deliberately hides from non-staff
-- (0004: own-row OR staff). Tighten the read to the same own-or-staff rule.
-- No UI needs member-wide read: the only readers (the /planner card and the
-- /timecards review list) are staff-gated, and the filer only needs their own.
-- Run AFTER 0128.
-- ═══════════════════════════════════════════════════════════════════════════

-- Mirrors time_entries_select (0004): a member reads only their OWN report
-- within the org; staff read all of the org's.
drop policy if exists daily_reports_read on public.daily_reports;
create policy daily_reports_read on public.daily_reports
  for select using (
    org_id = public.auth_org_id()
    and (profile_id = auth.uid() or public.is_org_staff())
  );
