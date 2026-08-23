-- 0216 — the pay spine stops being world-readable inside the org (step 2 of 2).
--
-- v800 audit, HIGH: `profiles_read` (0004) is `id = auth.uid() or org_id = auth_org_id()`, and
-- hourly_rate / bill_rate / home_address / commute_baseline_miles live on that row. RLS cannot
-- restrict COLUMNS and there were no column grants in 215 migrations, so any field tech — with
-- the anon key that ships in the client bundle plus their own session — could read every
-- co-worker's pay rate and home address straight off /rest/v1/profiles. 0141 closed the WRITE
-- half of this exact hole and left the read half open.
--
-- Column privileges are the only mechanism that restricts columns. They are per-ROLE, and every
-- signed-in person is `authenticated`, so they cannot tell staff from tech on their own — which
-- is why 0215 added the `profile_pay` view (SECURITY DEFINER, staff-or-self in its own WHERE)
-- as the one door to these values. Every reader in the app was moved to it first; this
-- migration closes the old door.
--
-- NOTE the shape: you cannot revoke a single column from a table-wide grant, so we revoke the
-- table-level SELECT and re-grant every OTHER column explicitly. Adding a column to `profiles`
-- therefore makes it unreadable until it is added to this list AND to PROFILE_SAFE_COLS in
-- src/lib/profile-columns.ts — deliberate: a new column is private until someone says otherwise.
-- `service_role` is untouched (server-side jobs keep full access), as are INSERT/UPDATE, which
-- 0141 already governs.

revoke select on public.profiles from authenticated;

grant select (
  id,
  full_name,
  email,
  phone,
  role,
  avatar_url,
  active,
  created_at,
  updated_at,
  org_id,
  language,
  home_lat,
  home_lng,
  push_prefs,
  must_reset_password,
  crew_lead,
  deactivated_at,
  deactivated_by,
  onboarded_at,
  nort_humor,
  nort_register,
  nort_notes,
  lessons_seen
) on public.profiles to authenticated;

comment on column public.profiles.hourly_rate is
  'PRIVATE (0216): revoked from the authenticated role. Read via public.profile_pay, which is staff-or-self.';
comment on column public.profiles.bill_rate is
  'PRIVATE (0216): revoked from the authenticated role. Read via public.profile_pay.';
comment on column public.profiles.home_address is
  'PRIVATE (0216): revoked from the authenticated role. Read via public.profile_pay.';
comment on column public.profiles.commute_baseline_miles is
  'PRIVATE (0216): revoked from the authenticated role. Read via public.profile_pay.';
