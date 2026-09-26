-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0346: a supplier bill can wait on a credit
--
-- Erik, 2026-09-26: CED billed 8802-1107139 ($59.17, 13683 HILLSIDE) for the replacement of a
-- faulty switch, and CED will take it back off with a credit memo for the same amount. The credit
-- hasn't arrived. Until it does the paper is not a job cost, not shop stock and not a business
-- cost, and every answer on its card would be wrong; left alone it sits on My Day and Needs You
-- asking a question nobody can answer yet.
--
-- "Waiting On A Credit" on the card records WHO said so and WHEN:
--
--   waiting_credit_since  timestamptz, null = not waiting. Set by a person's tap, never by the app.
--   waiting_credit_by     the profile id of who tapped it. A plain uuid, NOT a foreign key: a
--                         foreign key to profiles would lock profiles (share row exclusive) while
--                         it is added, and every sign-in writes profiles. The server action writes
--                         the signed-in staffer's own id; nothing else ever does.
--
-- The card then leaves My Day and Needs You and is listed on /bills as one folded line under its
-- supplier ("Waiting On A Credit (1)"), so nothing vanishes. It comes back BY ITSELF, saying "Still
-- no credit from CED after 30 days", when no credit memo on the same supplier account has paired
-- with it within 30 days. Once one does, the existing pairing (reversedPurchaseIds: a credit memo
-- for the same total, on the same account) already hides the paper, as it hides every return.
--
-- LOCKS: supplier_invoices only, for two nullable columns with no default (a catalog-only change:
-- no rewrite, no scan). No other table is touched. lock_timeout 3s: a busy table fails fast and
-- changes nothing rather than queueing writers behind it; run it again.
--
-- UNCHANGED: RLS. supplier_invoices is staff-only for every verb (0273, <t>_staff_all), so a tech can
-- neither set nor read these; the server action adds requireStaff and the org filter on top.
--
-- ORDER: any time after 0273. Safe before or after the code: the page reads these columns and
-- retries without them, and the button says "Waiting On A Credit needs one database update" until
-- this is applied. Additive only. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.supplier_invoices') is null then
    raise exception '0346: supplier_invoices (0273) is not on this database. Apply 0273 first. Nothing was changed.';
  end if;
end $$;

alter table public.supplier_invoices
  add column if not exists waiting_credit_since timestamptz,
  add column if not exists waiting_credit_by uuid;

comment on column public.supplier_invoices.waiting_credit_since is
  'When a person said this supplier bill waits on a credit memo for the same amount (0346). NULL = not waiting. The card comes back after 30 days with no pairing credit.';
comment on column public.supplier_invoices.waiting_credit_by is
  'The profile id of who said this supplier bill waits on a credit (0346). Written only by the staff-only server action, as the signed-in user.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'supplier_invoices'
         and ((column_name = 'waiting_credit_since' and data_type = 'timestamp with time zone' and is_nullable = 'YES')
           or (column_name = 'waiting_credit_by' and data_type = 'uuid' and is_nullable = 'YES'))) <> 2 then
    raise exception '0346: supplier_invoices is missing waiting_credit_since / waiting_credit_by as nullable columns. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'supplier_invoices' and c.relrowsecurity
  ) then
    raise exception '0346: supplier_invoices has row level security switched off. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'supplier_invoices' and policyname = 'supplier_invoices_staff_all'
  ) then
    raise exception '0346: supplier_invoices lost its staff-only policy (0273). Nothing was changed.';
  end if;
  raise notice '0346: a supplier bill can wait on a credit.';
end $$;
