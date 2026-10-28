-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0398: the owner can change the company's trade
--
-- settings.trade is the KEY every trade-shaped door branches on (lib/org-trade orgTrade: the job
-- codes a company starts with, the switches that start on, the inspection starter, the public
-- intake, the calculator packages, Nort's words, a permit's default). 0352 pinned it: only
-- create_organization at sign-up and 0355's backfill may write it, and pin_org_features carries
-- every other writer's copy through unchanged. That was right — a settings save by the office is
-- not an intent to change what the company does — but it left NO door at all: a company that
-- picked "Other" at sign-up, or picked wrong, or changed what it does, could not say so, while
-- settings/page.tsx promised it could. The one writer it needs is this function.
--
-- WHAT IT DOES: one function, in set_org_feature's shape (0352 §4). The owner of an active seat
-- (0158: app_user_role reads NULL for a deactivated owner, who is nobody), their own company
-- (auth_org_id, never a parameter), one of the app's ten trades or blank, the row locked, the
-- key written under cn.feature_writer so the pin lets it through, the stored value read back
-- and compared (a quiet miss is a failure, never a success), one audit row (the undo trail), and
-- {previous, trade} returned so the app can say what happened.
--
-- WHAT IT DOES NOT DO: it writes the ONE key. features and timeclock_job_codes are not read, not
-- rewritten and not re-derived — the pin carries them through anyway, and a trade change in this
-- app never flips a switch, seeds a code or starts a sheet on its own: the app OFFERS those,
-- each behind its own button (Settings › Features › Your Trade & Pricing), and says what each did.
-- trade_label (the company's own words) is the app's to keep or clear; it is not pinned.
--
-- THE TRADE LIST is 0352 create_organization's, byte for byte and in its order (lib/trade-package
-- TRADE_ORDER; tests/migration-0398.test.ts holds the three to one list). A stored 'solar' would
-- fail 0355's known-trade self-check for every company after it, so an unknown word is refused in
-- words rather than stored.
--
-- LOCKS: none on a table (CREATE FUNCTION takes no table lock). lock_timeout 3s and a 15s
-- statement timeout all the same, as every migration here: fail fast, change nothing, run again.
-- Twice-safe (create or replace; the grants are idempotent).
--
-- ORDER: after 0154 (is_privileged_writer, read by the pin), 0158 (app_user_role), 0352 (the pin,
-- auth_org_id's seat rule, agent_audit_log's shape as set_org_feature writes it) and 0397. Safe to
-- apply before the deploy: nothing in the app calls set_org_trade until cn-v1135, and the app says
-- "needs an update from North" when the function is not there yet (PGRST202).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.auth_org_id()') is null or to_regprocedure('public.app_user_role()') is null then
    raise exception '0398: the trust-root helpers (auth_org_id, app_user_role) are not on this database. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pin_org_features' and tgrelid = 'public.organizations'::regclass and not tgisinternal) then
    raise exception '0398: 0352''s pin_org_features trigger is missing; apply 0352 first. Nothing was changed.';
  end if;
  if to_regclass('public.agent_audit_log') is null then
    raise exception '0398: agent_audit_log (0064) is missing. Nothing was changed.';
  end if;
end $$;

-- ── THE WRITER: the owner, their own company, the one key, atomic ───────────────────────────────
create or replace function public.set_org_trade(p_trade text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.auth_org_id();   -- NULL for a deactivated seat (0158)
  v_prev text;
  v_now text;
begin
  if v_org is null then
    raise exception 'Sign in to your company first.';
  end if;
  if public.app_user_role() is distinct from 'owner' then
    raise exception 'Only the owner can change the company''s trade.';
  end if;
  -- Blank (or nothing) means "Other / Not Listed": the key is removed, the app stays neutral.
  p_trade := coalesce(trim(p_trade), '');
  if p_trade <> '' and not (p_trade = any (array['general','deck','electrical','plumbing','hvac',
                                                  'landscaping','roofing','concrete','tile','painting'])) then
    raise exception 'There is no trade called "%".', p_trade;
  end if;

  -- The row as it stands, locked, so the previous value is the one this write replaces.
  select o.settings ->> 'trade' into v_prev from public.organizations o where o.id = v_org for update;
  if not found then
    raise exception 'Sign in to your company first.';
  end if;

  -- set_org_feature's door through the pin: this company, this transaction only. PostgREST cannot
  -- set a cn.* setting, so no browser can claim it. ONE write touching ONE key on the locked row.
  perform set_config('cn.feature_writer', v_org::text, true);
  update public.organizations o
     set settings = case
           when p_trade = '' then coalesce(o.settings, '{}'::jsonb) - 'trade'
           else jsonb_set(coalesce(o.settings, '{}'::jsonb), '{trade}', to_jsonb(p_trade), true)
         end
   where o.id = v_org
  returning o.settings ->> 'trade' into v_now;
  perform set_config('cn.feature_writer', '', true);

  if v_now is distinct from nullif(p_trade, '') then
    raise exception 'That didn''t save. Reload and try again.';
  end if;

  -- The undo trail: who changed the trade, from what to what (/audit reads this table).
  insert into public.agent_audit_log (org_id, user_id, action, risk, effect, ok, input_summary, source)
  values (v_org, auth.uid(), 'trade.set', 1, 'write', true,
          jsonb_build_object('from', v_prev, 'to', nullif(p_trade, '')), 'ui');

  return jsonb_build_object('previous', v_prev, 'trade', nullif(p_trade, ''));
end $$;
revoke execute on function public.set_org_trade(text) from public, anon;
grant execute on function public.set_org_trade(text) to authenticated, service_role;
comment on function public.set_org_trade(text) is
  'Change the caller''s company''s trade key (0398): one of the app''s trades, or blank for Other. Owner only. Writes only settings.trade, returns {previous, trade} and one agent_audit_log row. Codes, switches and sheets are offered by the app, never moved here.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.set_org_trade(text)') is null then
    raise exception '0398: set_org_trade(text) is missing. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_proc p
                  where p.oid = 'public.set_org_trade(text)'::regprocedure
                    and p.prosecdef
                    and p.proconfig @> array['search_path=public']) then
    raise exception '0398: set_org_trade(text) is not security definer with its search_path pinned. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.set_org_trade(text)', 'execute') then
    raise exception '0398: set_org_trade(text) is callable by anon. Nothing was changed.';
  end if;
  if not has_function_privilege('authenticated', 'public.set_org_trade(text)', 'execute') then
    raise exception '0398: set_org_trade(text) is not callable by a signed-in person. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'pin_org_features' and tgrelid = 'public.organizations'::regclass
                    and not tgisinternal and tgenabled <> 'D') then
    raise exception '0398: 0352''s pin_org_features trigger went missing or is disabled. Nothing was changed.';
  end if;
  raise notice '0398: the owner can change the company''s trade.';
end $$;
