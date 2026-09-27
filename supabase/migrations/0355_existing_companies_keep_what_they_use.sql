-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0355: existing companies keep what they use (the switch board's
-- one-time backfill)
--
-- 0352 made the switches; a company with no stored map reads every switch ON. This writes each
-- existing company's map ONCE, so the switch board starts from what the company actually does
-- instead of "everything":
--
--   each switch = ON when the company's TRADE preset says so (lib/features featurePreset, the same
--                 maps below; features.test.ts checks they match) OR the company has REAL ROWS in
--                 it. "Nothing disappears overnight": a feature anybody used stays on.
--
-- THE TRADE KEY: settings.trade when it is already one of the trade keys; otherwise read from the
-- words in settings.trade_label ("electrical contractor" → electrical, "deck builder" → deck,
-- "Construction" → general, …); otherwise blank (the light preset). It is written as
-- settings.trade too, so the company's trade stops being thrown away.
--
-- REAL ROWS, and what does NOT count (every count names the company's own org_id):
--   · Customer Portal: sessions, links a customer actually opened, documents shared to a job. NOT
--     the portal links themselves: 0298 mints one for every customer, so they are not use.
--   · Job Codes: clock-ins that carry a code, or codes somebody added more than a day after the
--     company was made. NOT the codes create_organization seeds at sign-up. A company that turned
--     the old "Ask the crew for job codes" box off keeps it off.
--   · Safety Log: safety records and filled-in forms other than a walk-through or the intake form.
--     NOT the seeded Job Site Safety Checklist sitting unused.
--   · Kits & Sizing: kits, sized kit lines or price-list items, or a company that prices from its
--     own book (estimating_mode 'catalog'): its estimates and public configurator read kits.
--   · Site Chat: chat leads, or a public site live today: the chat widget shows on every live site
--     now, so it stays until the owner turns it off.
--   · Sales Tax: tax rates, a taxed invoice, estimate or repeat invoice, or a default rate above 0.
--   · The rest by their own rows (see the plan below).
--
-- ONLY companies missing switches are touched (no map, or a partial one if an owner flipped a
-- switch between 0352 and this), only the missing keys are filled, and a stored switch always
-- wins: a re-run changes nothing and an owner's own switches are never overwritten. No row is
-- deleted; no number changes; only organizations.settings gains features, trade and
-- timeclock_job_codes (the mirror of Job Codes). It runs as a migration (no JWT), so 0352's
-- pin_org_features lets it write.
--
-- DRY RUN FIRST: the same plan, as a read-only SELECT, was run on production and shown to Erik
-- (the preview names every company, switch and reason). Nothing in this file names a company.
--
-- LOCKS: organizations (row locks on the companies written, briefly). lock_timeout 3s.
--
-- ORDER: after 0352. SAFE BEFORE OR AFTER THE CODE: the app reads a stored map the same way it
-- reads none (lib/features normalizeFeatures), and code that doesn't know the switches ignores
-- them. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.feature_keys()') is null
     or not exists (select 1 from pg_trigger where tgname = 'pin_org_features' and tgrelid = 'public.organizations'::regclass) then
    raise exception '0355: the switch board (0352) is not on this database. Apply 0352 first. Nothing was changed.';
  end if;
  if not public.is_privileged_writer() then
    raise exception '0355: runs as a migration only (no signed-in session). Nothing was changed.';
  end if;
end $$;

drop table if exists pg_temp.feature_backfill_plan;
-- ▼ PLAN (the dry run is this same text as a SELECT)
create temporary table feature_backfill_plan on commit drop as
with blank_preset (features) as (
  select '{"leads": true, "referrals": false, "estimates": true, "kits": false, "contracts": false, "purchase_orders": false, "shop_stock": false, "crew_payroll": true, "daily_reports": false, "crew_board": false, "job_codes": false, "permits": true, "panel_map": false, "customer_portal": false, "recurring_billing": false, "sales_tax": false, "licenses": true, "safety_log": false, "website": true, "site_chat": false, "nort": true, "calculators": true, "todo_extras": false}'::jsonb
),
trade_presets (trade, features) as (
  values
    ('general', '{"kits": true, "contracts": true}'::jsonb),
    ('deck', '{"kits": true, "contracts": true}'::jsonb),
    ('roofing', '{"kits": true, "contracts": true}'::jsonb),
    ('concrete', '{"kits": true, "contracts": true}'::jsonb),
    ('electrical', '{"shop_stock": true, "panel_map": true}'::jsonb),
    ('plumbing', '{"shop_stock": true}'::jsonb),
    ('hvac', '{"shop_stock": true}'::jsonb),
    ('tile', '{"kits": true}'::jsonb),
    ('landscaping', '{"permits": false}'::jsonb),
    ('painting', '{"permits": false}'::jsonb)
),
orgs as (
  select o.id, o.name, o.created_at, o.settings, coalesce(o.default_tax_rate, 0) as default_tax_rate,
         coalesce(
           (select t.trade from trade_presets t where t.trade = o.settings ->> 'trade'),
           case
             when l ~ 'electric' then 'electrical'
             when l ~ 'deck' then 'deck'
             when l ~ 'plumb' then 'plumbing'
             when l ~ '(hvac|heating|\mair\M)' then 'hvac'
             when l ~ 'roof' then 'roofing'
             when l ~ 'concrete' then 'concrete'
             when l ~ '\mtile' then 'tile'
             when l ~ 'landscap' then 'landscaping'
             when l ~ 'paint' then 'painting'
             when l ~ '(construct|builder|remodel|general contractor)' then 'general'
             else ''
           end) as trade
    from public.organizations o
    cross join lateral (select lower(coalesce(o.settings ->> 'trade_label', '')) as l) tl
   -- No map, or a partial one (an owner flipped a switch between 0352 and this): the plan fills
   -- only the missing keys; a stored switch always wins (the UPDATE below).
   where (select count(*) from jsonb_each(case when jsonb_typeof(o.settings -> 'features') = 'object' then o.settings -> 'features' else '{}'::jsonb end) e
           where e.key = any (public.feature_keys()) and jsonb_typeof(e.value) = 'boolean') < cardinality(public.feature_keys())
),
counts as (
  select g.id,
    jsonb_build_object(
      'leads', jsonb_build_object(
        'leads', (select count(*) from public.inquiries x where x.org_id = g.id),
        'walk-throughs', (select count(*) from public.appointments x where x.org_id = g.id and x.type = 'inspection')),
      'referrals', jsonb_build_object(
        'referred leads', (select count(*) from public.inquiries x where x.org_id = g.id and x.referred_by is not null)),
      'estimates', jsonb_build_object(
        'estimates', (select count(*) from public.quotes x where x.org_id = g.id),
        'work orders', (select count(*) from public.work_orders x where x.org_id = g.id),
        'change orders', (select count(*) from public.change_orders x where x.org_id = g.id)),
      'kits', jsonb_build_object(
        'kits', (select count(*) from public.kits x where x.org_id = g.id),
        'sized lines', (select count(*) from public.kit_items x where x.org_id = g.id and (x.qty_per_sqft is not null or x.qty_per_lf is not null))
                     + (select count(*) from public.price_list_items x where x.org_id = g.id
                          and (x.qty_per_sqft is not null or x.qty_per_lf is not null or x.sized_by is not null)),
        'catalog pricing', case when g.settings ->> 'estimating_mode' = 'catalog' then 1 else 0 end),
      'contracts', jsonb_build_object(
        'contracts', (select count(*) from public.contracts x where x.org_id = g.id),
        'payment schedules', (select count(*) from public.payment_milestones x where x.org_id = g.id),
        'lien records', (select count(*) from public.lien_records x where x.org_id = g.id),
        'insurance claims', (select count(*) from public.insurance_claims x where x.org_id = g.id)),
      'purchase_orders', jsonb_build_object(
        'purchase orders', (select count(*) from public.purchase_orders x where x.org_id = g.id),
        'bills on a PO', (select count(*) from public.bills x where x.org_id = g.id and x.po_id is not null)),
      'shop_stock', jsonb_build_object(
        'shelf items', (select count(*) from public.inventory_items x where x.org_id = g.id),
        'rolls', (select count(*) from public.stock_lots x where x.org_id = g.id),
        'stock moves', (select count(*) from public.stock_moves x where x.org_id = g.id),
        'shelf bills', (select count(*) from public.bills x where x.org_id = g.id and x.on_shelf),
        'stock lines', (select count(*) from public.bill_line_items x where x.org_id = g.id and x.is_stock)),
      'crew_payroll', jsonb_build_object(
        'crew', (select count(*) from public.profiles x where x.org_id = g.id and x.role <> 'owner'),
        'pay payments', (select count(*) from public.pay_payments x where x.org_id = g.id),
        'payroll runs', (select count(*) from public.payroll_runs x where x.org_id = g.id),
        'invitations', (select count(*) from public.invitations x where x.org_id = g.id),
        'employee papers', (select count(*) from public.employee_documents x where x.org_id = g.id),
        'shifts with miles', (select count(*) from public.time_entries x where x.org_id = g.id and x.miles > 0)),
      'daily_reports', jsonb_build_object(
        'daily reports', (select count(*) from public.daily_reports x where x.org_id = g.id)),
      'crew_board', jsonb_build_object(
        'crew days', (select count(*) from public.crew_day_assignments x where x.org_id = g.id)),
      'job_codes', jsonb_build_object(
        'coded clock-ins', (select count(*) from public.time_entries x where x.org_id = g.id and coalesce(trim(x.job_code), '') <> ''),
        'codes added later', (select count(*) from public.job_codes x where x.org_id = g.id and x.created_at > g.created_at + interval '1 day')),
      'permits', jsonb_build_object(
        'permits', (select count(*) from public.permits x where x.org_id = g.id),
        'final inspections', (select count(*) from public.appointments x where x.org_id = g.id and x.type = 'final_inspection')),
      'panel_map', jsonb_build_object(
        'circuits', (select count(*) from public.job_circuits x where x.org_id = g.id and x.removed_at is null),
        'panels', (select count(*) from public.job_panels x where x.org_id = g.id and x.removed_at is null),
        'estimates with circuits', (select count(*) from public.quotes x where x.org_id = g.id
                                     and jsonb_typeof(x.circuits) = 'array' and jsonb_array_length(x.circuits) > 0)),
      'customer_portal', jsonb_build_object(
        'portal sessions', (select count(*) from public.customer_portal_sessions x where x.org_id = g.id),
        'links opened', (select count(*) from public.customer_portal_access x where x.org_id = g.id and x.last_opened_at is not null),
        'shared documents', (select count(*) from public.job_shared_documents x where x.org_id = g.id)),
      'recurring_billing', jsonb_build_object(
        'repeat templates', (select count(*) from public.recurring_templates x where x.org_id = g.id)),
      'sales_tax', jsonb_build_object(
        'tax rates', (select count(*) from public.tax_rates x where x.org_id = g.id),
        'taxed invoices', (select count(*) from public.invoices x where x.org_id = g.id and x.tax > 0),
        'taxed estimates', (select count(*) from public.quotes x where x.org_id = g.id and x.tax > 0),
        'taxed repeat invoices', (select count(*) from public.recurring_templates x where x.org_id = g.id and x.tax_rate > 0),
        'default rate', case when g.default_tax_rate > 0 then 1 else 0 end),
      'licenses', jsonb_build_object(
        'licenses and policies', (select count(*) from public.compliance_items x where x.org_id = g.id)),
      'safety_log', jsonb_build_object(
        'safety records', (select count(*) from public.safety_records x where x.org_id = g.id),
        'filled-in forms', (select count(*) from public.form_submissions s join public.forms f on f.id = s.form_id
                             where s.org_id = g.id and not coalesce(f.is_inspection, false) and not coalesce(f.is_public_intake, false))),
      'website', jsonb_build_object(
        'site versions', (select count(*) from public.site_versions x where x.org_id = g.id),
        'site pages', (select count(*) from public.site_pages x where x.org_id = g.id),
        'articles', (select count(*) from public.site_posts x where x.org_id = g.id),
        'live site', case when coalesce(trim(g.settings ->> 'public_handle'), '') <> '' then 1 else 0 end),
      'site_chat', jsonb_build_object(
        'chat leads', (select count(*) from public.inquiries x where x.org_id = g.id and x.source = 'site_chat'),
        'live site', case when coalesce(trim(g.settings ->> 'public_handle'), '') <> '' then 1 else 0 end),
      'nort', jsonb_build_object(
        'conversations', (select count(*) from public.conversations c join public.profiles p on p.id = c.user_id where p.org_id = g.id)),
      'calculators', '{}'::jsonb,
      'todo_extras', jsonb_build_object(
        'subtasks, priorities or tags', (select count(*) from public.tasks x where x.org_id = g.id
                                          and (x.parent_id is not null or coalesce(x.priority, 0) <> 0 or coalesce(cardinality(x.tags), 0) > 0)))
    ) as c
  from orgs g
),
plan as (
  select g.id as org_id, g.name as org_name, g.trade, k.key, k.ord,
         ((select features from blank_preset) || coalesce((select t.features from trade_presets t where t.trade = g.trade), '{}'::jsonb)) ->> k.key = 'true' as by_trade,
         coalesce((select sum(v.value::text::numeric) from jsonb_each(c.c -> k.key) v), 0)::integer as n,
         (select string_agg(v.key || ' ' || v.value::text, ', ' order by v.key)
            from jsonb_each(c.c -> k.key) v where v.value::text::numeric > 0) as rows_said,
         k.key = 'job_codes' and (g.settings -> 'timeclock_job_codes') is not distinct from 'false'::jsonb as said_off
    from orgs g
    join counts c on c.id = g.id
    cross join lateral unnest(public.feature_keys()) with ordinality as k(key, ord)
)
select org_id, org_name, trade, key, ord,
       (by_trade or n > 0) and not said_off as feature_on,
       case
         when said_off then 'off: the company turned job codes off'
         when by_trade and n > 0 then coalesce(nullif(trade, ''), 'blank') || ' preset, and ' || rows_said
         when by_trade then coalesce(nullif(trade, ''), 'blank') || ' preset'
         when n > 0 then rows_said
         else 'off'
       end as reason
  from plan;
-- ▲ PLAN

-- The plan's map under whatever the company already stored (a stored switch wins; a stray
-- non-boolean value is replaced), the trade key, and the old Job Codes key mirroring its switch.
update public.organizations o
   set settings = coalesce(o.settings, '{}'::jsonb) || jsonb_build_object(
         'features', m.features,
         'trade', p.trade,
         'timeclock_job_codes', m.features -> 'job_codes')
  from (select org_id, max(trade) as trade, jsonb_object_agg(key, feature_on) as features
          from feature_backfill_plan group by org_id) p
  cross join lateral (
    select p.features || coalesce((
             select jsonb_object_agg(e.key, e.value)
               from jsonb_each(case when jsonb_typeof(o2.settings -> 'features') = 'object' then o2.settings -> 'features' else '{}'::jsonb end) e
              where e.key = any (public.feature_keys()) and jsonb_typeof(e.value) = 'boolean'), '{}'::jsonb) as features
      from public.organizations o2 where o2.id = p.org_id
  ) m
 where o.id = p.org_id;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
    from public.organizations o
   where jsonb_typeof(o.settings -> 'features') is distinct from 'object'
      or (select count(*) from jsonb_each(o.settings -> 'features') e
           where e.key = any (public.feature_keys()) and jsonb_typeof(e.value) = 'boolean') <> cardinality(public.feature_keys())
      or coalesce(o.settings ->> 'trade', '') !~ '^(|general|deck|electrical|plumbing|hvac|landscaping|roofing|concrete|tile|painting)$';
  if v_bad > 0 then
    raise exception '0355: % company(ies) did not end with a whole switch map and a known trade. Nothing was changed.', v_bad;
  end if;
  raise notice '0355: % company(ies) got their switches; every company now has a whole map.',
    (select count(distinct org_id) from feature_backfill_plan);
end $$;
