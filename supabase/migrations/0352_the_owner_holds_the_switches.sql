-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0352: the owner holds the switches (the switch board, Wave 0)
--
-- Erik's toggles rule (2026-09-26): simplicity is per-company FEATURE SWITCHES, never a cut and
-- never a paid tier. A switch hides doors only: it never deletes a row, never changes a number, and
-- a record opened by a link still opens (with an Off line). The trade a company picks at sign-up
-- sets its starting switches; today that pick is thrown away after it chooses the job codes.
--
-- THE DEFECT THIS CLOSES BEFORE IT EXISTS. organizations.settings is one jsonb column and RLS can't
-- see inside it (0181's own note): owner, admin and office may PATCH the whole thing, and
-- publish_site_version merges an unwhitelisted p_doc onto it. A switch kept there with nothing
-- else would be moved by any staff save, any hand PATCH, or a read-merge-write race.
--
-- THE FIX:
--   1. feature_keys(): THE ONE WHITELIST. src/lib/features.ts FEATURE_KEYS must equal it
--      (features.test.ts parses this file; the feature-switches DB suite calls it).
--   2. org_feature_on(org, key): the SQL reader, same rule as normalizeFeatures (a missing or
--      non-boolean key is ON; job_codes falls back to the old timeclock_job_codes checkbox).
--      Service role only: it is for server code and SQL gates, never a browser.
--   3. pin_org_features (BEFORE UPDATE OF settings on organizations): settings.features,
--      settings.trade and settings.timeclock_job_codes are carried through UNCHANGED for every
--      writer except set_org_feature and a privileged writer (a migration, the service role;
--      0154's is_privileged_writer). That covers updateOrgSettings, every other settings action,
--      update_site_content, publish_site_version's merge and any direct PATCH. The trigger reads
--      OLD as the newest committed row, so the lost-update race can't move a switch either.
--      create_organization only INSERTs, which this trigger never sees.
--   4. set_org_feature(key, on): THE WRITER. Owner only (app_user_role() of an active seat, 0158:
--      a deactivated owner is nobody), the caller's own company (auth_org_id()), one whitelisted
--      key, one atomic jsonb_set under a row lock. Returns {key, previous, on} (previous by the
--      read rule, so Undo is exact) and writes one agent_audit_log row ('feature.set', the key
--      and both values), the app's existing audit trail (/audit). job_codes also writes the old
--      timeclock_job_codes key, so the raw row never says two things.
--   5. create_organization gains p_trade and p_features: the picked trade KEY and its starting
--      switches (whitelisted booleans only) are saved on the new company. The body is 0246's,
--      which is the LIVE body (pg_get_functiondef on production, 2026-09-26, md5 checked below
--      before anything is replaced), with only those two additions.
--
-- WHAT THIS CHANGES TODAY: nothing on any screen. No company has settings.features, so every
-- switch reads ON, exactly as today; the backfill that writes each existing company's map is 0355
-- (a dry run to Erik first).
--
-- LOCKS: organizations (CREATE TRIGGER: share row exclusive for a moment). Function replaces.
-- lock_timeout 3s: a busy table fails fast and changes nothing rather than queueing sign-ins; run
-- it again.
--
-- ORDER: after 0246 (the create_organization body), 0158 (the trust-root helpers), 0154
-- (is_privileged_writer) and 0064 (agent_audit_log). SAFE BEFORE OR AFTER THE CODE: before it, the
-- app reads every switch as ON, Settings > Features says the switches need an update from North,
-- and sign-up falls back to the old two-argument create_organization (PGRST202). After it, the old
-- two-argument call still works (the new parameters default to null). Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
declare
  v_old regprocedure := to_regprocedure('public.create_organization(text, jsonb)');
begin
  if to_regprocedure('public.auth_org_id()') is null or to_regprocedure('public.app_user_role()') is null
     or to_regprocedure('public.is_privileged_writer()') is null or to_regclass('public.agent_audit_log') is null then
    raise exception '0352: the trust-root helpers (0154, 0158) or agent_audit_log (0064) are not on this database. Nothing was changed.';
  end if;
  -- The body below is 0246's. If the live one has moved since, replacing it would undo whatever
  -- moved it (0320 undid 0313 that way). A re-run finds the old signature gone and skips this.
  if v_old is not null and md5(pg_get_functiondef(v_old)) <> '3649fa5c9531e12522302e16ec800468' then
    raise exception '0352: create_organization(text, jsonb) is not 0246''s body any more. Rebuild 0352 on the live body. Nothing was changed.';
  end if;
end $$;

-- ── 1. THE ONE WHITELIST ────────────────────────────────────────────────────────────────────────
create or replace function public.feature_keys()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'leads', 'referrals',
    'estimates', 'kits',
    'contracts',
    'purchase_orders',
    'shop_stock',
    'crew_payroll', 'daily_reports', 'crew_board',
    'job_codes',
    'permits',
    'panel_map',
    'customer_portal',
    'recurring_billing',
    'sales_tax',
    'licenses', 'safety_log',
    'website', 'site_chat',
    'nort',
    'calculators',
    'todo_extras'
  ]::text[];
$$;
revoke execute on function public.feature_keys() from public, anon;
grant execute on function public.feature_keys() to authenticated, service_role;
comment on function public.feature_keys() is
  'The feature switch whitelist (0352). src/lib/features.ts FEATURE_KEYS must equal it.';

-- ── 2. THE SQL READER (same rule as normalizeFeatures; parents are the caller's to check) ─────────
create or replace function public.org_feature_on(p_org uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when jsonb_typeof(o.settings -> 'features' -> p_key) = 'boolean'
               then (o.settings -> 'features' ->> p_key)::boolean
             when p_key = 'job_codes'
               then (o.settings -> 'timeclock_job_codes') is distinct from 'false'::jsonb
             else true
           end
      from public.organizations o
     where o.id = p_org), true);
$$;
revoke execute on function public.org_feature_on(uuid, text) from public, anon, authenticated;
grant execute on function public.org_feature_on(uuid, text) to service_role;
comment on function public.org_feature_on(uuid, text) is
  'Is one feature switch on for this company (0352)? Missing or non-boolean = on; job_codes falls back to timeclock_job_codes. Service role only.';

-- ── 3. ONLY ONE DOOR MOVES A SWITCH ─────────────────────────────────────────────────────────────
create or replace function public.pin_org_features()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  k text;
begin
  if (new.settings -> 'features') is not distinct from (old.settings -> 'features')
     and (new.settings -> 'trade') is not distinct from (old.settings -> 'trade')
     and (new.settings -> 'timeclock_job_codes') is not distinct from (old.settings -> 'timeclock_job_codes') then
    return new;
  end if;
  -- set_org_feature names the ONE company it is writing, for this transaction only. PostgREST
  -- cannot set a cn.* setting, so no browser can claim it.
  if coalesce(current_setting('cn.feature_writer', true), '') = new.id::text or public.is_privileged_writer() then
    return new;
  end if;
  -- Anyone else's copy of these keys is not an intent: carry the stored value through.
  foreach k in array array['features', 'trade', 'timeclock_job_codes'] loop
    if (new.settings -> k) is distinct from (old.settings -> k) then
      new.settings := case
        when old.settings ? k then jsonb_set(coalesce(new.settings, '{}'::jsonb), array[k], old.settings -> k, true)
        else coalesce(new.settings, '{}'::jsonb) - k
      end;
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.pin_org_features() from public, anon, authenticated;

drop trigger if exists pin_org_features on public.organizations;
create trigger pin_org_features
  before update of settings on public.organizations
  for each row execute function public.pin_org_features();

-- ── 4. THE WRITER: the owner, their own company, one whitelisted key, atomic ─────────────────────
create or replace function public.set_org_feature(p_key text, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.auth_org_id();   -- NULL for a deactivated seat (0158)
  v_settings jsonb;
  v_prev boolean;
  v_now jsonb;
begin
  if v_org is null then
    raise exception 'Sign in to your company first.';
  end if;
  if public.app_user_role() is distinct from 'owner' then
    raise exception 'Only the owner can turn features on or off.';
  end if;
  if p_key is null or not (p_key = any (public.feature_keys())) then
    raise exception 'There is no feature called "%".', coalesce(p_key, '');
  end if;
  if p_on is null then
    raise exception 'Say on or off.';
  end if;

  select o.settings into v_settings from public.organizations o where o.id = v_org for update;
  if not found then
    raise exception 'Sign in to your company first.';
  end if;
  -- The read rule (normalizeFeatures), so the previous value is what the app showed.
  v_prev := case
    when jsonb_typeof(v_settings -> 'features' -> p_key) = 'boolean' then (v_settings -> 'features' ->> p_key)::boolean
    when p_key = 'job_codes' then (v_settings -> 'timeclock_job_codes') is distinct from 'false'::jsonb
    else true
  end;

  -- One jsonb_set on the row as it stands (it is locked above), so no other key can be lost.
  perform set_config('cn.feature_writer', v_org::text, true);
  update public.organizations o
     set settings = jsonb_set(
           case when jsonb_typeof(o.settings -> 'features') = 'object' then o.settings
                else jsonb_set(coalesce(o.settings, '{}'::jsonb), '{features}', '{}'::jsonb, true) end,
           array['features', p_key], to_jsonb(p_on), true)
   where o.id = v_org
  returning o.settings -> 'features' -> p_key into v_now;
  if p_key = 'job_codes' then
    update public.organizations o
       set settings = jsonb_set(o.settings, '{timeclock_job_codes}', to_jsonb(p_on), true)
     where o.id = v_org;
  end if;
  perform set_config('cn.feature_writer', '', true);

  if v_now is distinct from to_jsonb(p_on) then
    raise exception 'That didn''t save. Reload and try again.';
  end if;

  -- The undo trail: who moved which switch, from what to what (/audit reads this table).
  insert into public.agent_audit_log (org_id, user_id, action, risk, effect, ok, input_summary, source)
  values (v_org, auth.uid(), 'feature.set', 1, 'write', true,
          jsonb_build_object('key', p_key, 'from', v_prev, 'to', p_on), 'ui');

  return jsonb_build_object('key', p_key, 'previous', v_prev, 'on', p_on);
end $$;
revoke execute on function public.set_org_feature(text, boolean) from public, anon;
grant execute on function public.set_org_feature(text, boolean) to authenticated, service_role;
comment on function public.set_org_feature(text, boolean) is
  'Turn one feature switch on or off for the caller''s company (0352). Owner only. Returns {key, previous, on} and writes one agent_audit_log row.';

-- ── 5. SIGN-UP KEEPS THE TRADE AND WRITES THE SWITCHES (0246's body + p_trade/p_features) ───────
-- DROP first: adding defaulted parameters beside the old signature would leave an overload, and
-- PostgREST refuses the existing {p_name, p_codes} call as ambiguous.
drop function if exists public.create_organization(text, jsonb);

create or replace function public.create_organization(
  p_name text,
  p_codes jsonb default null,
  p_trade text default null,
  p_features jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  existing uuid;
  new_org uuid;
  -- 0352: the picked trade KEY (the words stay in trade_label). Only one of the app's trades
  -- (lib/trade-codes TRADE_ORDER; features-backfill.test holds this list to it): anything else,
  -- from the app or a direct call, is stored as blank. A stored 'solar' would fail 0355's
  -- known-trade self-check for every company, and only this function can write settings.trade.
  v_trade text := case when p_trade = any (array['general','deck','electrical','plumbing','hvac',
                                                  'landscaping','roofing','concrete','tile','painting'])
                       then p_trade end;
  v_features jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated.';
  end if;

  -- 0246: `active` is a boundary, not a badge (0158). Without this a deactivated person holding an
  -- unexpired token could mint a fresh org and be an owner again.
  if exists (select 1 from public.profiles where id = uid and active = false) then
    raise exception 'This account has been deactivated.';
  end if;

  select org_id into existing from public.profiles where id = uid;
  if existing is not null then
    return existing;  -- already in an org; no-op
  end if;

  -- 0352: only whitelisted keys holding real booleans; anything else is dropped (missing = ON).
  if jsonb_typeof(p_features) = 'object' then
    select jsonb_object_agg(e.key, e.value) into v_features
      from jsonb_each(p_features) e
     where e.key = any (public.feature_keys())
       and jsonb_typeof(e.value) = 'boolean';
  end if;

  insert into public.organizations (name, settings)
  values (
    coalesce(nullif(trim(p_name), ''), 'My Company'),
    jsonb_strip_nulls(jsonb_build_object(
      'trade', v_trade,
      'features', v_features,
      'timeclock_job_codes', v_features -> 'job_codes'))
  )
  returning id into new_org;

  update public.profiles set org_id = new_org, role = 'owner' where id = uid;
  if not found then
    insert into public.profiles (id, org_id, role, email)
    values (uid, new_org, 'owner', auth.email())
    on conflict (id) do update set org_id = new_org, role = 'owner';
  end if;

  -- Job codes: the picked trade's preset if supplied, otherwise a trade-neutral set. (Seeded even
  -- when the Job Codes switch starts off: the codes are there, the clock just doesn't ask.)
  if p_codes is not null and jsonb_typeof(p_codes) = 'array' and jsonb_array_length(p_codes) > 0 then
    insert into public.job_codes (org_id, code, description, billable)
    select new_org,
           upper(trim(e->>'code')),
           coalesce(nullif(trim(e->>'description'), ''), upper(trim(e->>'code'))),
           coalesce((e->>'billable')::boolean, true)
    from jsonb_array_elements(p_codes) e
    where coalesce(trim(e->>'code'), '') <> ''
    on conflict do nothing;
  else
    insert into public.job_codes (org_id, code, description, billable) values
      (new_org, 'SVC',    'Service call',     true),
      (new_org, 'INSTALL','Install / build',  true),
      (new_org, 'REPAIR', 'Repair',           true),
      (new_org, 'LABOR',  'General labor',    true),
      (new_org, 'MATL',   'Material run',     true),
      (new_org, 'TRAVEL', 'Travel time',      true),
      (new_org, 'CLEAN',  'Cleanup',          true),
      (new_org, 'SHOP',   'Shop / yard time', false),
      (new_org, 'PTO',    'Paid time off',    false)
    on conflict do nothing;
  end if;

  -- Trade-neutral starter safety form.
  insert into public.forms (org_id, name, description, schema)
  values (
    new_org,
    'Job Site Safety Checklist',
    'Quick pre-work safety walkthrough.',
    '[
      {"key":"ppe","label":"PPE worn (hard hat, glasses, gloves, boots)","type":"checkbox"},
      {"key":"site","label":"Walked the site for hazards","type":"checkbox"},
      {"key":"equipment","label":"Tools & equipment inspected / in good condition","type":"checkbox"},
      {"key":"firstaid","label":"First-aid kit on site","type":"checkbox"},
      {"key":"hazards","label":"Hazards noted","type":"textarea"},
      {"key":"photos","label":"Site photos attached","type":"checkbox"}
    ]'::jsonb
  );

  return new_org;
end $function$;

revoke execute on function public.create_organization(text, jsonb, text, jsonb) from public, anon;
grant execute on function public.create_organization(text, jsonb, text, jsonb) to authenticated, service_role;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from pg_proc where proname = 'create_organization' and pronamespace = 'public'::regnamespace) <> 1
     or to_regprocedure('public.create_organization(text, jsonb, text, jsonb)') is null then
    raise exception '0352: create_organization must have exactly one signature, (text, jsonb, text, jsonb). Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pin_org_features' and tgrelid = 'public.organizations'::regclass and not tgisinternal) then
    raise exception '0352: the pin_org_features trigger is missing. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.set_org_feature(text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.create_organization(text, jsonb, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.org_feature_on(uuid, text)', 'execute') then
    raise exception '0352: a switch function is callable by someone it should not be. Nothing was changed.';
  end if;
  if not has_function_privilege('authenticated', 'public.set_org_feature(text, boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.create_organization(text, jsonb, text, jsonb)', 'execute') then
    raise exception '0352: a signed-in owner cannot call set_org_feature or create_organization. Nothing was changed.';
  end if;
  if cardinality(public.feature_keys()) <> 23 or (select count(distinct k) from unnest(public.feature_keys()) k) <> 23 then
    raise exception '0352: feature_keys() must hold 23 distinct keys. Nothing was changed.';
  end if;
  if not (select p.prosecdef and 'search_path=public' = any (p.proconfig)
            from pg_proc p where p.oid = 'public.set_org_feature(text, boolean)'::regprocedure) then
    raise exception '0352: set_org_feature must be SECURITY DEFINER with its search_path pinned. Nothing was changed.';
  end if;
  raise notice '0352: the owner holds the switches.';
end $$;
