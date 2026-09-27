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
--   A RULE IS FOR THE AMOUNTS IT WAS ANSWERED FOR. One merchant can take two answers: at a
--   general store a fill-up-sized charge is Fuel and a coffee-sized one is Other (Erik's own
--   ruling). One rule per merchant, the first answer kept forever, filed every later line of that
--   merchant the same way without asking. Now:
--     bank_rules.min_cents / max_cents   the amounts (cents, positive) the answer was given for;
--                                        the app places a line from half the smallest to twice
--                                        the largest, and asks (the nearest answer as its guess)
--                                        outside every band. NULL = every amount.
--     bank_rules.answer                  the answer as one word, the app's choice id
--                                        ("cost:Gas & Truck:fuel", "crew:<id>"), generated from the
--                                        columns it names.
--     UNIQUE (org_id, direction, merchant_key, answer)   one rule per merchant AND answer, in
--                                        place of one per merchant.
--
-- LOCKS: bank_rules only (0363's own table, staff-only, a few rows per company at most): one CHECK
-- swapped, two nullable columns, one generated column (a rewrite of a table this small is
-- nothing), one UNIQUE swapped. lock_timeout 3s: a busy table fails fast and changes nothing. Run
-- it again.
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

-- ── The amounts a rule is for, and one rule per merchant AND answer ────────────────────────────
alter table public.bank_rules add column if not exists min_cents integer;
alter table public.bank_rules add column if not exists max_cents integer;
alter table public.bank_rules drop constraint if exists bank_rules_band;
alter table public.bank_rules add constraint bank_rules_band
  check ((min_cents is null) = (max_cents is null) and (min_cents is null or (min_cents > 0 and max_cents >= min_cents)));
alter table public.bank_rules add column if not exists answer text generated always as (
  choice || coalesce(':' || bucket, '') || coalesce(':' || cost_kind, '') || coalesce(':' || supplier_account_id::text, '') || coalesce(':' || profile_id::text, '')
) stored;
alter table public.bank_rules drop constraint if exists bank_rules_one_per_key;
alter table public.bank_rules drop constraint if exists bank_rules_one_per_answer;
alter table public.bank_rules add constraint bank_rules_one_per_answer unique (org_id, direction, merchant_key, answer);

comment on column public.bank_rules.min_cents is 'The smallest amount (cents, positive) this answer was given for (0365). The app places a line from half of it; NULL = every amount.';
comment on column public.bank_rules.max_cents is 'The largest amount (cents, positive) this answer was given for (0365). The app places a line up to twice it; NULL = every amount.';
comment on column public.bank_rules.answer is 'The answer as one word, the app''s choice id (0365): one rule per merchant and answer.';

comment on table public.bank_rules is
  'A company''s own answer for a merchant on its bank downloads (0363, 0365), written only when a person taps it: one per company + direction + merchant key + answer, for the amounts it was answered for (min_cents..max_cents). Money in only ever says Not Income. Never shared between companies. Staff only.';

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
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_one_per_answer' and contype = 'u') then
    raise exception '0365: bank_rules is missing its one-rule-per-merchant-and-answer key. Nothing was changed.';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_one_per_key') then
    raise exception '0365: bank_rules still holds one rule per merchant. Nothing was changed.';
  end if;
  raise notice '0365: bank answers are asked, not assumed.';
end $$;
