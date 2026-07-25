-- Migration 0155: pin commute_baseline_miles alongside the pay rates 0141 froze.
--
-- 0141 stopped a member editing their OWN hourly_rate/bill_rate (a self-set wage). It
-- missed the third profile column payroll reads live: commute_baseline_miles, which is
-- subtracted from each day's driven miles before mileage is reimbursed. Lowering your own
-- baseline to 0 raises every future mileage settlement — the same self-paid-more shape,
-- one column over, and reachable the same way (a direct PostgREST PATCH with the session
-- token, which skips the server action's staff gate entirely).
--
-- Mileage is settled in the SECOND payroll bucket (Erik's two-buckets law) and the dollar
-- figure is never app-computed, so this doesn't change any math — it just makes the input
-- to that settlement an office decision, like the rates it sits next to.

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (
    id = auth.uid()
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'))
  )
  with check (
    -- Editing your OWN profile may not change your org_id, role, PAY RATES, the mileage
    -- baseline, or the active flag (the subquery reads your CURRENT committed values, so
    -- NEW must equal OLD).
    (id = auth.uid()
       and org_id      is not distinct from (select p.org_id      from public.profiles p where p.id = auth.uid())
       and role        is not distinct from (select p.role        from public.profiles p where p.id = auth.uid())
       and hourly_rate is not distinct from (select p.hourly_rate from public.profiles p where p.id = auth.uid())
       and bill_rate   is not distinct from (select p.bill_rate   from public.profiles p where p.id = auth.uid())
       and commute_baseline_miles is not distinct from
           (select p.commute_baseline_miles from public.profiles p where p.id = auth.uid())
       and active      is not distinct from (select p.active      from public.profiles p where p.id = auth.uid()))
    -- An owner/admin may still manage OTHER members within their own org (editMember).
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'))
  );
