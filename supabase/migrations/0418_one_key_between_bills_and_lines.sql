-- 0418: ONE foreign key between a bill and its lines. 0417's second one broke every joined read.
--
-- WHAT HAPPENED (2026-11-22). 0417 gave bill_line_items a column that names the credit memo's bill
-- which closed a returned line, and made it a FOREIGN KEY to bills(id), on delete set null. A bill's
-- line already holds one foreign key to bills (bill_id). The data API works out how two tables join
-- from the keys between them, and with two keys it refuses to guess: every read that asks for a
-- bill WITH its lines, or a line WITH its bill, answered "more than one relationship was found" from
-- the minute 0417 was applied. The hour-after read of the release found it in the error sink.
--
-- THE SAME LESSON, THE SECOND TIME. The deposits release (0414) was asked for a second key between
-- invoices and their lines; its builder refused and held the rule with triggers, and that was written
-- down. The contract for 0417 asked for the key again and nobody stopped it: the unit stand-ins do not
-- model how the data API picks a join, and the database suites ask in SQL, where two keys are fine.
--
-- THE CURE: drop the key and hold its two promises with triggers, which the data API does not read.
--   1. a line can only name a credit bill that EXISTS (what the key refused, with the key's own code);
--   2. deleting that bill EMPTIES the link, so the line waits for its credit again (on delete set null).
-- Nothing else of 0417 changes: the three columns, the three checks and the index stand.
--
-- Twice-safe. No data change. It ends by checking that exactly ONE key is left and by telling the data
-- API to read the schema again.

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.bill_line_items') is null or to_regclass('public.bills') is null then
    raise exception '0418: public.bill_line_items or public.bills is not on this database. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bill_line_items'
       and column_name = 'returned_credit_bill_id' and data_type = 'uuid'
  ) then
    raise exception '0418: bill_line_items.returned_credit_bill_id (0417) is not on this database. Nothing was changed.';
  end if;
end $$;

alter table public.bill_line_items
  drop constraint if exists bill_line_items_returned_credit_bill_id_fkey;

-- 1. The credit bill must exist (the key's own refusal, 23503).
create or replace function public.bill_line_items_credit_bill_exists()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.bills b where b.id = new.returned_credit_bill_id) then
    raise exception 'bill_line_items.returned_credit_bill_id names a bill that does not exist'
      using errcode = '23503';
  end if;
  return new;
end $$;

revoke all on function public.bill_line_items_credit_bill_exists() from public, anon, authenticated;

drop trigger if exists bill_line_items_credit_bill_exists on public.bill_line_items;
create trigger bill_line_items_credit_bill_exists
  before insert or update of returned_credit_bill_id on public.bill_line_items
  for each row
  when (new.returned_credit_bill_id is not null)
  execute function public.bill_line_items_credit_bill_exists();

-- 2. Deleting the credit memo's bill opens its lines again (on delete set null).
create or replace function public.bills_reopen_returned_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bill_line_items
     set returned_credit_bill_id = null
   where returned_credit_bill_id = old.id;
  return old;
end $$;

revoke all on function public.bills_reopen_returned_lines() from public, anon, authenticated;

drop trigger if exists bills_reopen_returned_lines on public.bills;
create trigger bills_reopen_returned_lines
  before delete on public.bills
  for each row
  execute function public.bills_reopen_returned_lines();

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_constraint c
   where c.contype = 'f'
     and ((c.conrelid = 'public.bill_line_items'::regclass and c.confrelid = 'public.bills'::regclass)
       or (c.conrelid = 'public.bills'::regclass and c.confrelid = 'public.bill_line_items'::regclass));
  if n <> 1 then
    raise exception '0418: bills and bill_line_items must be joined by exactly ONE foreign key (found %). Nothing was changed.', n;
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.bills'::regclass and tgname = 'bills_reopen_returned_lines' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgrelid = 'public.bill_line_items'::regclass and tgname = 'bill_line_items_credit_bill_exists' and not tgisinternal) then
    raise exception '0418: a trigger this file makes is missing. Nothing was changed.';
  end if;
  if exists (
    select 1 from public.bill_line_items l
     where l.returned_credit_bill_id is not null
       and not exists (select 1 from public.bills b where b.id = l.returned_credit_bill_id)
  ) then
    raise exception '0418: a line names a credit bill that does not exist. Nothing was changed.';
  end if;
end $$;

notify pgrst, 'reload schema';
