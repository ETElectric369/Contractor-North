-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0363: a bank line is matched once
--
-- Erik, 2026-09-27, "yes go for those": drop the monthly bank download where paper already goes
-- (Drop Paperwork, Organize), and North sorts it the way we sorted ET's checking export by hand
-- that night: deposits matched to the invoice payments already recorded, supplier payments to the
-- supplier's account, fuel and insurance to their buckets, transfers to the owner as draw (never a
-- cost), personal as personal. It asks only about the ones it can't place, and it remembers each
-- answer for that company's next download.
--
-- TWO TABLES, BOTH STAFF-ONLY, BOTH KEYED BY org_id:
--
--   bank_lines   One row per bank line a person applied, and ONLY what the app needs to never
--                count it twice: the last 4 of the account, the day, the signed amount, the
--                description with any run of 6+ digits cut to its last 4 (the CHECK below refuses
--                a longer run, so an account or card number can never be stored here), the check
--                number, the merchant key, and where it went (choice). line_key is the bank's own
--                transaction id (FITID) when the file has one, else a hash of the line; UNIQUE per
--                company, so two overlapping downloads can never count one line twice, and two
--                Apply presses can never write it twice.
--   bank_rules   The company's own choices: "SHELL -> Fuel". Written only when a person
--                taps an answer, one per company + direction + merchant key. Every company starts
--                with none; one company's rules are never read for another (RLS + the org filter).
--
-- ONE COLUMN ON FIVE MONEY TABLES: bank_line_id on payments, bills, supplier_payments, pay_payments
-- and petty_cash. A row the download MATCHED (a deposit that is a payment already recorded) or
-- WROTE (a fuel bill, a supplier payment) carries the line's id. A row holds one line, so a row is
-- never matched twice (the app marks only a row whose bank_line_id is still null). On bills,
-- supplier_payments, pay_payments and petty_cash a partial UNIQUE index also holds one line to one
-- row; payments gets a plain index instead, because one card payout or Venmo sweep is ONE bank line
-- for several payments. ON DELETE SET NULL: undoing a download deletes its lines, and every mark
-- comes off with them.
--
-- OWNER'S DRAW HAS NO LEDGER (0286, owner-money.ts): a transfer to the owner is kept as the bank
-- line only (choice 'draw'), never a cost and never a payroll row. 'other_income' lines are what
-- the Owner's Draw card adds to Received as their own chip.
--
-- LOCKS: two new tables; one nullable column (catalog only, all null) plus a partial index
-- on each of payments, bills, supplier_payments, pay_payments, petty_cash. ACCESS EXCLUSIVE on each
-- for a moment, then SHARE while its (empty) index builds. lock_timeout 3s: a busy table fails
-- fast and changes nothing. Run it again.
--
-- UNCHANGED: every policy on the five money tables. organized_items (where the download waits as
-- one card) is already staff-only for anything staff made (0201).
--
-- ORDER: after 0285 (the buckets) and 0362 (fuel is its own bucket, Gas & Truck is Auto: the
-- bucket CHECKs below name the seven buckets 0362 leaves). A Fuel answer is simply the Fuel bucket.
-- Safe before or after the code: the door says "the bank download needs one database update"
-- until this is applied, and nothing crashes. Additive only. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.supplier_payments') is null or to_regclass('public.pay_payments') is null or to_regclass('public.petty_cash') is null then
    raise exception '0363: supplier_payments (0270), pay_payments or petty_cash is not on this database. Nothing was changed.';
  end if;
end $$;

-- ── bank_lines ──────────────────────────────────────────────────────────────────────────────────
create table if not exists public.bank_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- The Sort These card (organized_items) it came in on. A plain uuid: Undo finds a download's
  -- lines by it, and a foreign key would lock organized_items every time a line is written.
  import_id uuid not null,
  line_key text not null check (line_key ~ '^(fitid|line):[0-9a-f]{64}$'),
  account_last4 text check (account_last4 is null or account_last4 ~ '^[0-9]{1,4}$'),
  posted_on date not null,
  -- Signed: money in is positive, money out negative. A $0.00 line is not money.
  amount numeric(12,2) not null check (amount <> 0),
  -- THE PRIVACY BOUNDARY, held here and not only in the app: no run of 6 or more digits.
  description text not null default '' check (char_length(description) <= 200 and description !~ '[0-9]{6,}'),
  check_number text check (check_number is null or check_number ~ '^[0-9]{1,10}$'),
  merchant_key text not null default '' check (char_length(merchant_key) <= 60 and merchant_key !~ '[0-9]{6,}'),
  choice text not null check (choice in (
    'matched', 'cost', 'draw', 'personal', 'petty_cash', 'not_cost', 'supplier', 'crew',
    'invoice', 'other_income', 'not_income'
  )),
  bucket text check (bucket is null or bucket in ('Fuel', 'Auto', 'Tools & Supplies', 'Phone & Office', 'Insurance & Licenses', 'Fees', 'Other')),
  supplier_account_id uuid,
  profile_id uuid,
  invoice_id uuid,
  -- How it was placed: matched to a row already there, by a rule the company made, or by a person.
  sorted_by text not null check (sorted_by in ('match', 'rule', 'person')),
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint bank_lines_one_per_company unique (org_id, line_key),
  constraint bank_lines_cost_has_bucket check ((choice = 'cost') = (bucket is not null))
);

comment on table public.bank_lines is
  'One bank line a person applied from a bank download (0363): last 4 of the account, day, signed amount, description with long digit runs cut to their last 4, and where it went. UNIQUE (org_id, line_key): a line is counted once however many downloads carry it. Staff only.';

create index if not exists bank_lines_import_idx on public.bank_lines (org_id, import_id);
create index if not exists bank_lines_posted_idx on public.bank_lines (org_id, posted_on);

-- ── bank_rules ──────────────────────────────────────────────────────────────────────────────────
create table if not exists public.bank_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  merchant_key text not null check (char_length(merchant_key) between 2 and 60 and merchant_key !~ '[0-9]{6,}'),
  choice text not null check (choice in (
    'cost', 'draw', 'personal', 'petty_cash', 'not_cost', 'supplier', 'crew', 'other_income', 'not_income'
  )),
  bucket text check (bucket is null or bucket in ('Fuel', 'Auto', 'Tools & Supplies', 'Phone & Office', 'Insurance & Licenses', 'Fees', 'Other')),
  supplier_account_id uuid,
  profile_id uuid,
  -- The download whose tap taught it: that download's Undo takes the rule back off.
  learned_import_id uuid,
  uses integer not null default 0 check (uses >= 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_rules_one_per_key unique (org_id, direction, merchant_key),
  constraint bank_rules_cost_has_bucket check ((choice = 'cost') = (bucket is not null)),
  constraint bank_rules_supplier_named check (choice <> 'supplier' or supplier_account_id is not null),
  constraint bank_rules_crew_named check (choice <> 'crew' or profile_id is not null),
  constraint bank_rules_income_is_in check ((direction = 'in') = (choice in ('other_income', 'not_income')))
);

comment on table public.bank_rules is
  'A company''s own answer for a merchant on its bank downloads (0363), written only when a person taps it: one per company + direction + merchant key. Never shared between companies. Staff only.';

-- ── RLS: staff of the row's own company, for every verb (the supplier_payments shape, 0270) ────
alter table public.bank_lines enable row level security;
alter table public.bank_rules enable row level security;

do $$
declare t text;
begin
  foreach t in array array['bank_lines', 'bank_rules'] loop
    execute format('drop policy if exists %I_staff_all on public.%I', t, t);
    execute format(
      'create policy %I_staff_all on public.%I for all using (org_id = public.auth_org_id() and public.is_org_staff()) with check (org_id = public.auth_org_id() and public.is_org_staff())',
      t, t);
  end loop;
end $$;

revoke all on public.bank_lines from anon;
revoke all on public.bank_rules from anon;
revoke truncate, references, trigger on public.bank_lines from authenticated;
revoke truncate, references, trigger on public.bank_rules from authenticated;
grant select, insert, update, delete on public.bank_lines to authenticated;
grant select, insert, update, delete on public.bank_rules to authenticated;

-- ── The mark on the five money tables ──────────────────────────────────────────────────────────
alter table public.payments add column if not exists bank_line_id uuid references public.bank_lines(id) on delete set null;
alter table public.bills add column if not exists bank_line_id uuid references public.bank_lines(id) on delete set null;
alter table public.supplier_payments add column if not exists bank_line_id uuid references public.bank_lines(id) on delete set null;
alter table public.pay_payments add column if not exists bank_line_id uuid references public.bank_lines(id) on delete set null;
alter table public.petty_cash add column if not exists bank_line_id uuid references public.bank_lines(id) on delete set null;

-- Not unique: one payout line covers several card payments (the only table where that is so).
create index if not exists payments_bank_line_idx on public.payments (bank_line_id) where bank_line_id is not null;
create unique index if not exists bills_one_bank_line on public.bills (bank_line_id) where bank_line_id is not null;
create unique index if not exists supplier_payments_one_bank_line on public.supplier_payments (bank_line_id) where bank_line_id is not null;
create unique index if not exists pay_payments_one_bank_line on public.pay_payments (bank_line_id) where bank_line_id is not null;
create unique index if not exists petty_cash_one_bank_line on public.petty_cash (bank_line_id) where bank_line_id is not null;

comment on column public.payments.bank_line_id is 'The bank line (0363) this payment was matched to or written from. One line, once.';
comment on column public.bills.bank_line_id is 'The bank line (0363) this bill was matched to or written from. One line, once.';
comment on column public.supplier_payments.bank_line_id is 'The bank line (0363) this supplier payment was matched to or written from. One line, once.';
comment on column public.pay_payments.bank_line_id is 'The bank line (0363) this crew payment was matched to or written from. One line, once.';
comment on column public.petty_cash.bank_line_id is 'The bank line (0363) this petty cash row was matched to or written from (an ATM withdrawal). One line, once.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['bank_lines', 'bank_rules'] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = t and c.relrowsecurity
    ) then
      raise exception '0363: % has row level security switched off. Nothing was changed.', t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_staff_all') then
      raise exception '0363: % has no staff-only policy. Nothing was changed.', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception '0363: anon can read %. Nothing was changed.', t;
    end if;
  end loop;
  foreach t in array array['payments', 'bills', 'supplier_payments', 'pay_payments', 'petty_cash'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = t and column_name = 'bank_line_id' and data_type = 'uuid' and is_nullable = 'YES'
    ) then
      raise exception '0363: %.bank_line_id is missing. Nothing was changed.', t;
    end if;
    if t <> 'payments' and not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = t and indexname = t || '_one_bank_line') then
      raise exception '0363: % has no one-line-once index. Nothing was changed.', t;
    end if;
  end loop;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'payments' and indexname = 'payments_bank_line_idx') then
    raise exception '0363: payments has no bank line index. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_one_per_company' and contype = 'u') then
    raise exception '0363: bank_lines is missing its one-line-per-company key. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bank_rules'::regclass and conname = 'bank_rules_one_per_key' and contype = 'u') then
    raise exception '0363: bank_rules is missing its one-rule-per-merchant key. Nothing was changed.';
  end if;
  raise notice '0363: a bank line is matched once.';
end $$;
