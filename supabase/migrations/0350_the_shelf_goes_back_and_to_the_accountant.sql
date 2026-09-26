-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0350: the shelf goes back, and to the accountant (Shop Stock, Phase 4)
--
-- Phase 4 adds three office doors on Shop Stock and one page:
--   · WRITE OFF a roll's pieces (lost, ruined, used on the shop): a write_off move, stamped at what
--     the pieces cost off the roll (0303), shown as Shop Stock Lost in the month it is written off.
--     The company eats it. It is never a customer's charge: a write-off has no job (0303's
--     stock_moves_job_shape already says so).
--   · RETURN TO CED: pieces go back to the supplier. A supplier_return move lowers the roll (0303
--     stamps its cost), and when CED's credit memo is in the books it is TIED to the return here.
--     The credit is filed to the shelf (bills.on_shelf, job_id null), so no job's materials import
--     can ever see it, and no customer is ever credited for shelf stock. What the pieces cost minus
--     what CED gave back is written off, and the app says so in words.
--   · EXPORT FOR ACCOUNTANT (/analytics/accountant): four CSV lists. Every download is recorded, so a
--     write-off, a return or a count the accountant already has can't be quietly undone after.
--
-- WHAT IS NEW, nothing replaced (no function body from an earlier migration is rewritten):
--   1. stock_moves.credit_bill_id: the credit memo a supplier_return is tied to. A plain uuid, NOT a
--      foreign key: a key to bills would lock bills (share row exclusive) while it is added, and
--      every receipt write touches bills. The trigger in 3 checks it instead, at insert; 0303's
--      guard_stock_move already refuses any later change to a move but its undo.
--      With it, stock_moves.credit_filed_by_return: this return is what filed the credit to the shelf
--      (it had no job and wasn't on the shelf). When the last live return naming the credit is
--      undone, the app takes a credit a return filed back off the shelf, so it is a plain credit on
--      Bills again that can go on a job; one a person filed to the shelf stays where they put it.
--   2. A write-off says why: stock_moves_write_off_has_a_reason (NOT VALID, then validated).
--   3. stock_move_names_its_credit (BEFORE INSERT on stock_moves): the credit is this company's, a
--      credit (below $0), filed to the shelf (on_shelf, no job) and not set aside. Only a
--      supplier_return may name one.
--   4. guard_shelf_credit_bill (BEFORE UPDATE OR DELETE on bills): while a live return names a
--      credit, the credit can't be deleted, put on a job, taken off the shelf, turned into a
--      charge, set aside or moved to another company. Undo the return first.
--   5. accountant_exports: one row per CSV download (which list, the window it covered, who, when).
--      Staff-only. Append-only: no update, no delete, and who/when are the database's.
--   6. guard_stock_move_exported (BEFORE UPDATE on stock_moves): an office upkeep move (write_off,
--      supplier_return, recount_down, recount_up) that a Stock Used or On Hand download already
--      carried can't be undone. The refusal names the download and the way forward (Count It).
--
-- WHAT THIS CHANGES TODAY: nothing on any screen, and no row is written. Production had 0 lots and
-- 0 moves on 2026-09-26, and every credit bill is on a job (none can be tied).
--
-- LOCKS: stock_moves (add a nullable column, add a constraint, two triggers: brief, the table is
-- empty in production) and bills (CREATE TRIGGER takes share row exclusive for a moment). A new
-- table. lock_timeout 3s: a busy table fails fast and changes nothing rather than queueing writers;
-- run it again.
--
-- ORDER: after 0303 and 0328. Safe before or after the Phase 4 code: until this is applied, Write Off
-- works (0303 already lets the office write it), Return To CED works without tying a credit and says
-- the tie needs this update, and downloads are not remembered (the page says so).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.stock_moves') is null or to_regprocedure('public.stock_recount(uuid, numeric, text)') is null then
    raise exception '0350: the shelf (0303) and Count It (0328) are not on this database. Apply them first. Nothing was changed.';
  end if;
end $$;

-- ── 1 + 2. the return's credit, and the write-off's reason ─────────────────────────────────────
alter table public.stock_moves add column if not exists credit_bill_id uuid;
comment on column public.stock_moves.credit_bill_id is
  'The supplier''s credit memo (a bill below $0, filed to the shelf) a supplier_return is tied to (0350). A plain uuid, checked by stock_move_names_its_credit at insert. What the pieces cost minus the credit is written off.';
-- A constant default: no table rewrite, a moment's lock.
alter table public.stock_moves add column if not exists credit_filed_by_return boolean not null default false;
comment on column public.stock_moves.credit_filed_by_return is
  'True when this supplier_return is what filed its credit to the shelf (0350). When the last live return naming the credit is undone, the app takes such a credit back off the shelf.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_moves_credit_only_on_a_return') then
    alter table public.stock_moves
      add constraint stock_moves_credit_only_on_a_return check (credit_bill_id is null or kind = 'supplier_return') not valid;
    alter table public.stock_moves validate constraint stock_moves_credit_only_on_a_return;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_moves_filed_names_its_credit') then
    alter table public.stock_moves
      add constraint stock_moves_filed_names_its_credit check (not credit_filed_by_return or credit_bill_id is not null) not valid;
    alter table public.stock_moves validate constraint stock_moves_filed_names_its_credit;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_moves_write_off_has_a_reason') then
    alter table public.stock_moves
      add constraint stock_moves_write_off_has_a_reason check (kind <> 'write_off' or length(btrim(coalesce(note, ''))) > 0) not valid;
    alter table public.stock_moves validate constraint stock_moves_write_off_has_a_reason;
  end if;
end $$;
create index if not exists stock_moves_credit_bill_idx on public.stock_moves (credit_bill_id) where credit_bill_id is not null;

-- ── 3. a return names a real credit, on the shelf ──────────────────────────────────────────────
create or replace function public.stock_move_names_its_credit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_bill record;
begin
  if new.credit_bill_id is null then
    return new;
  end if;
  if new.kind <> 'supplier_return' then
    raise exception 'Only pieces going back to the supplier are tied to a credit.' using errcode = 'P0001';
  end if;
  -- The bill is locked, so the credit can't be moved onto a job while the return is being written.
  select id, org_id, amount, job_id, on_shelf, superseded_by_bill_id into v_bill
    from public.bills where id = new.credit_bill_id for update;
  if not found or v_bill.org_id is distinct from new.org_id then
    raise exception 'That credit isn''t in this company''s books.' using errcode = '42501';
  end if;
  if not (v_bill.amount < 0) then
    raise exception 'That bill isn''t a credit (it''s $%). Pick the supplier''s credit memo for the pieces that went back.', v_bill.amount
      using errcode = 'P0001';
  end if;
  if v_bill.superseded_by_bill_id is not null then
    raise exception 'That credit was set aside for a later bill. Tie the return to the one that replaced it.' using errcode = 'P0001';
  end if;
  if v_bill.job_id is not null or v_bill.on_shelf is not true then
    raise exception 'That credit is filed on a job, where it would come off the customer''s bill. A return of shelf stock is tied to a credit filed to the shelf.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.stock_move_names_its_credit() from public, anon, authenticated;
drop trigger if exists stock_move_names_its_credit on public.stock_moves;
create trigger stock_move_names_its_credit
  before insert on public.stock_moves
  for each row execute function public.stock_move_names_its_credit();

-- ── 4. a credit tied to a return stays the shelf's ─────────────────────────────────────────────
create or replace function public.guard_shelf_credit_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  select count(*)::integer into v_n
    from public.stock_moves m
   where m.credit_bill_id = old.id and m.kind = 'supplier_return' and m.undone_at is null;
  if v_n = 0 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This credit is tied to pieces returned from the shelf (Return To CED on Shop Stock). Undo that return first, then delete the credit.'
      using errcode = 'P0001';
  end if;
  if new.job_id is not null or new.on_shelf is not true or not (new.amount < 0)
     or new.superseded_by_bill_id is not null or new.org_id is distinct from old.org_id then
    raise exception 'This credit is tied to pieces returned from the shelf (Return To CED on Shop Stock), so it stays a credit on the shelf. Undo that return first, then change it.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.guard_shelf_credit_bill() from public, anon, authenticated;
drop trigger if exists guard_shelf_credit_bill on public.bills;
create trigger guard_shelf_credit_bill
  before update or delete on public.bills
  for each row execute function public.guard_shelf_credit_bill();

-- ── 5. every accountant download, remembered ───────────────────────────────────────────────────
create table if not exists public.accountant_exports (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  list        text not null,
  from_at     timestamptz,
  to_at       timestamptz not null,
  row_count   integer not null default 0,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  constraint accountant_exports_list check (list in ('stock_bought', 'stock_used', 'on_hand', 'tools')),
  constraint accountant_exports_window check (from_at is null or from_at < to_at)
);
create index if not exists accountant_exports_org_idx on public.accountant_exports (org_id, list, created_at);
comment on table public.accountant_exports is
  'One row per Export For Accountant download (0350): which list, the window it covered (from_at null = everything before to_at), who and when. Staff-only, append-only. A Stock Used or On Hand download freezes the upkeep moves it carried (guard_stock_move_exported).';

drop trigger if exists stamp_org_accountant_exports on public.accountant_exports;
create trigger stamp_org_accountant_exports before insert on public.accountant_exports for each row execute function public.set_org_id();

create or replace function public.guard_accountant_export()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'A download that went to your accountant stays on the record.' using errcode = 'P0001';
  end if;
  -- Who and when are the database's, never what the client sent. The wall clock, not the
  -- transaction's start: a download is "after" every move written before it, even one written
  -- earlier in the same transaction.
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := clock_timestamp();
  return new;
end $$;
revoke execute on function public.guard_accountant_export() from public, anon, authenticated;
drop trigger if exists guard_accountant_export on public.accountant_exports;
create trigger guard_accountant_export
  before insert or update or delete on public.accountant_exports
  for each row execute function public.guard_accountant_export();

alter table public.accountant_exports enable row level security;
revoke all on public.accountant_exports from anon;
revoke update, delete, truncate on public.accountant_exports from authenticated;
grant select, insert on public.accountant_exports to authenticated;
grant all on public.accountant_exports to service_role;
drop policy if exists accountant_exports_read on public.accountant_exports;
create policy accountant_exports_read on public.accountant_exports for select
  using (org_id = public.auth_org_id() and public.is_org_staff());
drop policy if exists accountant_exports_insert on public.accountant_exports;
create policy accountant_exports_insert on public.accountant_exports for insert
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- ── 6. what the accountant has stays put ───────────────────────────────────────────────────────
create or replace function public.guard_stock_move_exported()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_list text;
begin
  if old.undone_at is not null or new.undone_at is null
     or old.kind not in ('write_off', 'supplier_return', 'recount_down', 'recount_up') then
    return new;
  end if;
  select e.list into v_list
    from public.accountant_exports e
   where e.org_id = old.org_id
     and e.list in ('stock_used', 'on_hand')
     and e.created_at > old.created_at
     and old.created_at >= coalesce(e.from_at, '-infinity'::timestamptz)
     and old.created_at < e.to_at
   order by e.created_at
   limit 1;
  if found then
    -- No date in these words: the database's clock is UTC, and an evening download in the company's
    -- own zone would read as the next day. The app names the day, in the company's zone, before this.
    raise exception 'This already went to your accountant in the % list, so it stays as it is. Count the shelf (Count It) to put it right from today.',
      case v_list when 'stock_used' then 'Stock Used' else 'On Hand' end
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.guard_stock_move_exported() from public, anon, authenticated;
drop trigger if exists guard_stock_move_exported on public.stock_moves;
create trigger guard_stock_move_exported
  before update on public.stock_moves
  for each row execute function public.guard_stock_move_exported();

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'stock_moves' and column_name in ('credit_bill_id', 'credit_filed_by_return')) <> 2 then
    raise exception '0350: stock_moves.credit_bill_id or credit_filed_by_return is missing after the migration.';
  end if;
  if (select count(*) from pg_constraint
       where conname in ('stock_moves_credit_only_on_a_return', 'stock_moves_filed_names_its_credit', 'stock_moves_write_off_has_a_reason') and convalidated) <> 3 then
    raise exception '0350: the return and write-off constraints are not all in place and validated.';
  end if;
  if (select count(*) from pg_trigger
       where not tgisinternal
         and tgname in ('stock_move_names_its_credit', 'guard_shelf_credit_bill', 'guard_accountant_export', 'guard_stock_move_exported', 'stamp_org_accountant_exports')) <> 5 then
    raise exception '0350: not every trigger is in place.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.accountant_exports'::regclass) then
    raise exception '0350: RLS is not on for accountant_exports.';
  end if;
  if exists (select 1 from public.stock_moves where credit_bill_id is not null or credit_filed_by_return) then
    raise exception '0350: a move names a credit already; this migration writes none.';
  end if;
  raise notice '0350: returns can name a shelf credit, write-offs say why, and accountant downloads are remembered. No rows were written.';
end $$;
