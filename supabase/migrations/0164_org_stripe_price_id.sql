-- Migration 0164: remember WHICH price an org signed up on.
--
-- The webhook used to derive the plan from `price.nickname` — a free-text field an
-- operator can edit in the Stripe dashboard. Renaming a nickname would have silently
-- re-planned every org on that price. Price IDs are immutable, so the id is the fact
-- and the tier is derived from it.
--
-- This also buys grandfathering for nothing: repricing means creating a NEW price with
-- a NEW id, and existing orgs keep the id they signed up on until they are explicitly
-- migrated. Without it, a price change forces a choice between migrating everyone (a
-- churn spike) and hand-managing exceptions forever.
--
-- Pinned client-side by the same policy as the other billing columns (0160/0161):
-- only the Stripe webhook, on the service role, may write it.

alter table public.organizations
  add column if not exists stripe_price_id text;

comment on column public.organizations.stripe_price_id is
  'The immutable Stripe price id this org is subscribed on. Authoritative over plan/nickname; enables grandfathering across repricing (0164).';

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
    -- Billing state (0160) + the price they're on (0164)
    and subscription_status     is not distinct from (select o.subscription_status     from public.organizations o where o.id = organizations.id)
    and trial_ends_at           is not distinct from (select o.trial_ends_at           from public.organizations o where o.id = organizations.id)
    and current_period_end      is not distinct from (select o.current_period_end      from public.organizations o where o.id = organizations.id)
    and plan                    is not distinct from (select o.plan                    from public.organizations o where o.id = organizations.id)
    and stripe_customer_id      is not distinct from (select o.stripe_customer_id      from public.organizations o where o.id = organizations.id)
    and stripe_subscription_id  is not distinct from (select o.stripe_subscription_id  from public.organizations o where o.id = organizations.id)
    and stripe_price_id         is not distinct from (select o.stripe_price_id         from public.organizations o where o.id = organizations.id)
    -- Payment identity (0161)
    and stripe_account_id       is not distinct from (select o.stripe_account_id       from public.organizations o where o.id = organizations.id)
    and stripe_account_status   is not distinct from (select o.stripe_account_status   from public.organizations o where o.id = organizations.id)
    and stripe_charges_enabled  is not distinct from (select o.stripe_charges_enabled  from public.organizations o where o.id = organizations.id)
    and stripe_platform_fee_bps is not distinct from (select o.stripe_platform_fee_bps from public.organizations o where o.id = organizations.id)
  );
