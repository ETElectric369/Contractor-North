-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0141: pin PAY columns on a self profile update (CRITICAL)
--
-- Deep-dive audit 2026-07-20. 0112 closed the self-update hole for org_id and role,
-- but RLS cannot column-restrict and there are no column GRANTs — so every OTHER
-- column stayed writable on your own row. profiles carries the pay spine:
--     hourly_rate  (0001_init)  → payroll-math reads it LIVE at run time
--     bill_rate    (0054)       → what the customer is charged for that person
--     active       (0004)       → the deactivation lockout
-- A tech with the public anon key (it ships in the client bundle) and their own
-- session could PATCH /rest/v1/profiles?id=eq.<self> {"hourly_rate": 45}: org_id
-- and role are unchanged so 0112's WITH CHECK passes, and guard_role only fires on
-- a role change. The app-layer owner/admin gate in editMember is bypassed entirely.
-- Payroll reads the rate at run time (no snapshot), so the next run just pays it.
--
-- Same technique as 0112: pin the columns to the caller's CURRENT committed values
-- on the SELF branch. Owners/admins keep full control of OTHER members' rows through
-- the second branch (that is how editMember legitimately sets pay), and the
-- SECURITY DEFINER paths (accept_invitation, createEmployee, importCrew) bypass RLS
-- as before. Self-service edits that SHOULD work — full_name, phone, avatar_url,
-- language, home_address, commute_miles, crew_lead, push subscriptions — are
-- untouched.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (
    id = auth.uid()
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'))
  )
  with check (
    -- Editing your OWN profile may not change your org_id, role, PAY RATES, or active
    -- flag (the subquery reads your CURRENT committed values, so NEW must equal OLD).
    (id = auth.uid()
       and org_id      is not distinct from (select p.org_id      from public.profiles p where p.id = auth.uid())
       and role        is not distinct from (select p.role        from public.profiles p where p.id = auth.uid())
       and hourly_rate is not distinct from (select p.hourly_rate from public.profiles p where p.id = auth.uid())
       and bill_rate   is not distinct from (select p.bill_rate   from public.profiles p where p.id = auth.uid())
       and active      is not distinct from (select p.active      from public.profiles p where p.id = auth.uid()))
    -- An owner/admin may still manage OTHER members within their own org (editMember).
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'))
  );
