-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0351: a supplier account remembers its open-list columns
--
-- Erik, 2026-09-26: a supplier's own open list (a statement, the portal's Open tab download, a
-- pasted table) is dropped where he already drops paper, and one engine reconciles it against that
-- supplier's papers (src/lib/supplier-open-list.ts). Columns are found by the words in their
-- headers. A list whose headers say nothing the engine knows asks a person once, with a small
-- column picker, and the answer is kept HERE, on that supplier's account, so the next list from the
-- same supplier just reads. Any supplier, any org: nothing in the app names one.
--
--   open_list_columns  jsonb, null = never asked. { byHeader: {field: "header words"},
--                      byIndex: {field: column}, width: n }. Written only by the staff-only
--                      server action (requireStaff + org filter), after a person chose.
--
-- LOCKS: supplier_accounts only, one nullable column with no default (catalog-only: no rewrite,
-- no scan). lock_timeout 3s: a busy table fails fast and changes nothing; run it again.
--
-- UNCHANGED: RLS. supplier_accounts is staff-only for every verb (0270, <t>_staff_all).
--
-- ORDER: any time after 0270. Safe before or after the code: the page reads the account with `*`,
-- and until this is applied a person's column choice still reads the list; it just isn't
-- remembered, and the card says so. Additive only. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.supplier_accounts') is null then
    raise exception '0351: supplier_accounts (0270) is not on this database. Apply 0270 first. Nothing was changed.';
  end if;
end $$;

alter table public.supplier_accounts
  add column if not exists open_list_columns jsonb;

comment on column public.supplier_accounts.open_list_columns is
  'Which columns of this supplier''s open list hold which fields, as a person chose them once (0351). NULL = never asked; the header words are enough.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'supplier_accounts'
       and column_name = 'open_list_columns' and data_type = 'jsonb' and is_nullable = 'YES'
  ) then
    raise exception '0351: supplier_accounts.open_list_columns is missing or not nullable jsonb. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'supplier_accounts' and c.relrowsecurity
  ) then
    raise exception '0351: supplier_accounts has row level security switched off. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'supplier_accounts' and policyname = 'supplier_accounts_staff_all'
  ) then
    raise exception '0351: supplier_accounts lost its staff-only policy (0270). Nothing was changed.';
  end if;
  raise notice '0351: a supplier account remembers its open-list columns.';
end $$;
