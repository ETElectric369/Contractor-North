-- SECURITY FIX (found by adversarial review of the site-collaborator seat): a self-escalation
-- hole that becomes exploitable once external, adversary-controlled accounts exist (site
-- collaborators, whose profiles.org_id is NULL by design).
--
-- The hole: profiles_update_self (0004) had a USING clause but NO WITH CHECK, so Postgres reused
-- USING as the row check — and since `id = auth.uid()` stays true no matter what org_id/role the
-- NEW row contains, a user could PATCH their OWN profiles.org_id + role via a direct anon-key
-- REST call and become owner of any org whose UUID they know. The role guard trigger only fired
-- when old.org_id was NOT NULL, so a NULL-org principal (a collaborator) skipped it entirely.
--
-- The fix: pin org_id AND role on SELF updates. Legit joins/role changes go through SECURITY
-- DEFINER functions (accept_invitation, create_organization) which bypass RLS, and admins manage
-- OTHER members via the second branch — so pinning the self-branch closes the hole without
-- touching any legitimate path.

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (
    id = auth.uid()
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'))
  )
  with check (
    -- Editing your OWN profile may not change your org_id or role (the subquery reads your CURRENT
    -- committed values, so NEW must equal OLD). A NULL-org collaborator therefore cannot self-assign
    -- into an org or grant themselves a role.
    (id = auth.uid()
       and org_id is not distinct from (select p.org_id from public.profiles p where p.id = auth.uid())
       and role is not distinct from (select p.role from public.profiles p where p.id = auth.uid()))
    -- An owner/admin may still manage OTHER members within their own org.
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'))
  );

-- Defense-in-depth on the collaborator claim: only bind a pending grant to a user whose email is
-- CONFIRMED (proves they own the invited address). Consistent with the existing invitation flow,
-- which likewise trusts a confirmed email; signup here requires confirmation (emailRedirectTo).
create or replace function public.claim_site_collaborations()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer; caller_email text;
begin
  select email into caller_email from auth.users
    where id = auth.uid() and email_confirmed_at is not null;
  if caller_email is null then return 0; end if;  -- unconfirmed / no email → claim nothing
  update public.site_collaborators sc
     set user_id = auth.uid(), claimed_at = now()
   where sc.user_id is null
     and lower(sc.invited_email) = lower(caller_email);
  get diagnostics n = row_count;
  return n;
end $$;
