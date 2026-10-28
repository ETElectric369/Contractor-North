-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0400: the trial warns, the lapse keeps the lights on
--
-- A company's standing (its trial, its grace window after a failed card, a comp for the founding
-- cohort, a lapse) is read by ONE rule in the app, lib/subscription accessState (cn-v1137). What the
-- database had for it was three billing columns Stripe moves and nothing else: no record of which
-- warning a company had already been sent (so a cron that said "your trial ends in 3 days" on
-- Monday would say it again on Tuesday), no way to comp a company except an environment variable
-- only North could edit and redeploy, and one billing-shaped column (0252's Terminal location) that
-- 0181's pin never covered. This migration gives the standing its ledger, its comp and its pin.
--
-- WHAT CHANGES:
--
--   1. organizations.billing_notices (jsonb, default {}): the "told once" ledger. A notice key maps
--      to the ISO timestamp it was sent — "trial_7", "trial_3", "trial_1", "trial_0", "lapsed",
--      "grace_3:<period_end>", "grace_1:<period_end>", "past_due:<period_end>" (a grace key carries
--      the period it belongs to, so a second failed card months later warns again). The notices
--      engine STAMPS FIRST, THEN SENDS: claim_billing_notice is the lock, and a text that never
--      went out for a stamped key is a one-off miss, never a company nagged twice.
--
--   2. organizations.comped_until (timestamptz, null): the founding-cohort state as a column. In
--      the future = access and no notices, whatever Stripe says; past or null = nothing. Set and
--      cleared from Bug Watch › Companies by North's own team through platform_set_comped_until;
--      the env list COMPED_ORG_IDS stays honored as the belt.
--
--   3. bills.both_real_at (timestamptz, null): "Both Are Real" on the same-ticket-on-two-jobs card
--      — the office's word that two bills sharing a supplier ticket number are two purchases, not
--      one typed twice. Null = never said. The door that writes it ships beside this migration.
--
--   4. THE PIN. organizations_update is re-created from 0181 VERBATIM — the same three roles
--      (owner, admin, office), the same using clause, the same eleven billing clauses — plus three
--      more in the same shape: billing_notices, comped_until and stripe_terminal_location_id.
--      The ledger and the comp are STANDING, and standing is never a tenant's to move: a company
--      that could blank its own "lapsed" stamp would be warned forever, and one that could stamp
--      its own comped_until would never pay. So the only writers are the SERVICE ROLE (the notices
--      cron and the Stripe webhook, which RLS does not bind) and the two RPCs below (SECURITY
--      DEFINER, service role only). Bug Watch's comp goes through platform_set_comped_until, which
--      checks the admin inside. stripe_terminal_location_id was added by 0252 after 0181 and never
--      pinned, so an office seat could repoint a company's Tap to Pay at any Terminal Location by
--      hand; its clause refuses a CHANGE of a set value and lets the first fill (null → tml_…)
--      through, because ensureTerminalLocation (billing/tap-actions.ts) mints it lazily with the
--      staff member's own client on the first tap — the full shape would have broken every
--      company's first Tap to Pay. Once the mint moves to the service client, a later migration
--      tightens it to the full shape (this one is immutable once applied).
--
--   5. claim_billing_notice(p_org, p_key) → boolean: the lock. Writes the key with now() when it is
--      not there and answers true; false when it was already told or there is no such company.
--      release_billing_notice(p_org, p_key) → boolean: the webhook's eraser — "lapsed" is released
--      when a subscription goes active again, so a company that comes back can lapse again later
--      and be told. Both service role only.
--
--   6. platform_set_comped_until(p_org, p_until) → boolean: North's own team sets or clears (null)
--      a company's comp, in platform_set_error_status's shape (0399 §5: SECURITY DEFINER, the admin
--      checked inside, 42501 in words), and writes ONE agent_audit_log row the way set_org_trade
--      does (0398: action 'comp.set', input_summary {from, to}) — the undo trail. Answers true when
--      the company was there.
--
-- LOCKS: organizations (ADD COLUMN: ACCESS EXCLUSIVE for a moment, no rewrite — a jsonb default of
-- '{}' is stored as a column default, not written to every row; DROP/CREATE POLICY: ACCESS
-- EXCLUSIVE for a moment); bills (ADD COLUMN, the same). lock_timeout 3s: a busy table fails fast
-- and changes nothing; run it again. Twice-safe: every column is IF NOT EXISTS, the policy is
-- dropped and re-created to the same text, the functions are CREATE OR REPLACE, the grants are
-- idempotent.
--
-- ORDER: after 0181 (the policy this re-creates), 0252 (stripe_terminal_location_id), 0176
-- (is_platform_admin), 0064 (agent_audit_log) and 0182 (the revoke law: every SECURITY DEFINER
-- function here carries its own revoke). Apply BEFORE the cn-v1137 deploy: the layout's select
-- names comped_until and the notices cron calls claim_billing_notice from the first run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
declare
  v_col text;
begin
  if to_regclass('public.organizations') is null then
    raise exception '0400: organizations is not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.bills') is null then
    raise exception '0400: bills is not on this database. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'organizations' and policyname = 'organizations_update') then
    raise exception '0400: the organizations_update policy (0181) is not on this database; there is nothing to re-create. Nothing was changed.';
  end if;
  if to_regtype('public.user_role') is null or to_regprocedure('public.auth_org_id()') is null or to_regprocedure('public.app_user_role()') is null then
    raise exception '0400: user_role / auth_org_id() / app_user_role() (0004, 0158) are not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.platform_admins') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0400: platform_admins / is_platform_admin() (0176) are not on this database. Apply 0176 first. Nothing was changed.';
  end if;
  if to_regclass('public.agent_audit_log') is null then
    raise exception '0400: agent_audit_log (0064) is missing. Nothing was changed.';
  end if;
  -- Every column the re-created policy names must be there, or CREATE POLICY would fail halfway.
  foreach v_col in array array['subscription_status', 'trial_ends_at', 'current_period_end', 'plan', 'stripe_customer_id',
                               'stripe_subscription_id', 'stripe_price_id', 'stripe_account_id', 'stripe_account_status',
                               'stripe_charges_enabled', 'stripe_platform_fee_bps', 'stripe_terminal_location_id'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = v_col) then
      raise exception '0400: organizations.% (a column the policy pins) is missing. Nothing was changed.', v_col;
    end if;
  end loop;
end $$;

-- ── 1–3. the ledger, the comp, and Both Are Real ────────────────────────────────────────────────
alter table public.organizations add column if not exists billing_notices jsonb not null default '{}'::jsonb;
alter table public.organizations add column if not exists comped_until timestamptz null;
alter table public.bills add column if not exists both_real_at timestamptz null;
comment on column public.organizations.billing_notices is
  'The "told once" ledger (0400): notice key → ISO timestamp it was sent (trial_7, trial_3, trial_1, trial_0, lapsed, grace_3:<period_end>, grace_1:<period_end>, past_due:<period_end>). Written only through claim_billing_notice / release_billing_notice and the service role; pinned against every signed-in writer.';
comment on column public.organizations.comped_until is
  'The founding-cohort comp (0400): in the future = access and no billing notices, whatever Stripe says; null or past = nothing. Set and cleared by North''s own team through platform_set_comped_until (Bug Watch › Companies); pinned against every signed-in writer.';
comment on column public.bills.both_real_at is
  'Both Are Real (0400): when the office said two bills sharing a supplier ticket number are two purchases, not one typed twice. Null = never said.';

-- ── 4. the pin: 0181's policy, verbatim, plus the three columns it never knew ───────────────────
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
    -- 0400: the standing (the notices ledger, the comp) is the service role's and the RPCs' alone.
    and not (billing_notices      is distinct from (select o.billing_notices      from organizations o where o.id = organizations.id))
    and not (comped_until         is distinct from (select o.comped_until         from organizations o where o.id = organizations.id))
    -- 0400: a set Terminal Location is never repointed by hand; the first fill (null → tml_…) is
    -- ensureTerminalLocation's lazy mint with the staff member's own client, and still lands.
    and not (stripe_terminal_location_id is distinct from (select o.stripe_terminal_location_id from organizations o where o.id = organizations.id)
             and (select o.stripe_terminal_location_id from organizations o where o.id = organizations.id) is not null)
  );
comment on policy organizations_update on public.organizations is
  'Owner, admin and office write their own company''s row (0181), never a billing column (0160/0181), never the notices ledger or the comp (0400), never a set Terminal Location (0400). Stripe''s webhook, the crons and the RPCs write with the service role, which this policy does not bind.';

-- ── 5. the lock and the eraser: service role only ───────────────────────────────────────────────
create or replace function public.claim_billing_notice(p_org uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_key is null or btrim(p_key) = '' then
    raise exception 'A billing notice needs a key.' using errcode = '22023';
  end if;
  -- Stamp first, then send: the key lands once, under the row lock an UPDATE takes, so two runs
  -- of the cron in the same minute cannot both claim it.
  update public.organizations
     set billing_notices = billing_notices || jsonb_build_object(p_key, to_jsonb(now()))
   where id = p_org
     and not (billing_notices ? p_key);
  return found;
end $$;
comment on function public.claim_billing_notice(uuid, text) is
  'The notices engine''s lock (0400): stamps p_key with now() on the company''s billing_notices when it is not there and answers true; false when the company was already told or is not there. Stamp first, then send. Service role only.';
revoke execute on function public.claim_billing_notice(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_billing_notice(uuid, text) to service_role;

create or replace function public.release_billing_notice(p_org uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_key is null or btrim(p_key) = '' then
    raise exception 'A billing notice needs a key.' using errcode = '22023';
  end if;
  update public.organizations
     set billing_notices = billing_notices - p_key
   where id = p_org
     and (billing_notices ? p_key);
  return found;
end $$;
comment on function public.release_billing_notice(uuid, text) is
  'The webhook''s eraser (0400): removes p_key from the company''s billing_notices (a subscription that goes active again releases "lapsed", so a later lapse is told) and answers true; false when the key was not there or the company is not. Service role only.';
revoke execute on function public.release_billing_notice(uuid, text) from public, anon, authenticated;
grant execute on function public.release_billing_notice(uuid, text) to service_role;

-- ── 6. North's own team comps a company ─────────────────────────────────────────────────────────
create or replace function public.platform_set_comped_until(p_org uuid, p_until timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'Only North''s own team can comp a company.' using errcode = '42501';
  end if;
  -- The row as it stands, locked, so the audit's "from" is the value this write replaces.
  select o.comped_until into v_prev from public.organizations o where o.id = p_org for update;
  if not found then
    return false;
  end if;
  update public.organizations set comped_until = p_until where id = p_org;
  -- The undo trail (0398's shape): who comped the company, from what to what. /audit reads this.
  insert into public.agent_audit_log (org_id, user_id, action, risk, effect, ok, input_summary, source)
  values (p_org, auth.uid(), 'comp.set', 1, 'write', true,
          jsonb_build_object('from', v_prev, 'to', p_until), 'ui');
  return true;
end $$;
comment on function public.platform_set_comped_until(uuid, timestamptz) is
  'Bug Watch''s Comp Until / End Comp (0400): sets a company''s comped_until (null clears) for North''s own team only (is_platform_admin, 0176), checked inside, and writes one agent_audit_log row (comp.set, {from, to}). Returns true when the company was there.';
revoke execute on function public.platform_set_comped_until(uuid, timestamptz) from public, anon;
grant execute on function public.platform_set_comped_until(uuid, timestamptz) to authenticated;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_fn    text;
  v_check text;
  v_using text;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'billing_notices')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'comped_until') then
    raise exception '0400: billing_notices or comped_until is missing from organizations. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bills' and column_name = 'both_real_at') then
    raise exception '0400: both_real_at is missing from bills. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'billing_notices' and is_nullable = 'NO') then
    raise exception '0400: billing_notices is nullable; the ledger must always be a map. Nothing was changed.';
  end if;
  -- The policy: there, for UPDATE, 0181's roles and clauses carried, the three new clauses present.
  select p.with_check, p.qual into v_check, v_using
    from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'organizations' and p.policyname = 'organizations_update' and p.cmd = 'UPDATE';
  if v_check is null or v_using is null then
    raise exception '0400: the organizations_update policy is missing, or is not an UPDATE policy. Nothing was changed.';
  end if;
  if position('office' in v_using) = 0 or position('office' in v_check) = 0 then
    raise exception '0400: the office seat (0181) fell out of organizations_update. Nothing was changed.';
  end if;
  foreach v_fn in array array['subscription_status', 'trial_ends_at', 'current_period_end', 'plan', 'stripe_customer_id',
                              'stripe_subscription_id', 'stripe_price_id', 'stripe_account_id', 'stripe_account_status',
                              'stripe_charges_enabled', 'stripe_platform_fee_bps',
                              'billing_notices', 'comped_until', 'stripe_terminal_location_id'] loop
    if position(v_fn in v_check) = 0 then
      raise exception '0400: organizations_update does not pin %. Nothing was changed.', v_fn;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.organizations'::regclass) then
    raise exception '0400: row level security is off on organizations, so the pin is dead. Nothing was changed.';
  end if;
  -- The three functions: there, security definer, search_path pinned, the right grants.
  foreach v_fn in array array['public.claim_billing_notice(uuid, text)', 'public.release_billing_notice(uuid, text)', 'public.platform_set_comped_until(uuid, timestamptz)'] loop
    if to_regprocedure(v_fn) is null then
      raise exception '0400: % is missing. Nothing was changed.', v_fn;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = v_fn::regprocedure and p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0400: % is not security definer with its search_path pinned. Nothing was changed.', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception '0400: anon can call %. Nothing was changed.', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['public.claim_billing_notice(uuid, text)', 'public.release_billing_notice(uuid, text)'] loop
    if has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '0400: a signed-in person can call % (service role only). Nothing was changed.', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0400: the service role cannot call %; the notices cron would be locked out. Nothing was changed.', v_fn;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.platform_set_comped_until(uuid, timestamptz)', 'execute') then
    raise exception '0400: a signed-in person cannot reach platform_set_comped_until (it checks the admin inside). Nothing was changed.';
  end if;
  -- The comp door refuses a stranger in words and writes the audit row: the body on the database, not only the file.
  if position('is_platform_admin' in pg_get_functiondef('public.platform_set_comped_until(uuid, timestamptz)'::regprocedure)) = 0
     or position('agent_audit_log' in pg_get_functiondef('public.platform_set_comped_until(uuid, timestamptz)'::regprocedure)) = 0 then
    raise exception '0400: platform_set_comped_until does not check the admin or does not write the audit row. Nothing was changed.';
  end if;
  raise notice '0400: the trial warns, the lapse keeps the lights on — the notices ledger and the comp are columns the service role and the RPCs alone move, Tap to Pay''s location is pinned once set, North''s team comps a company with an audit row.';
end $$;
