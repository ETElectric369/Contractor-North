-- 0215 — the pay spine gets its own door (step 1 of 2; additive and safe to deploy alone).
--
-- v800 audit: `profiles_read` (0004) is `id = auth.uid() or org_id = auth_org_id()`, and
-- hourly_rate, bill_rate, home_address and commute_baseline_miles all live on that row. RLS
-- cannot restrict COLUMNS, and there are no column grants anywhere in 214 migrations — so any
-- field tech, holding the anon key that ships in the client bundle plus their own session,
-- could read every co-worker's pay rate and home address straight off the REST API. Migration
-- 0141 closed the WRITE half of exactly this hole ("profiles carries the pay spine") and left
-- the read half open; 0056 exists because a tech could read every invoice the same way.
--
-- Column privileges are the only tool that restricts columns, but they are per-ROLE, and every
-- signed-in person is the same `authenticated` role — so they cannot tell staff from tech. This
-- view is the other half: a SECURITY DEFINER view (security_invoker = false, deliberately) that
-- can see the columns after 0216 revokes them, with the staff boundary written into its own
-- WHERE clause. Everyone keeps the right to see their OWN pay.
--
-- security_barrier so the predicate cannot be leaked around by a cheap user-supplied function.

create or replace view public.profile_pay
with (security_barrier = true)
as
select p.id,
       p.org_id,
       p.full_name,
       p.hourly_rate,
       p.bill_rate,
       p.home_address,
       p.commute_baseline_miles,
       -- not sensitive; carried so crew pickers can keep filtering on it without a second read
       p.active
  from public.profiles p
 where p.org_id = public.auth_org_id()
   and (public.is_org_staff() or p.id = auth.uid());

comment on view public.profile_pay is
  'The pay/address spine, staff-scoped (0215). Office staff see their whole org; everyone else sees only their own row. Reads here instead of profiles because 0216 revokes these columns from the authenticated role — RLS cannot filter columns.';

grant select on public.profile_pay to authenticated;
