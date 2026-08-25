-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0224: nobody could update a profile at all
--
-- CRITICAL, MINE, AND LIVE FOR A DAY. 0216 revoked SELECT on the pay columns from the
-- `authenticated` role (RLS cannot restrict columns, so a revoke was the only way to stop a
-- PostgREST embed carrying the crew's pay). But profiles_update_self — last rebuilt by 0155 —
-- pins those same columns by SUB-SELECTING them:
--
--     not (hourly_rate is distinct from (select p.hourly_rate from public.profiles p
--                                         where p.id = auth.uid()))
--
-- A sub-SELECT introduces a SECOND range-table entry on public.profiles whose selected-columns
-- set contains hourly_rate. ExecCheckPermissions validates every RTE's column privileges BEFORE
-- the expression runs, so the statement aborts with `permission denied for table profiles` no
-- matter which branch of the OR would have matched. It does not matter that an owner never
-- reaches the self-edit branch, and it does not matter that the caller is only touching
-- push_prefs.
--
-- A direct reference to the NEW row's column is fine — that is the same RTE the UPDATE already
-- holds. It is specifically the sub-SELECT that adds the second one. That distinction is the
-- whole fix.
--
-- ── WHAT IT BROKE, verified against production before writing this ──────────────────────────
--
--   · a tech enabling push notifications            → permission denied
--   · anyone editing their own name, phone, avatar  → permission denied
--   · Nort tone settings, lesson-seen marks         → permission denied
--   · AN OWNER DEACTIVATING A DEPARTING EMPLOYEE    → permission denied
--
-- That last one is not a convenience. 0158 made `active` a real offboarding boundary; since
-- cn-v803 shipped 0216 it has been impossible to engage it, so a person who leaves keeps their
-- access. cn-v809 swept the READERS this revoke broke (four pages, the aliased embeds) and never
-- looked at the policy text — the repair pass had the same blind spot as the original.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────────────────────
--
-- Move the comparison inside a SECURITY DEFINER function, which runs with the owner's privileges
-- and so may read the columns. The NEW values are passed in as ARGUMENTS — direct Vars on the
-- row being written, needing no extra privilege — and the policy no longer names a revoked
-- column anywhere.
--
-- NO NEW EXPOSURE. The helper compares against the CALLER'S OWN row (auth.uid()) and returns a
-- single boolean, so at worst it is an oracle for your own pay rate — which 0215's profile_pay
-- view already shows you (`id = auth.uid()`). It reveals nothing about anybody else.
--
-- It must stay executable by `authenticated`: per 0182, a policy helper that role cannot execute
-- takes every policy on the table down with it. anon has no business calling it.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.profile_self_edit_ok(
  p_org      uuid,
  p_role     user_role,
  p_hourly   numeric,
  p_bill     numeric,
  p_commute  numeric,
  p_active   boolean
) returns boolean
language sql stable security definer set search_path = public as $$
  -- True when the row being written leaves every PINNED field exactly as it stands today.
  -- Same six fields, same `is distinct from` semantics (null-safe) as 0155 — only the place the
  -- comparison happens has moved.
  select not exists (
    select 1
      from public.profiles p
     where p.id = auth.uid()
       and (p.org_id                 is distinct from p_org
         or p.role                   is distinct from p_role
         or p.hourly_rate            is distinct from p_hourly
         or p.bill_rate              is distinct from p_bill
         or p.commute_baseline_miles is distinct from p_commute
         or p.active                 is distinct from p_active)
  );
$$;

revoke execute on function public.profile_self_edit_ok(uuid, user_role, numeric, numeric, numeric, boolean) from public, anon;
grant  execute on function public.profile_self_edit_ok(uuid, user_role, numeric, numeric, numeric, boolean) to authenticated;

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update
  using (
    id = auth.uid()
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner', 'admin'))
  )
  with check (
    -- Yourself: everything except the six pinned fields. A member still cannot set their own pay
    -- rate, change their role, move orgs, or re-activate themselves — the 0141 and 0158 controls
    -- are unchanged, they are just enforced somewhere the caller is allowed to look.
    (id = auth.uid()
      and public.profile_self_edit_ok(org_id, role, hourly_rate, bill_rate, commute_baseline_miles, active))
    -- Or an owner/admin acting on a member of their own org. prevent_role_escalation and the
    -- other triggers still apply on top of this.
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner', 'admin'))
  );
