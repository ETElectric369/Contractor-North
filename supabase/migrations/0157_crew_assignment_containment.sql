-- Migration 0157: contain crew_day_assignments to the writer's own org.
--
-- 0139's write policy checks `org_id = auth_org_id() and is_org_staff()` — the ROW's org,
-- but never that the PROFILE or the JOB it points at belong to that org. Combined with the
-- deliberately global unique key (profile_id, work_date), that is a cross-tenant squat:
--
--   Tahoe Deck's office inserts {org_id: <their own>, profile_id: <an ET Electric tech>,
--   work_date: tomorrow, job_id: <their own job>}. RLS passes — every predicate is about
--   THEIR org. The row now occupies the global (profile, day) slot. When ET's office
--   assigns that same tech tomorrow, the upsert hits a unique violation on a row RLS
--   hides from them: an unexplainable "duplicate key" they cannot see or clear.
--
-- The global key is the right semantics (one assignment per person per day — a person
-- belongs to exactly one org), so keep it and close the hole it depends on: a member may
-- only be assigned by their OWN org, to a job in that org.

drop policy if exists crew_day_assignments_staff on public.crew_day_assignments;
create policy crew_day_assignments_staff on public.crew_day_assignments
  for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (
    org_id = public.auth_org_id()
    and public.is_org_staff()
    -- The assigned member must be in the assigning org.
    and exists (
      select 1 from public.profiles p
       where p.id = crew_day_assignments.profile_id
         and p.org_id = crew_day_assignments.org_id
    )
    -- …and so must the job (no dangling cross-org job reference on the board).
    and exists (
      select 1 from public.jobs j
       where j.id = crew_day_assignments.job_id
         and j.org_id = crew_day_assignments.org_id
    )
  );
