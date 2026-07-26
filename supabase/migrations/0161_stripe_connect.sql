-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0161: Stripe Connect — a contractor's customers pay THE CONTRACTOR.
--
-- THE PROBLEM. /api/pay/[token] creates a Checkout session on the PLATFORM Stripe
-- key. With two family orgs that's invisible. The moment a stranger's customer pays
-- an invoice, that money lands in Erik's Stripe balance — and then Erik owes it to
-- the contractor. That is not a missing feature, it is holding other people's money:
-- a payout obligation and a money-transmission question, neither of which a
-- one-person company should take on.
--
-- THE MODEL: DIRECT CHARGES on a connected Express account.
--   • The charge is created ON the contractor's own Stripe account
--     (stripe.checkout.sessions.create(..., { stripeAccount: acct_xxx })).
--   • The CONTRACTOR is the merchant of record. Their name is on the customer's
--     card statement. Their Stripe balance. Their payout schedule. Their refunds.
--   • Contractor North never touches the funds — which is exactly the point, and
--     also what keeps Erik out of money-transmission territory.
--   • Stripe handles the contractor's identity verification (KYC) during onboarding,
--     so we never collect or store SSNs, bank details or tax IDs.
--
-- Deliberately NOT taking an application fee. The "conscious business" position is
-- that we don't skim a contractor's revenue — we charge a flat subscription and
-- nothing else. The column exists so the decision stays explicit rather than
-- hard-coded, but it defaults to 0 and nothing reads it yet.
--
-- Columns are pinned client-side by the same policy 0160 installed: payment identity
-- is set by Stripe callbacks on the service role, never by a PATCH from the browser.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.organizations
  add column if not exists stripe_account_id text,
  -- 'none' | 'pending' (onboarding started, not yet chargeable) | 'active' | 'restricted'
  add column if not exists stripe_account_status text not null default 'none',
  -- Mirrors Stripe's charges_enabled: the ONE flag the pay route may trust.
  add column if not exists stripe_charges_enabled boolean not null default false,
  add column if not exists stripe_platform_fee_bps integer not null default 0;

comment on column public.organizations.stripe_account_id is
  'The org''s own Stripe Express account (acct_…). Charges for THEIR invoices are created on it via direct charges, so their customers pay them, not the platform (0161).';
comment on column public.organizations.stripe_account_status is
  'none | pending | active | restricted — mirrored from Stripe account.updated (0161).';
comment on column public.organizations.stripe_charges_enabled is
  'Stripe''s charges_enabled. The pay route refuses unless this is true — an account mid-onboarding cannot accept money (0161).';
comment on column public.organizations.stripe_platform_fee_bps is
  'Application fee in basis points. 0 by design: we charge a subscription, not a cut of the contractor''s revenue. Kept as a column so the choice stays visible (0161).';

-- Two orgs can never share a connected account.
create unique index if not exists organizations_stripe_account_id_key
  on public.organizations (stripe_account_id)
  where stripe_account_id is not null;

-- Extend 0160's pin: payment identity joins billing state as service-role-only.
-- Without this an owner could PATCH stripe_charges_enabled=true and take payments
-- through an unverified account, or point stripe_account_id at someone else's.
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
    -- Billing state (0160)
    and subscription_status     is not distinct from (select o.subscription_status     from public.organizations o where o.id = organizations.id)
    and trial_ends_at           is not distinct from (select o.trial_ends_at           from public.organizations o where o.id = organizations.id)
    and current_period_end      is not distinct from (select o.current_period_end      from public.organizations o where o.id = organizations.id)
    and plan                    is not distinct from (select o.plan                    from public.organizations o where o.id = organizations.id)
    and stripe_customer_id      is not distinct from (select o.stripe_customer_id      from public.organizations o where o.id = organizations.id)
    and stripe_subscription_id  is not distinct from (select o.stripe_subscription_id  from public.organizations o where o.id = organizations.id)
    -- Payment identity (0161)
    and stripe_account_id       is not distinct from (select o.stripe_account_id       from public.organizations o where o.id = organizations.id)
    and stripe_account_status   is not distinct from (select o.stripe_account_status   from public.organizations o where o.id = organizations.id)
    and stripe_charges_enabled  is not distinct from (select o.stripe_charges_enabled  from public.organizations o where o.id = organizations.id)
    and stripe_platform_fee_bps is not distinct from (select o.stripe_platform_fee_bps from public.organizations o where o.id = organizations.id)
  );

comment on policy organizations_update on public.organizations is
  'Owner/admin may edit their own org EXCEPT billing state (0160) and Stripe Connect payment '
  'identity (0161) — both are written only by Stripe callbacks running on the service role. '
  'Without the pin, the paywall is defeated by one PATCH and a tenant could self-mark their '
  'unverified account chargeable.';
