-- Migration 0160: an owner may not grant themselves a paid subscription.
--
-- organizations_update (0004) is `using (id = auth_org_id() and app_user_role() in
-- ('owner','admin'))` with NO with-check and no column grants. RLS cannot restrict
-- columns, so an owner holds UPDATE on every column of their own org row — including
-- the six the paywall reads. One request with the anon key that ships in the client
-- bundle:
--
--   PATCH /rest/v1/organizations?id=eq.<own org>
--   {"subscription_status":"active","trial_ends_at":"2099-01-01"}
--
-- …and src/app/(app)/layout.tsx's hasActiveAccess() gate is defeated permanently. With
-- two family tenants that is invisible. With strangers it is one forum post away from
-- every tenant running free forever.
--
-- Same fix shape as 0141 (self-set pay rates) and 0155 (commute baseline): keep the
-- update, pin the columns that must never move from the client by requiring NEW to
-- equal the CURRENT committed value. Only the Stripe webhook — which runs on the
-- service role and bypasses RLS entirely — can change them.
--
-- Also pinned: `handle`. It is the tenant's public subdomain identity; letting a
-- client rewrite it directly (rather than through the action that checks availability)
-- is how two orgs end up claiming one address.

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update
  using (
    id = public.auth_org_id()
    and public.app_user_role() in ('owner', 'admin')
  )
  with check (
    id = public.auth_org_id()
    and public.app_user_role() in ('owner', 'admin')
    -- Billing state is set by Stripe (service role), never by the customer.
    and subscription_status   is not distinct from (select o.subscription_status   from public.organizations o where o.id = organizations.id)
    and trial_ends_at         is not distinct from (select o.trial_ends_at         from public.organizations o where o.id = organizations.id)
    and current_period_end    is not distinct from (select o.current_period_end    from public.organizations o where o.id = organizations.id)
    and plan                  is not distinct from (select o.plan                  from public.organizations o where o.id = organizations.id)
    and stripe_customer_id    is not distinct from (select o.stripe_customer_id    from public.organizations o where o.id = organizations.id)
    and stripe_subscription_id is not distinct from (select o.stripe_subscription_id from public.organizations o where o.id = organizations.id)
  );

comment on policy organizations_update on public.organizations is
  'Owner/admin may edit their own org, EXCEPT the billing columns (subscription_status, '
  'trial_ends_at, current_period_end, plan, stripe_*) which are pinned to their committed '
  'values — those move only via the Stripe webhook on the service role. Without this the '
  'paywall is defeated by one PostgREST PATCH (0160).';
