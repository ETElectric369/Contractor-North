-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0135: bug reports from external site collaborators
-- The /content surface (outside SEO pros like Jill/Owen) gets the same "Report a
-- bug" button as the app. A collaborator's profile has org_id NULL, so
-- auth_org_id() is null and the org-scoped insert policy denied them; admit an
-- insert that explicitly targets a GRANTED org. Staff/member inserts are
-- unchanged (their branch of the policy is identical), and reads/updates stay
-- staff-only via the untouched bug_reports_staff policy — a collaborator cannot
-- read back even their own report.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists bug_reports_insert on public.bug_reports;
create policy bug_reports_insert on public.bug_reports
  for insert with check (
    org_id = public.auth_org_id()
    or public.is_site_collaborator(org_id)
  );
-- Note: the set_org_id trigger only stamps org_id when NULL, so the explicit
-- org_id a collaborator sends passes through; a collaborator inserting WITHOUT
-- an org_id gets NULL stamped and both branches fail — deny by default.

-- The /bugs triage list joins profiles(full_name) for the reporter under the
-- staff caller's RLS; a collaborator's profile (org_id NULL) was invisible to
-- org staff, so their reports would render nameless. Let org staff read the
-- profile of anyone holding a site grant for THEIR org — select only. The
-- subquery runs under site_collaborators RLS (site_collab_staff already admits
-- staff reading their own org's grants), and a collaborator gains nothing here
-- (auth_org_id() null → is_org_staff() false).
drop policy if exists profiles_read_org_collaborators on public.profiles;
create policy profiles_read_org_collaborators on public.profiles
  for select using (
    public.is_org_staff() and exists (
      select 1 from public.site_collaborators sc
      where sc.user_id = profiles.id and sc.org_id = public.auth_org_id()
    )
  );
