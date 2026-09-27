-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0354: any company, any supplier (Wave 0 fixes)
--
-- The one-company sweep of 2026-09-26 found the database still speaking for one company and one
-- supplier. Erik's law: every feature works for ANY company and ANY supplier; ET Electric and CED
-- are the test fixture, never the rule. Six small changes, each the smallest that does the job:
--
--   1. THE JUNE 8 LINE IS ET'S OWN SETTING. The code drew ET's line from a constant keyed to ET's
--      org id (the only org id in the app's logic). It now reads organizations.settings.books_begin,
--      per company, changed from /bills. This stores ET's day, 2026-06-08, once: with 1b, the only
--      place ET's id appears. Written only when ET has not named a day already (never overwrites one).
--
--   1b. THE TAGLINE UNDER A COMPANY'S NAME IS ITS OWN SETTING. "Service · Integrity · Reliability"
--      was a constant, so it printed under every company's name on every invoice and estimate; it
--      is now organizations.settings.doc_style.tagline, set in Document Studio (doc_style already
--      rides the public /i and /q projections as one whitelisted key, so no projection changes).
--      This stores ET's own words once, beside its June 8 line: only when ET has no tagline yet,
--      and every other doc_style key (margins, density, closing lines) is kept as it is.
--
--   2. A SUPPLIER'S PAPER IS UNIQUE PER SUPPLIER ACCOUNT. supplier_invoices was unique on
--      (org_id, invoice_number), so a second supplier printing a number already on file (a bare
--      10-digit number, say) could not be stored at all. The constraint becomes a unique index on
--      (org_id, coalesce(supplier_account_id, zero uuid), invoice_number): one paper per number
--      per account, and still one per number among papers on no account. The importer reads what
--      is on file per account in the same release: a paper on a matched account is that account's
--      row (or adopts a row on no account); a paper that matches no account is the ONE row with its
--      number on any account (two or more: none is assumed). Prod has no duplicate numbers (checked).
--
--   3. THE SHELF CREDIT GUARD NAMES A DOOR THAT EXISTS. guard_shelf_credit_bill (0350) said
--      "(Return To CED on Shop Stock)"; for any other supplier that button reads "Return To
--      <their name>". Redefined FROM THE LIVE BODY (pg_get_functiondef on production, 2026-09-26,
--      identical to 0350's), with only the two messages changed to "(the return on Shop Stock)".
--
--   4. A PURCHASE ORDER DEFAULTS TO NO VENDOR. purchase_orders.vendor was `default 'CED'` (0002),
--      so a deck builder's PO named an electrical distributor. Default ''. Existing rows unchanged.
--
--   5. A PLATFORM ADMIN MARKS ANY COMPANY'S BUG REPORT. Bug reports left the companies' inboxes
--      (Wave 0): only North's own team (platform_admins, 0176) triages them. 0176's WITH CHECK keeps
--      a direct write in the admin's own org, so Mark Fixed on another company's report was refused
--      by RLS. platform_set_bug_status(id, status) is the one narrow hole: SECURITY DEFINER, the
--      status column only, the three statuses the app writes, platform admins only (checked inside).
--
-- LOCKS: supplier_invoices (drop constraint + index build: ACCESS EXCLUSIVE, 51 rows on prod, well
-- under a second), bills (trigger function body only, CREATE OR REPLACE FUNCTION takes no table
-- lock), purchase_orders (ALTER COLUMN SET DEFAULT: catalog only), organizations (one row).
-- lock_timeout 3s: a busy table fails fast and changes nothing; run it again.
--
-- ORDER: after 0350 (the guard) and 0273 (supplier_invoices). Independent of 0352/0353.
-- SAFE BEFORE AND AFTER THE CODE: the code reads books_begin with the earliest bill as fallback, the
-- tagline as blank, and Mark Fixed falls back to the old direct write when platform_set_bug_status
-- is missing. Deploy notes: until this runs, ET's line falls back to its first bill (2026-04-20), so
-- its four pre-June-8 CED papers show as cards, and ET's documents print no tagline. The importer's
-- per-account read is NOT the same under both uniquenesses: until this runs, a paper on a matched
-- account whose number is already on file under ANOTHER account is refused whole by the old
-- (org_id, invoice_number) constraint, and every retry is refused the same way (nothing is written);
-- after it runs, that paper goes on file as its own account's.
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.supplier_invoices') is null or to_regclass('public.stock_moves') is null
     or to_regclass('public.platform_admins') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0354: supplier_invoices (0273), the shelf (0303/0350) or platform_admins (0176) is not on this database. Apply them first. Nothing was changed.';
  end if;
  if exists (
    select 1 from public.supplier_invoices
     group by org_id, coalesce(supplier_account_id, '00000000-0000-0000-0000-000000000000'::uuid), invoice_number
    having count(*) > 1
  ) then
    raise exception '0354: two supplier papers share an account and a number already; the new unique index cannot be built. Nothing was changed.';
  end if;
end $$;

-- ── 1. ET's books begin on June 8 (its own setting now) ─────────────────────────────────────────
update public.organizations
   set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{books_begin}', '"2026-06-08"'::jsonb, true)
 where id = '60195593-2e18-4230-bc8e-7a32d36d038d'
   and coalesce(settings ->> 'books_begin', '') = '';

-- ── 1b. ET's tagline under its name (its own setting now) ────────────────────────────────────────
-- doc_style is created when missing (or not an object); every key already in it is kept.
update public.organizations
   set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb),
         '{doc_style}',
         (case when jsonb_typeof(settings -> 'doc_style') = 'object' then settings -> 'doc_style' else '{}'::jsonb end)
           || jsonb_build_object('tagline', 'Service · Integrity · Reliability'),
         true)
 where id = '60195593-2e18-4230-bc8e-7a32d36d038d'
   and coalesce(btrim(settings #>> '{doc_style,tagline}'), '') = '';

-- ── 2. one paper per number per supplier account ────────────────────────────────────────────────
create unique index if not exists supplier_invoices_org_account_number_key
  on public.supplier_invoices (org_id, coalesce(supplier_account_id, '00000000-0000-0000-0000-000000000000'::uuid), invoice_number);
alter table public.supplier_invoices drop constraint if exists supplier_invoices_org_id_invoice_number_key;

-- ── 3. the shelf credit guard, from the LIVE body; only the two messages changed ────────────────
create or replace function public.guard_shelf_credit_bill()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n integer;
begin
  select count(*)::integer into v_n
    from public.stock_moves m
   where m.credit_bill_id = old.id and m.kind = 'supplier_return' and m.undone_at is null;
  if v_n = 0 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This credit is tied to pieces returned from the shelf (the return on Shop Stock). Undo that return first, then delete the credit.'
      using errcode = 'P0001';
  end if;
  if new.job_id is not null or new.on_shelf is not true or not (new.amount < 0)
     or new.superseded_by_bill_id is not null or new.org_id is distinct from old.org_id then
    raise exception 'This credit is tied to pieces returned from the shelf (the return on Shop Stock), so it stays a credit on the shelf. Undo that return first, then change it.'
      using errcode = 'P0001';
  end if;
  return new;
end $function$;
revoke execute on function public.guard_shelf_credit_bill() from public, anon, authenticated;

-- ── 4. a purchase order names no supplier until a person does ───────────────────────────────────
alter table public.purchase_orders alter column vendor set default '';

-- ── 5. a platform admin marks any company's bug report ──────────────────────────────────────────
create or replace function public.platform_set_bug_status(p_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not public.is_platform_admin() then
    raise exception 'Only North''s own team can mark a bug report.' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('open', 'fixed', 'wontfix') then
    raise exception 'That isn''t a bug report status.' using errcode = '22023';
  end if;
  update public.bug_reports set status = p_status where id = p_id;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

comment on function public.platform_set_bug_status(uuid, text) is
  'Bug Watch''s Mark Fixed / Won''t Fix / Reopen for North''s own team, on ANY company''s report (0354). Status only; platform admins only (is_platform_admin, 0176), checked inside. Returns true when the report was there.';

revoke execute on function public.platform_set_bug_status(uuid, text) from public, anon;
grant execute on function public.platform_set_bug_status(uuid, text) to authenticated;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare v_def text;
begin
  if exists (select 1 from public.organizations where id = '60195593-2e18-4230-bc8e-7a32d36d038d')
     and not exists (
       select 1 from public.organizations
        where id = '60195593-2e18-4230-bc8e-7a32d36d038d' and settings ->> 'books_begin' ~ '^\d{4}-\d{2}-\d{2}$'
     ) then
    raise exception '0354: ET''s books_begin is not a day after the migration.';
  end if;
  if exists (
       select 1 from public.organizations
        where id = '60195593-2e18-4230-bc8e-7a32d36d038d' and coalesce(btrim(settings #>> '{doc_style,tagline}'), '') = ''
     ) then
    raise exception '0354: ET''s document tagline is blank after the migration.';
  end if;
  if exists (select 1 from pg_constraint where conname = 'supplier_invoices_org_id_invoice_number_key') then
    raise exception '0354: the per-org unique constraint on supplier_invoices is still there.';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'supplier_invoices' and indexname = 'supplier_invoices_org_account_number_key'
       and indexdef ilike 'create unique index%coalesce(supplier_account_id%invoice_number%'
  ) then
    raise exception '0354: the per-account unique index on supplier_invoices is missing.';
  end if;
  v_def := pg_get_functiondef('public.guard_shelf_credit_bill()'::regprocedure);
  if v_def ilike '%Return To CED%' or v_def not ilike '%(the return on Shop Stock)%' then
    raise exception '0354: guard_shelf_credit_bill still names Return To CED.';
  end if;
  if not exists (
    select 1 from pg_trigger where not tgisinternal and tgname = 'guard_shelf_credit_bill' and tgrelid = 'public.bills'::regclass
  ) then
    raise exception '0354: the guard_shelf_credit_bill trigger is not on bills.';
  end if;
  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'purchase_orders' and column_name = 'vendor') is distinct from '''''::text' then
    raise exception '0354: purchase_orders.vendor does not default to an empty string.';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.platform_set_bug_status(uuid, text)'::regprocedure) then
    raise exception '0354: platform_set_bug_status is not SECURITY DEFINER.';
  end if;
  if has_function_privilege('anon', 'public.platform_set_bug_status(uuid, text)', 'execute') then
    raise exception '0354: anon can call platform_set_bug_status.';
  end if;
  if not has_function_privilege('authenticated', 'public.platform_set_bug_status(uuid, text)', 'execute') then
    raise exception '0354: a signed-in user cannot reach platform_set_bug_status (it checks the admin inside).';
  end if;
  raise notice '0354: books_begin and the document tagline are per company (ET: 2026-06-08, its own tagline), supplier papers are unique per account, the shelf guard names no supplier, POs default to no vendor, and platform admins can mark any bug report.';
end $$;
