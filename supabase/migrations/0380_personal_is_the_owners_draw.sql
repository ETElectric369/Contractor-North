-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0380: Personal is the Owner's Draw
--
-- Erik, 2026-10-04, having looked at the two buttons side by side on a bank line: "merge them,
-- anything thats not business is therefore taken out of the owners draw, simple."
--
-- HE IS RIGHT, AND THE SECOND WORD WAS A HOLE IN THE BOOKS. 'draw' and 'personal' were the same
-- answer in every respect but one. Both are money OUT only. Neither writes a row — the bank line IS
-- the record, as it is for Cash Taken Out. Neither is a business cost. Both could be learned as a
-- rule. The one difference:
--
--   · 'draw'     is read back by owner-money.ts and lands on the profit and loss as EQUITY below
--                Net Profit, and in the accountant's download.
--   · 'personal' was read by NOTHING. Its only appearance anywhere was one slice on the breakdown
--                bar of the download card that sorted it (flowLabelOf, used nowhere outside its own
--                file). So a dentist filed that way showed once, on that card, and then left the
--                books entirely: not a cost (right), not a draw (wrong), on no statement at all.
--                THE OWNER'S DRAW LINE READ LOW BY EXACTLY THE SUM OF EVERY PERSONAL LINE.
--
-- Which is also the accounting truth: a dollar that leaves the business account and is not a
-- business cost has nowhere else to be. And money paid back is already answered — 'owner_in' (0376)
-- is money IN from the owner, and it nets against the draw — so a second word for "mine, not the
-- company's" was never needed in the first place.
--
-- NOTHING IS MOVED, BECAUSE NOTHING WAS EVER STORED. Checked before writing this: zero rows in
-- bank_lines and zero in bank_rules, across all three companies. Erik had deliberately not applied
-- his download yet ("i havent applied anything yet just for that reason"), which is the whole reason
-- this is a retirement and not a backfill. Done a week from now, every Personal row would have had
-- to be read back as a draw for ever, the way 'petty_cash' is still read back as Cash Taken Out.
--
-- THE GUARD BELOW IS NOT CEREMONY. If any company anywhere does hold a 'personal' row, this file
-- refuses and changes nothing, rather than deleting it or leaving a row the new CHECK forbids. A
-- person decides what happens to money; a migration does not.
--
-- THE APP SIDE SHIPS IN THE SAME RELEASE: one button where there were two, labelled Owner's Draw.
-- parseChoiceId still ACCEPTS the retired word and returns the draw, so a card drawn before the
-- merge and pressed after still applies instead of dead-ending — it is written as 'draw', which is
-- why this CHECK can forbid the old word outright.
--
-- WHAT THIS WRITES: the live word lists, each minus 'personal', and nothing else.
--
--   bank_lines: matched, cost, draw, petty_cash, not_cost, supplier, crew, invoice, other_income,
--               not_income, job, owner_in
--   bank_rules: cost, draw, petty_cash, not_cost, supplier, crew, other_income, not_income, owner_in
--
-- TAKEN FROM THE LIVE CATALOG, NOT FROM 0363 WHERE THEY WERE FIRST WRITTEN. 0375 added 'job' and
-- 0376 added 'owner_in' in between, and 0377 exists because I once rebuilt a constraint from the
-- migration that created it and silently undid a later one. The verification at the bottom names
-- every surviving word, so this file cannot narrow the vocabulary by more than the one word it means
-- to remove.
--
-- LOCKS: one CHECK swapped on each of two empty tables. ACCESS EXCLUSIVE for a moment; adding the
-- CHECK validates, which on zero rows is free. lock_timeout 15s (3s lost the race in 0379 and
-- changed nothing, which is the point). ORDER: after 0379. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '15s';
set local statement_timeout = '60s';

-- ── NOTHING IS DELETED TO MAKE ROOM ─────────────────────────────────────────────────────────────
do $$
declare bad_lines int; bad_rules int;
begin
  if to_regclass('public.bank_lines') is null or to_regclass('public.bank_rules') is null then
    raise exception '0380: bank_lines or bank_rules is not on this database. Nothing was changed.';
  end if;
  select count(*) into bad_lines from public.bank_lines where choice = 'personal';
  select count(*) into bad_rules from public.bank_rules where choice = 'personal';
  if bad_lines > 0 or bad_rules > 0 then
    raise exception '0380: % bank line(s) and % rule(s) are filed as Personal. They are the owner''s draw, but a migration does not move money: look at them, re-sort them as Owner''s Draw, then run this again. Nothing was changed.', bad_lines, bad_rules;
  end if;
end $$;

-- ── ONE WORD FOR WHAT THE OWNER TOOK OUT ────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_choice_is_known'
       and pg_get_constraintdef(oid) like '%''personal''%'
  ) then
    alter table public.bank_lines drop constraint bank_lines_choice_is_known;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_choice_is_known') then
    alter table public.bank_lines
      add constraint bank_lines_choice_is_known
        check (choice in ('matched', 'cost', 'draw', 'petty_cash', 'not_cost', 'supplier', 'crew', 'invoice', 'other_income', 'not_income', 'job', 'owner_in'));
  end if;

  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_choice_is_known'
       and pg_get_constraintdef(oid) like '%''personal''%'
  ) then
    alter table public.bank_rules drop constraint bank_rules_choice_is_known;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_choice_is_known') then
    alter table public.bank_rules
      add constraint bank_rules_choice_is_known
        check (choice in ('cost', 'draw', 'petty_cash', 'not_cost', 'supplier', 'crew', 'other_income', 'not_income', 'owner_in'));
  end if;
end $$;

-- ── WHAT MUST BE TRUE NOW ───────────────────────────────────────────────────────────────────────
-- Both halves: the one word is gone, and EVERY OTHER WORD IS STILL THERE. 0377's lesson — a
-- constraint rewritten from anywhere but the live catalog quietly drops whatever was added since.
do $$
declare def text; w text;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_choice_is_known';
  if def is null then
    raise exception '0380: bank_lines no longer says which answers it knows. Nothing was changed.';
  end if;
  if def like '%''personal''%' then
    raise exception '0380: bank_lines still allows Personal. Nothing was changed.';
  end if;
  foreach w in array array['matched', 'cost', 'draw', 'petty_cash', 'not_cost', 'supplier', 'crew', 'invoice', 'other_income', 'not_income', 'job', 'owner_in'] loop
    if def not like '%''' || w || '''%' then
      raise exception '0380: bank_lines lost the answer %. Nothing was changed.', w;
    end if;
  end loop;

  select pg_get_constraintdef(oid) into def
    from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_choice_is_known';
  if def is null then
    raise exception '0380: bank_rules no longer says which answers it knows. Nothing was changed.';
  end if;
  if def like '%''personal''%' then
    raise exception '0380: bank_rules still allows Personal. Nothing was changed.';
  end if;
  foreach w in array array['cost', 'draw', 'petty_cash', 'not_cost', 'supplier', 'crew', 'other_income', 'not_income', 'owner_in'] loop
    if def not like '%''' || w || '''%' then
      raise exception '0380: bank_rules lost the answer %. Nothing was changed.', w;
    end if;
  end loop;

  -- 0376 and 0377's work, both still standing.
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass
      and conname = 'bank_rules_income_is_in' and pg_get_constraintdef(oid) like '%<> ''other_income''%'
  ) then
    raise exception '0380: 0377''s rule is gone — a rule could be Other Income again. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.bank_lines'::regclass
      and conname = 'bank_lines_bucket_is_known' and pg_get_constraintdef(oid) like '%''Rent''%'
  ) then
    raise exception '0380: 0376''s Rent bucket is gone from bank_lines. Nothing was changed.';
  end if;
  raise notice '0380: Personal is the Owner''s Draw.';
end $$;
