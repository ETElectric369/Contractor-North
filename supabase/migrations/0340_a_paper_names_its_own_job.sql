-- 0340: A DOCUMENT, A BILL OR A TRAY ROW NAMES ONLY ITS OWN COMPANY'S JOB (audit v994 TL2).
--
-- Starts from the LIVE policies (pg_policies, 2026-09-25):
--   documents_write        FOR ALL  USING/WITH CHECK (org_id = auth_org_id() AND is_member())
--   bills_write            FOR ALL  USING/WITH CHECK (org_id = auth_org_id() AND is_org_staff())
--   organized_items_write  FOR ALL  USING/WITH CHECK (org_id = auth_org_id()
--                                                     AND (is_org_staff() OR created_by = auth.uid()))
--
-- Each one pins the ROW to the writer's org and says nothing about the job the row names. The job
-- FK is checked as the table owner, not under RLS, so Organize's File It (which took jobId from the
-- browser) could write a bill and a Photo/Receipt document naming another company's job: they would
-- drop out of this company's job pages and job cost, still count in its bill totals, and be deleted
-- by the other company's job delete (documents cascade). The app now refuses it at the door
-- (jobInOrg in fileItem); this puts the same rule where every door passes, as 0300 did for
-- job_stretches and job_picks.
--
-- THE FIX: each WITH CHECK also requires job_id to be null or a job of the writer's own org.
--   * USING is unchanged, so every row a person can update or delete today they still can.
--   * jobs_read is `org_id = auth_org_id()` for every member (techs included), so the subquery
--     answers the same for a tech filing a photo as for the office.
--   * SECURITY DEFINER functions and the service role are not under RLS and are not changed.
--
-- Live when written: 0 documents, 0 bills and 0 organized_items name a job of another org, so no
-- existing row can fail the new check on its next update.
--
-- Safe to re-run (drop policy if exists / create policy).

drop policy if exists documents_write on public.documents;
create policy documents_write on public.documents
  for all
  using (org_id = public.auth_org_id() and public.is_member())
  with check (
    org_id = public.auth_org_id()
    and public.is_member()
    and (job_id is null or exists (select 1 from public.jobs j where j.id = documents.job_id and j.org_id = public.auth_org_id()))
  );

drop policy if exists bills_write on public.bills;
create policy bills_write on public.bills
  for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (
    org_id = public.auth_org_id()
    and public.is_org_staff()
    and (job_id is null or exists (select 1 from public.jobs j where j.id = bills.job_id and j.org_id = public.auth_org_id()))
  );

drop policy if exists organized_items_write on public.organized_items;
create policy organized_items_write on public.organized_items
  for all
  using (org_id = public.auth_org_id() and (public.is_org_staff() or created_by = auth.uid()))
  with check (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or created_by = auth.uid())
    and (job_id is null or exists (select 1 from public.jobs j where j.id = organized_items.job_id and j.org_id = public.auth_org_id()))
  );
