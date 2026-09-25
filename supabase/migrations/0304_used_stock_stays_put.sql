-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0304: used stock stays put (Shop Stock, Phase 1 guards)
--
-- A take's stamped cost never moves after the fact (rule 2), and every piece traces to one ticket.
-- That is only true if the ticket underneath cannot change once a piece of it is on a job. And it
-- is not only the lot's own line: excludedReceiptCost shares UNTOUCHED tax across every excluded
-- line of the bill in proportion, so editing ANY line of the bill (or its untouched tax line)
-- moves the lot's tax share, and so its cost, after a take was stamped from it.
--
-- So, once any lot on a bill has live moves on it:
--   · no line of that bill may change amount, quantity, billable, billed_amount, is_stock, category
--     or bill_id, and none may be added or deleted (category because the tax share is decided by
--     it: a line that becomes "Tax" or stops being tax moves every lot's share);
--   · the bill may not be deleted, moved to another job, change its total (bills.amount is what
--     job cost reads), be taken off or put on the shelf, or be set aside as replaced by another bill;
--   · the lot may not change its pieces or cost, or come off the shelf.
-- Every refusal names the way out ("Undo the 3 takes from this roll first").
--
-- With NO takes yet, a money change to any line of a bill with lots marks those lots cost_stale,
-- so nothing goes silent: restampLotsForBill (src/lib/stock-ledger.ts) recomputes and clears it,
-- and stock_reconcile_problems names a stale lot until it does.
--
-- With no takes, a ticket's total may still change, but never below the rolls on the shelf from it.
-- Every check here first locks the ticket and its live rolls (lock_stock_bill), so an edit and a
-- take on the same ticket happen one after the other, never both on a stale count.
--
-- Two more: a bill that still has rolls on the shelf may not be set aside as replaced (job cost
-- would net its roll off a bill nobody counts any more; take the roll off first), and a stock item
-- with rolls on its record may not be deleted (mark it inactive).
--
-- 0260's guard_invoice_item_claim is NOT touched. It compares uuid[] overlap whatever table an id
-- came from, so a move id is claimed through it unchanged, and it is the double-bill boundary.
--
-- ORDER: with 0303, before any lot can exist. No data changes.
-- ═══════════════════════════════════════════════════════════════════════════

-- Live moves on the rolls a bill's lines put on the shelf.
create or replace function public.stock_takes_on_bill(p_bill uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.stock_moves m
    join public.stock_lots l on l.id = m.lot_id
    join public.bill_line_items bli on bli.id = l.bill_line_id
   where bli.bill_id = p_bill
     and m.undone_at is null;
$$;
revoke execute on function public.stock_takes_on_bill(uuid) from public, anon, authenticated;

create or replace function public.stock_takes_phrase(p_n integer)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_n = 1 then 'the take' else 'the ' || p_n || ' takes' end;
$$;
revoke execute on function public.stock_takes_phrase(integer) from public, anon, authenticated;

-- The ticket's shelf lock, then its live rolls, oldest first (the order a take locks them).
create or replace function public.lock_stock_bill(p_bill uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_bill is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('cn.stock_bill:' || p_bill::text));
  perform 1 from public.stock_lots l
   where l.unshelved_at is null
     and l.bill_line_id in (select bli.id from public.bill_line_items bli where bli.bill_id = p_bill)
   order by l.bought_on, l.created_at, l.id
     for update;
end $$;
revoke execute on function public.lock_stock_bill(uuid) from public, anon, authenticated;

-- ── a receipt line of a used ticket is frozen; of an unused one, its rolls go stale ─────────────
create or replace function public.freeze_used_stock_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill        uuid;
  v_other_bill  uuid;
  v_takes       integer := 0;
  v_money       boolean;
begin
  if tg_op = 'DELETE' then
    v_bill := old.bill_id;
    v_money := true;
  elsif tg_op = 'INSERT' then
    v_bill := new.bill_id;
    v_money := true;
  else
    v_bill := new.bill_id;
    if new.bill_id is distinct from old.bill_id then
      v_other_bill := old.bill_id;
    end if;
    v_money := (new.amount, new.quantity, new.billable, new.billed_amount, new.category, new.bill_id)
               is distinct from (old.amount, old.quantity, old.billable, old.billed_amount, old.category, old.bill_id);
    -- is_stock moving is the shelf itself changing (a roll on or off). Frozen once takes exist,
    -- never a reason to call the money stale.
    if not v_money and new.is_stock is not distinct from old.is_stock then
      return new;
    end if;
  end if;

  -- ONE AT A TIME WITH A TAKE. A take locks its roll (stamp_stock_move); this locks the ticket's
  -- live rolls before counting, and takes the ticket's shelf lock guard_stock_lot takes, so a
  -- receipt edit and a take (or a new roll) on the same ticket run one after the other and the
  -- second sees the first: the edit is refused, or the take is refused because the roll went stale.
  perform public.lock_stock_bill(v_bill);
  perform public.lock_stock_bill(v_other_bill);
  v_takes := public.stock_takes_on_bill(v_bill) + coalesce(public.stock_takes_on_bill(v_other_bill), 0);
  if v_takes > 0 then
    raise exception 'Pieces from this ticket''s roll are already on a job, so its lines can''t change. Undo % from this roll first, then change the ticket.',
      public.stock_takes_phrase(v_takes)
      using errcode = 'P0001';
  end if;

  if v_money then
    update public.stock_lots l set cost_stale = true
      from public.bill_line_items bli
     where bli.id = l.bill_line_id
       and bli.bill_id in (v_bill, v_other_bill)
       and l.unshelved_at is null
       and not l.cost_stale;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
revoke execute on function public.freeze_used_stock_line() from public, anon, authenticated;
drop trigger if exists freeze_used_stock_line on public.bill_line_items;
-- Named to sort BEFORE stock_line_deleted (0303), so a used ticket's line is refused before its
-- roll is touched.
create trigger freeze_used_stock_line
  before insert or update or delete on public.bill_line_items
  for each row execute function public.freeze_used_stock_line();

-- ── the ticket itself ──────────────────────────────────────────────────────────────────────────
create or replace function public.freeze_used_stock_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_takes integer;
  v_rolls numeric;
begin
  -- bills.amount is the number job cost reads (bills - off_shelf + from_shelf) and owner money
  -- splits into Materials and Put On The Shelf, so it is frozen with the lines. The date is not:
  -- a ticket re-dated carries its shelf part to the new month with it, and no take moves.
  if tg_op = 'UPDATE'
     and new.job_id is not distinct from old.job_id
     and new.on_shelf is not distinct from old.on_shelf
     and new.superseded_by_bill_id is not distinct from old.superseded_by_bill_id
     and new.org_id is not distinct from old.org_id
     and new.amount is not distinct from old.amount then
    return new;
  end if;

  perform public.lock_stock_bill(old.id);
  v_takes := public.stock_takes_on_bill(old.id);
  if v_takes > 0 then
    if tg_op = 'DELETE' then
      raise exception 'Pieces from this ticket''s roll are already on a job, so the ticket can''t be deleted. Undo % from this roll first.',
        public.stock_takes_phrase(v_takes) using errcode = 'P0001';
    end if;
    if new.amount is distinct from old.amount then
      raise exception 'Pieces from this ticket''s roll are already on a job, so its total can''t change. Undo % from this roll first, then change the ticket.',
        public.stock_takes_phrase(v_takes) using errcode = 'P0001';
    end if;
    raise exception 'Pieces from this ticket''s roll are already on a job, so the ticket stays where it is. Undo % from this roll first.',
      public.stock_takes_phrase(v_takes) using errcode = 'P0001';
  end if;

  -- With no takes yet: a ticket may not shrink below the rolls on the shelf from it, or the job
  -- that bought it would carry less than nothing (the same ceiling guard_stock_lot puts on a roll).
  if tg_op = 'UPDATE' and new.amount is distinct from old.amount then
    select coalesce(sum(l.cost), 0) into v_rolls
      from public.stock_lots l join public.bill_line_items bli on bli.id = l.bill_line_id
     where bli.bill_id = old.id and l.unshelved_at is null;
    if v_rolls > 0 and new.amount < v_rolls then
      raise exception 'The rolls on the shelf from this ticket cost $%, more than a $% ticket. Take a roll off the shelf first, then change the total.', v_rolls, new.amount
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.superseded_by_bill_id is not null and old.superseded_by_bill_id is null
     and exists (
       select 1 from public.stock_lots l join public.bill_line_items bli on bli.id = l.bill_line_id
        where bli.bill_id = old.id and l.unshelved_at is null
     ) then
    raise exception 'A roll from this ticket is on the shelf. Take it off the shelf first, then set the ticket aside.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
revoke execute on function public.freeze_used_stock_bill() from public, anon, authenticated;
drop trigger if exists freeze_used_stock_bill on public.bills;
create trigger freeze_used_stock_bill
  before update or delete on public.bills
  for each row execute function public.freeze_used_stock_bill();

-- ── the roll ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.freeze_used_stock_lot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_takes integer;
begin
  if new.pieces is not distinct from old.pieces
     and new.cost is not distinct from old.cost
     and not (new.unshelved_at is not null and old.unshelved_at is null) then
    return new;
  end if;
  select count(*)::integer into v_takes from public.stock_moves m where m.lot_id = old.id and m.undone_at is null;
  if v_takes > 0 then
    raise exception 'Pieces from this roll are already on a job, so it stays on the shelf as it is. Undo % from this roll first.',
      public.stock_takes_phrase(v_takes) using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.freeze_used_stock_lot() from public, anon, authenticated;
drop trigger if exists freeze_used_stock_lot on public.stock_lots;
create trigger freeze_used_stock_lot
  before update on public.stock_lots
  for each row execute function public.freeze_used_stock_lot();

-- ── the item ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.guard_stock_item_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.stock_lots l where l.item_id = old.id)
     or exists (select 1 from public.stock_moves m where m.item_id = old.id) then
    raise exception 'This item has rolls on the shelf''s record, so it can''t be deleted. Mark it inactive instead.'
      using errcode = 'P0001';
  end if;
  return old;
end $$;
revoke execute on function public.guard_stock_item_delete() from public, anon, authenticated;
drop trigger if exists guard_stock_item_delete on public.inventory_items;
create trigger guard_stock_item_delete
  before delete on public.inventory_items
  for each row execute function public.guard_stock_item_delete();

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare v integer;
begin
  select count(*) into v from pg_trigger
   where not tgisinternal and tgenabled <> 'D'
     and tgname in ('freeze_used_stock_line', 'freeze_used_stock_bill', 'freeze_used_stock_lot', 'guard_stock_item_delete');
  if v <> 4 then
    raise exception '0304: expected the four freeze triggers bound and enabled, found %.', v;
  end if;
  -- 0260 is the double-bill boundary: this migration must not have replaced it.
  if not exists (select 1 from pg_trigger where tgname = 'invoice_items_claim_is_a_boundary' and not tgisinternal) then
    raise exception '0304: the invoice claim trigger is missing.';
  end if;
  raise notice '0304: used stock stays put; unused stock goes stale on a receipt edit.';
end $$;
