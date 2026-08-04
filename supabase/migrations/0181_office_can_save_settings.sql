-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0181: the office manager's saves actually land
--
-- THE MISMATCH, read out of production rather than guessed at:
--
--   app  isStaffRole()        → owner, admin, OFFICE
--   db   organizations_update → owner, admin
--
-- So every settings save by an office manager matched ZERO ROWS. PostgREST answers a zero-row
-- UPDATE with a 204 and no error, so the action returned ok and the button went green. Alexa
-- Peters is `office` on TAHOE DECK: the default labor rate, the mileage rate and the markups all
-- go through updateOrgSettings, and she could change any of them, watch it succeed, and save
-- nothing — with no way to tell that from a real save.
--
-- WHICH SIDE IS WRONG IS ANSWERED BY THE CODE'S OWN COMMENT, written long before tonight
-- (settings/page.tsx): "Office (Alexa's control plane: Numbering, Scheduling & timesheets,
-- Automation) keeps the org-settings cluster; only techs are gated out of it." Office was always
-- meant to have this. The policy is what drifted, so the policy is what moves.
--
-- WHAT THIS GRANTS: an office manager may now write their OWN org's row — the same thing the app
-- has been offering them all along. Not another org's: `id = auth_org_id()` is untouched and is
-- the tenant boundary.
--
-- WHAT IT STILL REFUSES, to everybody: the eleven billing columns. subscription_status,
-- trial_ends_at, current_period_end, plan and the seven stripe_* columns stay frozen against any
-- app write — they are Stripe's to move, through the service-role webhook, and a tenant editing
-- their own subscription state is how a paywall stops meaning anything. Every clause below is
-- carried over verbatim from the policy this replaces; the ONLY change is the role list.
--
-- ⚠️ ONE THING THIS DOES NOT COVER, and it is worth knowing: three settings live inside the
-- `settings` jsonb and are protected only in TypeScript (PROTECTED_SETTINGS_KEYS —
-- custom_domain, public_handle, lead_inbound_secret). RLS cannot see inside a jsonb, so an office
-- user writing PostgREST directly could set them on their own org. That is a pre-existing gap for
-- admins too, it stays inside one tenant, and closing it properly means moving those three to
-- real columns. Filed, not fixed here.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists organizations_update on public.organizations;

create policy organizations_update on public.organizations
  for update
  using (
    id = auth_org_id()
    and app_user_role() = any (array['owner'::user_role, 'admin'::user_role, 'office'::user_role])
  )
  with check (
    id = auth_org_id()
    and app_user_role() = any (array['owner'::user_role, 'admin'::user_role, 'office'::user_role])
    -- Billing is Stripe's, and it arrives through the service-role webhook, which is not subject
    -- to this policy at all. Nobody signed in may move any of it.
    and not (subscription_status  is distinct from (select o.subscription_status  from organizations o where o.id = organizations.id))
    and not (trial_ends_at        is distinct from (select o.trial_ends_at        from organizations o where o.id = organizations.id))
    and not (current_period_end   is distinct from (select o.current_period_end   from organizations o where o.id = organizations.id))
    and not (plan                 is distinct from (select o.plan                 from organizations o where o.id = organizations.id))
    and not (stripe_customer_id   is distinct from (select o.stripe_customer_id   from organizations o where o.id = organizations.id))
    and not (stripe_subscription_id is distinct from (select o.stripe_subscription_id from organizations o where o.id = organizations.id))
    and not (stripe_price_id      is distinct from (select o.stripe_price_id      from organizations o where o.id = organizations.id))
    and not (stripe_account_id    is distinct from (select o.stripe_account_id    from organizations o where o.id = organizations.id))
    and not (stripe_account_status is distinct from (select o.stripe_account_status from organizations o where o.id = organizations.id))
    and not (stripe_charges_enabled is distinct from (select o.stripe_charges_enabled from organizations o where o.id = organizations.id))
    and not (stripe_platform_fee_bps is distinct from (select o.stripe_platform_fee_bps from organizations o where o.id = organizations.id))
  );
