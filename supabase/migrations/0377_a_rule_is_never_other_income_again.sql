-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0377: a rule is never Other Income, again
--
-- THIS REPAIRS A MISTAKE I MADE IN 0376, SIX HOURS EARLIER, AND THE MISTAKE IS WORTH WRITING DOWN
-- BECAUSE IT WILL BE MADE AGAIN OTHERWISE.
--
-- 0376 needed bank_rules_income_is_in to learn one new word ('owner_in'). To rewrite a constraint
-- you must first know what it says. I took its text from 0363, WHERE IT WAS FIRST WRITTEN, instead
-- of from the live catalog — and 0365 had narrowed it in between:
--
--   0363:  check ((direction = 'in') = (choice in ('other_income', 'not_income')))
--   0365:  check (choice <> 'other_income' and (direction = 'in') = (choice = 'not_income'))
--   0376:  check ((direction = 'in') = (choice in ('other_income', 'not_income', 'owner_in')))   ← MINE
--
-- So 0376 silently undid 0365. 0365 exists for a reason it states plainly — "Money in: a rule may
-- only say Not Income" — and it DELETED every other_income rule on its way through. A rule is the
-- thing the app applies to a merchant for ever after without asking again. "Every deposit from this
-- merchant is Other Income" is therefore a standing instruction to book revenue nobody looked at,
-- which is the one answer on the money-in side that must never be learned.
--
-- WHAT CAUGHT IT: not me. bank-lines.integration.test.ts asserts the DATABASE refuses that insert,
-- CI ran it against the test database, and it failed within minutes of the deploy. A constraint is
-- a boundary and not a convention, and this is what having a test at the boundary buys.
--
-- THE APP WAS NOT EXPLOITING THE HOLE. learnableAnswer only ever offers Not Income for money in, so
-- no such rule could be written through the app in the hours it was open, and none exists (the
-- check below proves it rather than assuming it). That is luck, not design: the whole point of the
-- CHECK is to hold when the app is wrong.
--
-- WHAT THIS WRITES, which is 0365's rule with 0376's word added where it belongs:
--
--   check (choice <> 'other_income' and (direction = 'in') = (choice in ('not_income', 'owner_in')))
--
-- A money-IN rule may be Not Income or the owner's own money going in. Other Income may not be a
-- rule in either direction. Money OUT is unchanged.
--
-- LOCKS: one CHECK swapped on bank_rules, for a narrower one every existing row already satisfies
-- (proved first, and the migration refuses rather than deletes if it does not). ACCESS EXCLUSIVE for
-- a moment. lock_timeout 3s: a busy table fails fast and changes nothing. Run it again.
--
-- ORDER: after 0376. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- ── NOTHING IS DELETED TO MAKE ROOM ─────────────────────────────────────────────────────────────
-- 0365 deleted other_income rules because it was narrowing a live book. This file must not: if one
-- exists it was written in the hours 0376's hole was open, and that is something a person should
-- see, not something a migration should quietly remove.
do $$
declare bad int;
begin
  if to_regclass('public.bank_rules') is null then
    raise exception '0377: bank_rules is not on this database. Nothing was changed.';
  end if;
  select count(*) into bad from public.bank_rules
   where choice = 'other_income' or (direction = 'in') <> (choice in ('not_income', 'owner_in'));
  if bad > 0 then
    raise exception '0377: % bank_rules row(s) break the rule this restores. They were written while 0376''s hole was open. Look at them and decide; nothing was changed.', bad;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_income_is_in'
       and pg_get_constraintdef(oid) not like '%<> ''other_income''%'
  ) then
    alter table public.bank_rules drop constraint bank_rules_income_is_in;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_income_is_in') then
    alter table public.bank_rules
      add constraint bank_rules_income_is_in
        check (choice <> 'other_income' and (direction = 'in') = (choice in ('not_income', 'owner_in')));
  end if;
end $$;

-- ── WHAT MUST BE TRUE NOW ───────────────────────────────────────────────────────────────────────
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_income_is_in';
  if def is null then
    raise exception '0377: bank_rules has no income rule at all. Nothing was changed.';
  end if;
  -- 0365's own self-check, word for word, so this file can never be called done while that is false.
  if def not like '%<> ''other_income''%' then
    raise exception '0377: bank_rules still lets a rule be Other Income. Nothing was changed.';
  end if;
  if def not like '%''owner_in''%' then
    raise exception '0377: a money-in rule still cannot be the owner''s money going in. Nothing was changed.';
  end if;
  if def not like '%''not_income''%' then
    raise exception '0377: a money-in rule can no longer be Not Income. Nothing was changed.';
  end if;
  -- And 0376's other work must be untouched.
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass
      and conname = 'bank_rules_bucket_is_known' and pg_get_constraintdef(oid) like '%''Rent''%'
  ) then
    raise exception '0377: 0376''s Rent bucket is gone from bank_rules. Nothing was changed.';
  end if;
  raise notice '0377: a rule is never Other Income, again.';
end $$;
