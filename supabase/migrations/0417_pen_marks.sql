-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0417: pen marks on a supplier's paper, kept on the bill's lines (cn-v1181)
--
-- The owner, 2026-11-22, of delivery tickets he had marked up by hand: "i am scanning redacted bills
-- onto [a job] and it seems to be picking up on the redactions on some and not others"; "credits are
-- being issued for all un-used items have been returned"; and of a store receipt already paid: "there
-- may or may not be a return submitted but we probably dont need to account for it like a charge on an
-- account [...] so it just gets redacted".
--
-- WHY. The rule is src/lib/pen-marks.ts: the paper stays whole at its PRINTED prices and total; a line
-- struck by hand comes off the CUSTOMER'S bill (billable = false, which every money reader already
-- honours: job cost reads the bill's header, the customer's invoice drops a not-billed line with its
-- share of tax, what is owed reads the header). What billable = false cannot say is WHY a line is off:
-- "the company eats it" and "it went back to the supplier, a credit is coming" are different facts, and
-- a credit memo has nothing to close. Three columns say it.
--
-- WHAT, nothing else:
--
--  1. bill_line_items.pen_mark text null: what the reader saw written by hand on the line, one of
--     'struck', 'quantity', 'unclear' (null: none). 'unclear' IS the open question, Kept or Returned.
--  2. bill_line_items.returned boolean not null default false: the line went back to the supplier ON
--     ACCOUNT, so a credit is expected (or received). A line struck on a receipt paid at purchase is
--     only off the customer's bill and is never returned here.
--  3. bill_line_items.returned_credit_bill_id uuid null, references bills(id) ON DELETE SET NULL: the
--     credit memo's bill that closed the line. Deleting that bill opens the line again.
--  4. THE CHECKS, each by name, each added only when it is not there:
--       bill_line_items_returned_not_billed   not returned or billable = false
--                                             (a returned line is never on the customer's bill)
--       bill_line_items_credit_needs_return   returned_credit_bill_id is null or returned
--                                             (only a returned line is closed by a credit)
--       bill_line_items_pen_mark_word         pen_mark is null or one of the three words
--  5. An index on returned_credit_bill_id where it is not null (the credit memo finds what it closed;
--     the delete of a bill finds the lines its foreign key sets null).
--  6. A self-check of all of it.
--
-- NO DATA CHANGES. Every line on the books keeps pen_mark null, returned false, no credit: exactly what
-- it meant before this file.
--
-- L1, THE OLDER RULES ON bill_line_items READ AGAINST THE NEW COLUMNS (read 2026-11-22: 0043, 0100,
-- 0256, 0268, 0271, 0272, 0274, 0275, 0278, 0302, 0303, 0304, 0328, 0334, 0349, 0355, 0364; 0416 is
-- the newest before this one and does not name the table):
--   0043  the table, stamp_org_bill_line_items (set_org_id before insert: the new columns are not
--         read), RLS and its one policy bill_line_items_rw (org staff, for all): unchanged, and the new
--         columns are read and written under it.
--   0268  billable not null default true: the new checks lean on it, never change it.
--   0272  billed_amount and its check bill_line_items_billed_amount_sane, is_stock: a returned line
--         bills nothing, and the app never writes a billed_amount on a line that does not bill.
--   0304/0364  freeze_used_stock_line (before insert/update/delete) judges "money" by amount,
--         quantity, billable, billed_amount, category and bill_id: a line turned returned is always
--         turned billable = false in the same write, so it is judged as money; a credit closing a line
--         (returned_credit_bill_id alone) is not money and passes. The shelf's own reads (stock lots
--         by bill_line_id) do not read the new columns.
--   0349  bill_line_items_unstamp_draw_pdfs_upd fires on a fixed column list; the new columns ride
--         with billable (which is in it), and a credit closing a line moves no money on a draw.
--   0100/0271/0274/0275  learned_prices reads description, quantity, unit_price and amount: a line
--         that went back was still bought at its printed price, so the price book keeps learning it.
--   0256  the labor/claim backfill keys invoice lines to 'bli:' ids: no new column read.
--   0303/0328/0355  the shelf ledger and its counts read is_stock and ids only.
--   No view and no function lists the table's columns with a star into a fixed shape.
--
-- THE WRITERS AND THE READERS, named the day the columns are added: src/app/(app)/organize/
-- paperwork-core.ts insertItemizedBill writes them through penColumns (src/lib/pen-marks.ts), for a
-- line that has a mark or is returned only; readBillStanding reads them back for an Undo
-- (penFromColumns), so an Undo then File It keeps what a person answered. The bill's card and its
-- Kept / Returned door (src/app/(app)/bills/receipt-billing-card.tsx, receipt-billing-actions.ts),
-- the job's costs list and the credit memo's filing (src/app/(app)/organize/credit-memo-actions.ts)
-- read and write them. tests/migration-0417.test.ts reads this file;
-- src/lib/pen-marks-0417.integration.test.ts asks the database.
--
-- ORDER. BEFORE the deploy: the app that writes these columns refuses a bill whose insert names a
-- column the database does not have. Applied first, the running app reads and writes none of them.
--
-- LOCKS. add column with a constant default is a catalog change; the foreign key takes SHARE ROW
-- EXCLUSIVE on bills for a moment; each check scans bill_line_items once. lock_timeout 3s,
-- statement_timeout 15s, the house's. ONE TRANSACTION: the runners wrap the file. TWICE-SAFE: every
-- column, check, key and index is added only when it is not there.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── The ground it stands on ─────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.bill_line_items') is null or to_regclass('public.bills') is null then
    raise exception '0417: public.bill_line_items (0043) or public.bills is not on this database. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bill_line_items'
       and column_name = 'billable' and data_type = 'boolean' and is_nullable = 'NO'
  ) then
    raise exception '0417: bill_line_items.billable (0268) is not a boolean that is never null. Nothing was changed.';
  end if;
  -- A column of one of these names that is not this file's shape is somebody else's: read it first.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bill_line_items'
       and ((column_name = 'pen_mark' and data_type <> 'text')
         or (column_name = 'returned' and data_type <> 'boolean')
         or (column_name = 'returned_credit_bill_id' and data_type <> 'uuid'))
  ) then
    raise exception '0417: bill_line_items already has pen_mark, returned or returned_credit_bill_id of another type. Nothing was changed.';
  end if;
end $$;

-- 1-3. The three columns.
alter table public.bill_line_items
  add column if not exists pen_mark text,
  add column if not exists returned boolean not null default false,
  add column if not exists returned_credit_bill_id uuid;

comment on column public.bill_line_items.pen_mark is
  'What was written by hand on this line of the supplier''s paper (0417): struck, quantity (a quantity changed by hand: the line is split into kept and returned), unclear (a mark nobody could be sure of: held off the customer''s bill until a person answers Kept or Returned). Null: none. src/lib/pen-marks.ts is the rule.';
comment on column public.bill_line_items.returned is
  'The line went back to the supplier ON ACCOUNT (0417): a credit is expected, or received (returned_credit_bill_id). Always billable = false. False on a receipt paid at purchase, where a struck line is only off the customer''s bill.';
comment on column public.bill_line_items.returned_credit_bill_id is
  'The credit memo''s bill that closed this returned line (0417). Deleting that bill sets it null, and the line waits for its credit again.';

-- The foreign key, by name, only when it is not there.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bill_line_items'::regclass
       and conname = 'bill_line_items_returned_credit_bill_id_fkey'
  ) then
    alter table public.bill_line_items
      add constraint bill_line_items_returned_credit_bill_id_fkey
      foreign key (returned_credit_bill_id) references public.bills(id) on delete set null;
  end if;
end $$;

-- 4. The checks, each by name, only when it is not there.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bill_line_items'::regclass and conname = 'bill_line_items_returned_not_billed'
  ) then
    alter table public.bill_line_items
      add constraint bill_line_items_returned_not_billed
      check (not returned or billable = false);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bill_line_items'::regclass and conname = 'bill_line_items_credit_needs_return'
  ) then
    alter table public.bill_line_items
      add constraint bill_line_items_credit_needs_return
      check (returned_credit_bill_id is null or returned);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bill_line_items'::regclass and conname = 'bill_line_items_pen_mark_word'
  ) then
    alter table public.bill_line_items
      add constraint bill_line_items_pen_mark_word
      check (pen_mark is null or pen_mark in ('struck', 'quantity', 'unclear'));
  end if;
end $$;

-- 5. The credit finds what it closed.
create index if not exists bill_line_items_returned_credit_idx
  on public.bill_line_items (returned_credit_bill_id)
  where returned_credit_bill_id is not null;

-- 6. The self-check: what this file made is there, what it left is as it was.
do $$
declare
  v_def text;
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'bill_line_items'
         and ((column_name = 'pen_mark' and data_type = 'text' and is_nullable = 'YES' and column_default is null)
           or (column_name = 'returned' and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false')
           or (column_name = 'returned_credit_bill_id' and data_type = 'uuid' and is_nullable = 'YES' and column_default is null))) <> 3 then
    raise exception '0417: pen_mark (text, null), returned (boolean, not null, default false) or returned_credit_bill_id (uuid, null) is not as this file makes it. Nothing was changed.';
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.bill_line_items'::regclass and contype = 'f'
     and conname = 'bill_line_items_returned_credit_bill_id_fkey';
  if v_def is null or position('bills(id)' in v_def) = 0 or position('ON DELETE SET NULL' in v_def) = 0 then
    raise exception '0417: returned_credit_bill_id does not reference bills(id) on delete set null (found %). Nothing was changed.', coalesce(v_def, 'none');
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.bill_line_items'::regclass and contype = 'c' and conname = 'bill_line_items_returned_not_billed';
  if v_def is null or position('returned' in v_def) = 0 or position('billable = false' in v_def) = 0 then
    raise exception '0417: the check bill_line_items_returned_not_billed is not "not returned or billable = false" (found %). Nothing was changed.', coalesce(v_def, 'none');
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.bill_line_items'::regclass and contype = 'c' and conname = 'bill_line_items_credit_needs_return';
  if v_def is null or position('returned_credit_bill_id IS NULL' in v_def) = 0 or position('returned' in replace(v_def, 'returned_credit_bill_id', '')) = 0 then
    raise exception '0417: the check bill_line_items_credit_needs_return is not "returned_credit_bill_id is null or returned" (found %). Nothing was changed.', coalesce(v_def, 'none');
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.bill_line_items'::regclass and contype = 'c' and conname = 'bill_line_items_pen_mark_word';
  if v_def is null or position('struck' in v_def) = 0 or position('quantity' in v_def) = 0 or position('unclear' in v_def) = 0 then
    raise exception '0417: the check bill_line_items_pen_mark_word does not take struck, quantity and unclear (found %). Nothing was changed.', coalesce(v_def, 'none');
  end if;
  if to_regclass('public.bill_line_items_returned_credit_idx') is null then
    raise exception '0417: the index bill_line_items_returned_credit_idx is missing. Nothing was changed.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.bill_line_items'::regclass) then
    raise exception '0417: row level security is off on bill_line_items. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bill_line_items' and policyname = 'bill_line_items_rw') then
    raise exception '0417: the policy bill_line_items_rw (0043) is missing. Nothing was changed.';
  end if;
  if exists (select 1 from public.bill_line_items where returned and billable)
     or exists (select 1 from public.bill_line_items where returned_credit_bill_id is not null and not returned) then
    raise exception '0417: a line breaks its new checks. Nothing was changed.';
  end if;
end $$;
