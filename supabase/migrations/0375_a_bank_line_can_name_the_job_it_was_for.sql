-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0375: a bank line can name the job it was for
--
-- Erik, 2026-10-02, on the reconcile cleanup: a line on the bank statement that paid for one job's
-- materials could only ever become overhead. 0363 gave a bank line eleven answers — a business
-- bucket (Fuel, Auto, Tools & Supplies, Phone & Office, Insurance & Licenses, Fees, Other), a
-- supplier's account, a person's pay, an invoice, the owner's draw, personal, cash taken out, not a
-- cost, already counted — and not one of them is a JOB. So money spent at the counter for one job
-- landed in a business bucket under Overhead, where the job it belongs to never sees it and Gross
-- Profit reads high by exactly that much.
--
-- WHAT THIS ADDS: one nullable column and one word.
--
--   bank_lines.job_id   The job a person put the line on. A PLAIN uuid, like the supplier account,
--                       the person and the invoice beside it (0363): a foreign key here would take a
--                       lock on public.jobs every time a line is written, and the money row the line
--                       writes (bills.job_id, 0017) already carries the real reference with its own
--                       ON DELETE SET NULL.
--   choice 'job'        The twelfth answer. bank_rules is UNCHANGED ON PURPOSE: a rule is per
--                       MERCHANT, and "the supply house is always this job" is never true. The app
--                       offers a job only on a row that is ONE line, and planBankDownload marks a
--                       one-line row unlearnable (learnable: !single && …), so no rule can ever hold
--                       a job. If that ever changes, this file is the reason it must not.
--
-- WHERE THE MONEY THEN LANDS, with no further database change: the app writes the sorted line as a
-- bills row, and analytics/owner-money.ts already splits every live bill by whether it has a job —
--
--     if (b.job_id) { -> Materials & Bills, inside COGS; continue }
--     else            -> its bucket, Overhead or COGS by BUCKET_SECTION
--
-- — exclusively, with that `continue`. So a line put on a job is a job cost on every money surface at
-- once: the P&L's Materials & Bills, the job's own profit, the accountant's download. The same place
-- a snapped receipt filed on that job lands, by the same code. The app writes `category` NULL on a
-- job line, because job_id already decides and a bucket sitting beside it is dead data that reads
-- like a second answer to one question.
--
-- TEETH: bank_lines_job_named. A 'job' line MUST name a job, and no other answer may name one. A job
-- answer with its job missing, or a bucket answer that quietly kept a job, is not a state the books
-- can hold — so the database refuses it rather than trusting every writer to remember.
--
-- LOCKS: one nullable column on bank_lines (catalog only, every existing row null), the choice CHECK
-- swapped for a wider one that every existing row already satisfies, one CHECK added, one partial
-- index. ACCESS EXCLUSIVE on bank_lines for a moment, then its (small) index build.
-- lock_timeout 3s: a busy table fails fast and changes nothing. Run it again.
--
-- ORDER: after 0363 (bank_lines). Additive only. Safe to re-run. Safe BEFORE or AFTER the code: until
-- the column is there the app offers no job on a bank row and says what is missing, and nothing
-- crashes; with the column there and the old code running, nothing writes 'job' and nothing breaks.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.bank_lines') is null then
    raise exception '0375: bank_lines is not on this database. Run 0363 first. Nothing was changed.';
  end if;
  if to_regclass('public.jobs') is null then
    raise exception '0375: jobs is not on this database. Nothing was changed.';
  end if;
end $$;

-- ── 1. THE COLUMN ───────────────────────────────────────────────────────────────────────────────
-- Plain uuid, no foreign key: the same shape as supplier_account_id, profile_id and invoice_id on
-- this table, and for the reason 0363 gives about import_id — a reference here would reach for a lock
-- on another table on every line written, and the bills row already holds the real one.
alter table public.bank_lines add column if not exists job_id uuid;

comment on column public.bank_lines.job_id is
  'The job a person put this bank line on (0375), when choice is ''job''. A plain uuid, like the supplier account and invoice beside it: the bills row this line wrote carries the real reference. NULL on every other answer, and bank_lines_job_named holds that both ways.';

-- ── 2. THE TWELFTH WORD ─────────────────────────────────────────────────────────────────────────
-- 0363 wrote the choice CHECK inline, so Postgres named it (bank_lines_choice_check). Find it by
-- what it says rather than by a name this file does not get to choose, and give the replacement a
-- name of our own so the next migration can find it the easy way.
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.bank_lines'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%not_income%'
       and pg_get_constraintdef(oid) not like '%''job''%'
  loop
    execute format('alter table public.bank_lines drop constraint %I', c.conname);
    raise notice '0375: dropped the old choice list (%).', c.conname;
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_choice_is_known'
  ) then
    alter table public.bank_lines
      add constraint bank_lines_choice_is_known check (choice in (
        'matched', 'cost', 'draw', 'personal', 'petty_cash', 'not_cost', 'supplier', 'crew',
        'invoice', 'other_income', 'not_income', 'job'
      ));
  end if;

  -- A 'job' line names a job; nothing else may. Both directions, in one rule.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_job_named'
  ) then
    alter table public.bank_lines
      add constraint bank_lines_job_named check ((choice = 'job') = (job_id is not null));
  end if;
end $$;

-- ── 3. READING A JOB'S OWN BANK LINES ───────────────────────────────────────────────────────────
-- Partial: only the lines that name a job are ever looked up this way.
create index if not exists bank_lines_job_idx
  on public.bank_lines (org_id, job_id)
  where job_id is not null;

-- ── 4. WHAT MUST BE TRUE NOW ────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bank_lines'
       and column_name = 'job_id' and data_type = 'uuid' and is_nullable = 'YES'
  ) then
    raise exception '0375: bank_lines.job_id is missing. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_choice_is_known'
       and pg_get_constraintdef(oid) like '%''job''%'
  ) then
    raise exception '0375: the choice list does not allow a job. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_lines'::regclass and conname = 'bank_lines_job_named'
  ) then
    raise exception '0375: bank_lines has no rule pairing a job answer with a job. Nothing was changed.';
  end if;
  -- The old inline list must be gone, or two CHECKs disagree and the wider one never applies.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_lines'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%not_income%'
       and pg_get_constraintdef(oid) not like '%''job''%'
  ) then
    raise exception '0375: an older choice list is still on bank_lines. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'bank_lines' and indexname = 'bank_lines_job_idx'
  ) then
    raise exception '0375: bank_lines has no job index. Nothing was changed.';
  end if;
  -- bank_rules MUST NOT have learned to hold a job (see the header): if it ever does, this is wrong.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bank_rules'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%choice%' and pg_get_constraintdef(oid) like '%''job''%'
  ) then
    raise exception '0375: bank_rules allows a job answer. A rule is per merchant and must not. Nothing was changed.';
  end if;
  raise notice '0375: a bank line can name the job it was for.';
end $$;
