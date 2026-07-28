-- FIX: 0170 made crew_day_assignments.job_id nullable for OFF days and left the RLS policy
-- demanding that a job exist. Every "mark somebody off" was rejected with
-- "new row violates row-level security policy for table crew_day_assignments".
--
-- The WITH CHECK read:
--   EXISTS (select 1 from jobs j where j.id = crew_day_assignments.job_id and j.org_id = ...)
-- With job_id NULL, `j.id = NULL` matches nothing, EXISTS is false, and the insert dies. The
-- guard is correct for a job row — it stops a day assignment pointing at another tenant's job —
-- it just has nothing to check on a row that deliberately names no job.
--
-- WHY I DIDN'T CATCH IT: I pen-tested 0170 against the trigger and the shape constraints using a
-- service_role claim, which BYPASSES RLS entirely. I proved the constraint and never touched the
-- policy. Same lesson as the offline-punch audit in a new place: verify the boundary the real
-- caller actually crosses, as the role that actually crosses it.

drop policy if exists crew_day_assignments_staff on public.crew_day_assignments;

create policy crew_day_assignments_staff on public.crew_day_assignments
  for all to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (
    org_id = public.auth_org_id()
    and public.is_org_staff()
    -- The member must belong to this org. Unchanged, and it applies to every row.
    and exists (
      select 1 from public.profiles p
      where p.id = crew_day_assignments.profile_id and p.org_id = crew_day_assignments.org_id
    )
    -- The job must belong to this org — but ONLY when the row names one. An OFF day (0170)
    -- deliberately has no job, and "there is no job to check" must not read as "the check failed".
    and (
      crew_day_assignments.job_id is null
      or exists (
        select 1 from public.jobs j
        where j.id = crew_day_assignments.job_id and j.org_id = crew_day_assignments.org_id
      )
    )
  );

comment on policy crew_day_assignments_staff on public.crew_day_assignments is
  'Staff-only write, org-contained on BOTH sides: the member and (when the row names one) the job must belong to the caller''s org. The job check is conditional because an OFF row names no job — 0171.';
