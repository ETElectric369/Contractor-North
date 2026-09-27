-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0365: bank answers are asked, not assumed
--
-- The review of the bank door (0363, Erik 2026-09-27 "yes go for those") found places where one
-- tap was remembered too widely. This tightens 0363's tables; it changes no row of any other table.
--
--   OTHER INCOME IS NEVER A RULE'S. A rule on money in may only say Not Income. A rule that said
--   Other Income for "REGULAR DEPOSIT", "VENMO" or "ZELLE" (words that say how money came, never
--   whose it was) filed the next customer payment as income without asking: added to Received,
--   the invoice left open, and counted twice the day the payment was recorded. The app never
--   writes one now; this CHECK holds the database to it.
--
-- LOCKS: bank_rules only (0363's own table, staff-only, a few rows per company at most): one CHECK
-- swapped. lock_timeout 3s: a busy table fails fast and changes nothing. Run it again.
--
-- ORDER: after 0363. Safe before or after the code (the code never writes what this refuses).
-- A company that already holds an Other Income rule (none can yet: 0363 is new) loses it here,
-- and that merchant is asked again. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.bank_rules') is null then
    raise exception '0365: bank_rules is not on this database. Apply 0363 first. Nothing was changed.';
  end if;
end $$;

-- ── Money in: a rule may only say Not Income ────────────────────────────────────────────────────
delete from public.bank_rules where choice = 'other_income';

alter table public.bank_rules drop constraint if exists bank_rules_income_is_in;
alter table public.bank_rules add constraint bank_rules_income_is_in check (choice <> 'other_income' and (direction = 'in') = (choice = 'not_income'));

comment on table public.bank_rules is
  'A company''s own answer for a merchant on its bank downloads (0363, 0365), written only when a person taps it: one per company + direction + merchant key. Money in only ever says Not Income. Never shared between companies. Staff only.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_income_is_in'
       and pg_get_constraintdef(oid) like '%not_income%' and pg_get_constraintdef(oid) like '%<> ''other_income''%'
  ) then
    raise exception '0365: bank_rules still lets money in be Other Income. Nothing was changed.';
  end if;
  raise notice '0365: bank answers are asked, not assumed.';
end $$;
