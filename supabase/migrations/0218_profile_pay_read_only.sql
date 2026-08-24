-- 0218 — profile_pay must be READ-ONLY. Caught by the adversarial review of 0215 itself.
--
-- A simple view over one table is AUTO-UPDATABLE in Postgres, and Supabase's default grants
-- hand anon+authenticated INSERT/UPDATE/DELETE on new public objects. Because 0215's view is
-- SECURITY DEFINER (security_invoker off, deliberately, so it can read columns the caller
-- cannot), a write THROUGH the view would execute as the view's owner — bypassing both the
-- 0216 column revoke and profiles' own RLS. That is a bigger hole than the one 0215/0216 were
-- written to close: a member could have set their own pay rate.
--
-- Writes to the pay spine belong to 0141's guarded paths on `profiles`, and nowhere else.

revoke insert, update, delete, truncate, references, trigger on public.profile_pay from anon;
revoke insert, update, delete, truncate, references, trigger on public.profile_pay from authenticated;
revoke all on public.profile_pay from public;
grant select on public.profile_pay to authenticated;

comment on view public.profile_pay is
  'The pay/address spine, staff-scoped and READ-ONLY (0215; writes revoked in 0218 — a SECURITY DEFINER view is auto-updatable and would have let a member write to profiles as the view owner). Office staff see their whole org; everyone else only their own row.';
