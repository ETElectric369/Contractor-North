-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0397: the owner-only settings are pinned in the database
--
-- organizations.settings is one jsonb column and RLS cannot see inside it (0181's own note): since
-- 0181 an owner, an admin AND an office seat may PATCH the whole column for their own company. Two
-- keys in it are not theirs to move, and the app alone kept them:
--
--   office_sees_owner_money   the owner's one switch (0286): may the office see the owner's money on
--                             the Analytics page. Its only screen is setOfficeSeesOwnerMoney
--                             (analytics/actions.ts), owner-only IN THE APP; updateOrgSettings strips
--                             it from the general save. 0286's guard_owner_money_visibility trigger
--                             already refuses anyone but an owner at the database; it stays.
--   lead_inbound_secret       the per-company key a partner lead-generator sends on
--                             /api/inbound/lead (x-inbound-key). NO screen writes it (it is a
--                             PROTECTED_SETTINGS_KEYS entry the general save strips); North sets it
--                             by hand. An office seat's direct PATCH could still replace it.
--
-- The other two PROTECTED_SETTINGS_KEYS, custom_domain and public_handle, are NOT pinned here:
-- their setters (setCustomDomain, setPublicHandle) are staff doors that write with the person's
-- own client, so a pin to the owner or the server would refuse the office's own saves. The switch
-- board (features, trade, timeclock_job_codes) is 0352's pin_org_features and is not touched.
--
-- THE FIX: pin_owner_settings (BEFORE UPDATE OF settings on organizations). For each pinned key
-- that is changing, the write goes through only when the writer may move it, and is otherwise
-- REFUSED IN WORDS naming the one action (never a silent drop, 0352's rule):
--   office_sees_owner_money   public.app_user_role() = 'owner' (0158: an active seat; a deactivated
--                             owner reads NULL and is nobody), or a privileged writer
--                             (0154's is_privileged_writer: a migration, the service role);
--   lead_inbound_secret       a privileged writer only.
-- A write that carries both keys through unchanged (every ordinary settings save, every read-
-- merge-write by the office) is not this trigger's business and passes untouched.
--
-- ONE RULE, TWO TRIGGERS, FOR NOW: 0286's guard fires first for office_sees_owner_money (triggers
-- fire in name order) with its own words; this trigger holds every owner-only key in one place and
-- stands on its own the day 0286's is retired (owner-settings.integration proves both).
--
-- WHAT THIS CHANGES TODAY: nothing on any screen. Every app door already meets these rules; only a
-- hand-made PATCH by an office or admin seat is refused, and it is refused in words.
--
-- LOCKS: organizations (CREATE TRIGGER: share row exclusive for a moment). lock_timeout 3s: a busy
-- table fails fast and changes nothing rather than queueing sign-ins; run it again. Twice-safe.
--
-- ORDER: after 0158 (app_user_role reads the active seat), 0154 (is_privileged_writer), 0286 and
-- 0352. Safe to apply before or after the deploy: no code in cn-v1134 depends on it, and no app
-- write changes a pinned key by any door the trigger would refuse.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.app_user_role()') is null or to_regprocedure('public.is_privileged_writer()') is null then
    raise exception '0397: the trust-root helpers (0154, 0158) are not on this database. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pin_org_features' and tgrelid = 'public.organizations'::regclass and not tgisinternal) then
    raise exception '0397: 0352''s pin_org_features trigger is missing; apply 0352 first. Nothing was changed.';
  end if;
end $$;

-- ── THE PIN: who may move each owner-only key, said in words when it is not them ────────────────
create or replace function public.pin_owner_settings()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_money_moved boolean := (new.settings -> 'office_sees_owner_money') is distinct from (old.settings -> 'office_sees_owner_money');
  v_secret_moved boolean := (new.settings -> 'lead_inbound_secret') is distinct from (old.settings -> 'lead_inbound_secret');
begin
  -- Nothing pinned is changing: not this trigger's business.
  if not v_money_moved and not v_secret_moved then
    return new;
  end if;
  -- A migration or the server (the service role) may move anything here.
  if public.is_privileged_writer() then
    return new;
  end if;
  -- office_sees_owner_money: the owner's switch, on the Analytics page. 0158: a deactivated owner
  -- reads NULL here and is refused like anyone else.
  if v_money_moved and public.app_user_role() is distinct from 'owner' then
    raise exception 'Only the owner changes who sees the owner''s money, on the Analytics page.';
  end if;
  -- lead_inbound_secret: no screen writes it; North sets it by hand.
  if v_secret_moved then
    raise exception 'Only North sets the inbound lead key. Ask North to change it.';
  end if;
  return new;
end $$;
revoke execute on function public.pin_owner_settings() from public, anon, authenticated;
comment on function public.pin_owner_settings() is
  'The owner-only settings keys (0397): office_sees_owner_money moves for an active owner or a privileged writer, lead_inbound_secret for a privileged writer only; anyone else is refused in words.';

drop trigger if exists pin_owner_settings on public.organizations;
create trigger pin_owner_settings
  before update of settings on public.organizations
  for each row execute function public.pin_owner_settings();

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.pin_owner_settings()') is null then
    raise exception '0397: pin_owner_settings() is missing. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'pin_owner_settings' and tgrelid = 'public.organizations'::regclass
                    and not tgisinternal and tgenabled <> 'D') then
    raise exception '0397: the pin_owner_settings trigger is missing or disabled. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.pin_owner_settings()', 'execute')
     or has_function_privilege('authenticated', 'public.pin_owner_settings()', 'execute') then
    raise exception '0397: pin_owner_settings() is callable by someone it should not be. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pin_org_features' and tgrelid = 'public.organizations'::regclass and not tgisinternal) then
    raise exception '0397: 0352''s pin_org_features trigger went missing. Nothing was changed.';
  end if;
  raise notice '0397: the owner-only settings are pinned.';
end $$;
