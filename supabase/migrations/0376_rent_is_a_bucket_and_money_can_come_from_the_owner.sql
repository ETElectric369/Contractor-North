-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0376: rent is a bucket, and money can come from the owner
--
-- Both of these came out of Erik sorting his FIRST bank download, 2026-10-02.
--
-- ── 1. RENT ──────────────────────────────────────────────────────────────────────────────────────
-- A $1,120 check: "the 1120 was to catch up on rent for my storage unit/home base in truckee i
-- havent even told you about". The seven business buckets were Fuel, Auto, Tools & Supplies,
-- Phone & Office, Insurance & Licenses, Fees, Other — so rent could only be filed as "Other", and
-- his profit and loss could not say the word. For most trade businesses the shop, the yard or the
-- unit is one of the largest overhead lines there is, so "Other" is not a rounding error, it is the
-- line he most wants to see. Rent keeps running whether there is work on or not, so it is OVERHEAD
-- (the app's own test, in business-cost-buckets.ts).
--
-- ── 2. MONEY FROM THE OWNER ──────────────────────────────────────────────────────────────────────
-- Money OUT to the owner has been 'draw' since 0363, and 2026-10-01 settled where it belongs: not an
-- expense, not subtracted, an equity line BELOW Net Profit ("an actual draw from the owner is
-- considered equity and should be a line item below net profit stating what Ive taken out this
-- month"). Money IN from the owner is the same line in the other direction and had no word at all:
-- the only money-in answers were an invoice, Other Income, and Already Counted. Calling the owner's
-- own money "Other Income" overstates revenue and net profit by every cent of it.
--
-- WHY IT IS A RULE WORD TOO, unlike 'job' in 0375. A job is per LINE and never true of a merchant.
-- But "a transfer from my own other account is money I put in" IS true of that merchant every time,
-- so bank_rules may learn it. That means bank_rules_income_is_in — the rule that a money-IN rule
-- carries a money-in answer and nothing else — has to learn the third word, or every such rule is
-- refused at the door.
--
-- WHAT THIS DOES NOT DECIDE: whether a particular deposit IS the owner's money. Erik's own first
-- case looked like a contribution and was not — it was customers paying his Venmo, already recorded
-- against their invoices, so the right answer was Already Counted. The word exists for when it is
-- genuinely his own money going in; the app still asks.
--
-- LOCKS: two CHECKs swapped on bank_lines and two on bank_rules, each for a wider list that every
-- existing row already satisfies. ACCESS EXCLUSIVE on each table for a moment. lock_timeout 3s: a
-- busy table fails fast and changes nothing. Run it again.
--
-- ORDER: after 0363 (the tables) and 0375 (the job answer). Additive only. Safe to re-run. Safe
-- before or after the code: until the code offers them, nothing writes either word.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.bank_lines') is null or to_regclass('public.bank_rules') is null then
    raise exception '0376: bank_lines or bank_rules is not on this database. Run 0363 first. Nothing was changed.';
  end if;
end $$;

-- ── THE BUCKET LIST, ON BOTH TABLES ─────────────────────────────────────────────────────────────
-- 0363 wrote these inline, so Postgres named them. Find them by what they SAY, not by a name this
-- file does not get to choose, and give the replacements names of our own.
do $$
declare c record;
begin
  for c in
    select t.tbl, c2.conname
      from (values ('public.bank_lines'::regclass, 'bank_lines'), ('public.bank_rules'::regclass, 'bank_rules')) as t(rel, tbl)
      join pg_constraint c2 on c2.conrelid = t.rel and c2.contype = 'c'
     where pg_get_constraintdef(c2.oid) like '%Insurance & Licenses%'
       and pg_get_constraintdef(c2.oid) not like '%''Rent''%'
  loop
    execute format('alter table public.%I drop constraint %I', c.tbl, c.conname);
    raise notice '0376: dropped the old bucket list on % (%).', c.tbl, c.conname;
  end loop;

  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_bucket_is_known') then
    alter table public.bank_lines
      add constraint bank_lines_bucket_is_known check (bucket is null or bucket in (
        'Fuel', 'Auto', 'Tools & Supplies', 'Phone & Office', 'Insurance & Licenses', 'Fees', 'Rent', 'Other'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_bucket_is_known') then
    alter table public.bank_rules
      add constraint bank_rules_bucket_is_known check (bucket is null or bucket in (
        'Fuel', 'Auto', 'Tools & Supplies', 'Phone & Office', 'Insurance & Licenses', 'Fees', 'Rent', 'Other'
      ));
  end if;
end $$;

-- ── THE OWNER'S MONEY COMING IN ─────────────────────────────────────────────────────────────────
do $$
begin
  -- bank_lines.choice: 0375 named this one, so it can be found the easy way.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_choice_is_known'
       and pg_get_constraintdef(oid) not like '%''owner_in''%'
  ) then
    alter table public.bank_lines drop constraint bank_lines_choice_is_known;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_choice_is_known') then
    alter table public.bank_lines
      add constraint bank_lines_choice_is_known check (choice in (
        'matched', 'cost', 'draw', 'personal', 'petty_cash', 'not_cost', 'supplier', 'crew',
        'invoice', 'other_income', 'not_income', 'job', 'owner_in'
      ));
  end if;

  -- bank_rules.choice, still inline from 0363: found by what it says.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_rules'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%not_income%'
       and pg_get_constraintdef(oid) like '%choice%'
       and pg_get_constraintdef(oid) not like '%''owner_in''%'
       and pg_get_constraintdef(oid) not like '%direction%'
  ) then
    execute (
      select format('alter table public.bank_rules drop constraint %I', conname)
        from pg_constraint
       where conrelid = 'public.bank_rules'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%not_income%'
         and pg_get_constraintdef(oid) like '%choice%'
         and pg_get_constraintdef(oid) not like '%''owner_in''%'
         and pg_get_constraintdef(oid) not like '%direction%'
       limit 1
    );
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_choice_is_known') then
    alter table public.bank_rules
      add constraint bank_rules_choice_is_known check (choice in (
        'cost', 'draw', 'personal', 'petty_cash', 'not_cost', 'supplier', 'crew',
        'other_income', 'not_income', 'owner_in'
      ));
  end if;

  -- A MONEY-IN RULE CARRIES A MONEY-IN ANSWER, and owner_in is now one of them. Without this the
  -- door refuses every rule a person teaches it.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_rules'::regclass
       and conname = 'bank_rules_income_is_in'
       and pg_get_constraintdef(oid) not like '%''owner_in''%'
  ) then
    alter table public.bank_rules drop constraint bank_rules_income_is_in;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_income_is_in') then
    alter table public.bank_rules
      add constraint bank_rules_income_is_in
        check ((direction = 'in') = (choice in ('other_income', 'not_income', 'owner_in')));
  end if;
end $$;

-- ── WHAT MUST BE TRUE NOW ───────────────────────────────────────────────────────────────────────
do $$
declare missing text;
begin
  for missing in
    select t.tbl from (values ('bank_lines'), ('bank_rules')) as t(tbl)
     where not exists (
       select 1 from pg_constraint
        where conrelid = ('public.' || t.tbl)::regclass
          and conname = t.tbl || '_bucket_is_known'
          and pg_get_constraintdef(oid) like '%''Rent''%'
     )
  loop
    raise exception '0376: %.bucket does not allow Rent. Nothing was changed.', missing;
  end loop;

  if exists (
    select 1 from pg_constraint
     where conrelid in ('public.bank_lines'::regclass, 'public.bank_rules'::regclass) and contype = 'c'
       and pg_get_constraintdef(oid) like '%Insurance & Licenses%'
       and pg_get_constraintdef(oid) not like '%''Rent''%'
  ) then
    raise exception '0376: an older bucket list is still there, so two CHECKs disagree. Nothing was changed.';
  end if;

  for missing in
    select t.tbl from (values ('bank_lines'), ('bank_rules')) as t(tbl)
     where not exists (
       select 1 from pg_constraint
        where conrelid = ('public.' || t.tbl)::regclass
          and conname = t.tbl || '_choice_is_known'
          and pg_get_constraintdef(oid) like '%''owner_in''%'
     )
  loop
    raise exception '0376: %.choice does not allow owner_in. Nothing was changed.', missing;
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_income_is_in'
       and pg_get_constraintdef(oid) like '%''owner_in''%'
  ) then
    raise exception '0376: a money-in rule still cannot carry owner_in. Nothing was changed.';
  end if;

  -- 0375's pairing rule must have survived untouched.
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_job_named') then
    raise exception '0376: 0375''s job rule is gone from bank_lines. Nothing was changed.';
  end if;
  raise notice '0376: rent is a bucket, and money can come from the owner.';
end $$;
