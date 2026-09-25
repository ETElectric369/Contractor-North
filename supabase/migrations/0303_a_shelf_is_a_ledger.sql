-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0303: a shelf is a ledger (Shop Stock, Phase 1)
--
-- Erik, 2026-09-19, about the 500-count Twister box on Jason Waldow's receipt: "that is a whole
-- container of wire nuts that we use some of but is certainly stock and shouldn't be charged to the
-- customer in full". 0272 answered the CUSTOMER half (billed_amount: bill only what the job used).
-- The COST half never moved: job cost still reads bills.amount, so the whole box sits on the job
-- that bought it while the next three jobs use nuts they never paid for. The same is true of the
-- two Herringbone 12/2 coils and the 14/2 coil. This is the ledger that lets cost follow the piece.
--
-- THE SHAPE (the approved plan, Design B):
--   · a LOT is one purchase put on the shelf: a receipt line (kind 'line') or a counted opening
--     balance with a typed cost and a note (kind 'opening'). Its cost is what the paper says that
--     line cost the company, tax share included (shelfLotCost in src/lib/bill-itemisation.ts, the
--     ONE copy of the tax arithmetic), capped here at the paper so a lot is never worth more than
--     the receipt it came off.
--   · a MOVE is pieces leaving or coming back: draw (onto a job), short (taken past the shelf, $0
--     until a roll is filed), job_return, recount_down / recount_up, write_off, supplier_return.
--     Its cost is STAMPED by the database from the lot (FIFO, never an average), and a client
--     value is overwritten. The move that empties a lot takes the lot's exact remaining dollars.
--     Moves are append-only: nothing is deleted, an undo is a timestamp.
--   · money is numeric(12,2) like bills, bill_line_items and invoice_items. No cents integers.
--
-- WHAT THIS CHANGES TODAY: nothing on any screen. There are zero lots and zero moves in every org
-- (checked at the bottom), bills.on_shelf is false everywhere, and every job-cost reader in the
-- same release computes bills.amount - off_shelf + from_shelf = bills.amount - 0 + 0.
--
-- WHO SEES WHAT (rule 7): stock_lots and stock_moves are staff-only under RLS, like the money
-- tables they are. A tech takes pieces ONLY through stock_draw (SECURITY DEFINER), which returns
-- quantities and never a cost to a non-staff caller; shelf_for_crew (0302) is the tech's read.
--
-- ORDER: after 0302. Apply BEFORE the Phase 1 code deploys: the code reads job_shelf_net and
-- bills.on_shelf, and treats a missing view as "no lots yet" only so a deploy window cannot take
-- a page down. The inventory doors in the same release stop writing quantity_on_hand, which this
-- migration makes a cache the app may not write. Anything main's old doors wrote before the apply
-- is carried over (section 13), with a notice per row. BETWEEN the apply and the deploy those old
-- doors are refused out loud (the receipt card's "goes in your stock", a typed count), so keep that
-- gap short: apply, then deploy. Pre-apply check, read-only:
--   select count(*) from bill_line_items where is_stock;               -- lines section 13 clears
--   select count(*) from inventory_items where quantity_on_hand <> 0;  -- counts it carries over
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. bills.on_shelf: a ticket bought for the shelf, not for a job ──────────────────────────────
-- A real flag, never a category word: bucketOf sends an unknown category to "Other", so a word
-- would quietly make a shelf purchase a business cost.
alter table public.bills add column if not exists on_shelf boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bills_on_shelf_has_no_job') then
    alter table public.bills
      add constraint bills_on_shelf_has_no_job check (not (on_shelf and job_id is not null));
  end if;
end $$;
comment on column public.bills.on_shelf is
  'A ticket bought for the shop shelf, not a job (0303). Never a job cost and never a business-cost bucket: owner money counts it as Put On The Shelf in the month bought. Requires job_id null.';

-- ── 2. inventory_items is the ITEM ───────────────────────────────────────────────────────────────
alter table public.inventory_items
  add column if not exists key_part text,
  add column if not exists price_item_id uuid references public.price_list_items(id) on delete set null;
create unique index if not exists inventory_items_org_key_part_uidx
  on public.inventory_items (org_id, key_part) where key_part is not null;
-- The on-hand cache holds what the ledger holds: pieces to the thousandth (stock_lots.pieces and
-- stock_moves.qty are numeric(14,3)). At 2 decimals a 12.125 ft lot cached as 12.13 and the
-- reconcile view named that drift forever. No view reads the column; a type change is cheap.
alter table public.inventory_items alter column quantity_on_hand type numeric(14,3);
comment on column public.inventory_items.key_part is
  'The normalised supplier part number or price-list code this item is matched on (0303). Matching is part number, then price-list code, then exact name. Never fuzzy.';
comment on column public.inventory_items.quantity_on_hand is
  'A CACHE kept by the shelf''s own record (0303): live lot pieces left, plus found pieces, less pieces taken past the shelf. The app never writes it; a direct write is refused.';
comment on column public.inventory_items.unit_cost is
  'DEPRECATED (0303): cost lives on stock_lots now, per purchase, to the cent. No longer written; to be dropped.';

-- ── 3. stock_lots: one purchase on the shelf ────────────────────────────────────────────────────
create table if not exists public.stock_lots (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  item_id       uuid not null references public.inventory_items(id),
  kind          text not null default 'line',
  -- ON DELETE SET NULL, and only ever on a lot already unshelved: a receipt line that is deleted
  -- unshelves its take-less lot first (stock_line_deleted below), so the history survives the
  -- paper. A lot with live takes freezes its bill instead (0304).
  bill_line_id  uuid references public.bill_line_items(id) on delete set null,
  pieces        numeric(14,3) not null,
  unit          text not null,
  cost          numeric(12,2) not null,
  bought_on     date,
  note          text,
  cost_stale    boolean not null default false,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  unshelved_at  timestamptz,
  unshelved_by  uuid,
  constraint stock_lots_kind check (kind in ('line', 'opening')),
  constraint stock_lots_pieces_positive check (pieces > 0),
  constraint stock_lots_cost_not_negative check (cost >= 0),
  constraint stock_lots_unit_named check (length(btrim(unit)) > 0),
  constraint stock_lots_line_shape check (
       (kind = 'line' and (bill_line_id is not null or unshelved_at is not null))
    or (kind = 'opening' and bill_line_id is null and length(btrim(coalesce(note, ''))) > 0)
  )
);
create unique index if not exists stock_lots_one_live_per_line
  on public.stock_lots (bill_line_id) where unshelved_at is null and bill_line_id is not null;
create index if not exists stock_lots_item_live_idx on public.stock_lots (item_id, bought_on, created_at) where unshelved_at is null;
create index if not exists stock_lots_org_idx on public.stock_lots (org_id);
comment on table public.stock_lots is
  'One purchase on the shop shelf (0303): a receipt line (kind line) or a counted opening balance (kind opening, typed cost + note). cost = shelfLotCost, capped at the paper. Staff-only.';

-- ── 4. stock_moves: the ledger ───────────────────────────────────────────────────────────────────
create table if not exists public.stock_moves (
  id               uuid primary key default gen_random_uuid(),   -- also the invoice claim key
  org_id           uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id),
  lot_id           uuid references public.stock_lots(id),
  job_id           uuid references public.jobs(id),
  draw_group       uuid,
  kind             text not null,
  qty              numeric(14,3) not null,
  cost             numeric(12,2) not null default 0,
  source           text not null default 'office',
  note             text,
  returns_move_id  uuid references public.stock_moves(id),
  settled_by       uuid,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  undone_at        timestamptz,
  undone_by        uuid,
  constraint stock_moves_kind check (kind in ('draw', 'short', 'job_return', 'recount_down', 'recount_up', 'write_off', 'supplier_return')),
  constraint stock_moves_qty_positive check (qty > 0),
  constraint stock_moves_cost_not_negative check (cost >= 0),
  constraint stock_moves_source check (source in ('tray', 'bill_line', 'crew', 'office', 'nort')),
  constraint stock_moves_lot_shape check (lot_id is not null or kind in ('short', 'recount_up')),
  constraint stock_moves_short_has_no_lot check (kind <> 'short' or lot_id is null),
  constraint stock_moves_job_shape check ((kind in ('draw', 'short', 'job_return')) = (job_id is not null)),
  constraint stock_moves_return_names_a_draw check ((kind = 'job_return') = (returns_move_id is not null)),
  constraint stock_moves_settled_only_shorts check (settled_by is null or kind = 'short'),
  constraint stock_moves_takes_are_grouped check (kind not in ('draw', 'short') or draw_group is not null),
  constraint stock_moves_undone_by_with_undone_at check (undone_by is null or undone_at is not null)
);
create index if not exists stock_moves_lot_live_idx on public.stock_moves (lot_id) where undone_at is null;
create index if not exists stock_moves_job_idx on public.stock_moves (job_id) where job_id is not null;
create index if not exists stock_moves_group_idx on public.stock_moves (draw_group) where draw_group is not null;
create index if not exists stock_moves_item_idx on public.stock_moves (item_id);
create index if not exists stock_moves_returns_idx on public.stock_moves (returns_move_id) where returns_move_id is not null;
comment on table public.stock_moves is
  'The shop shelf''s ledger (0303). Append-only: an undo is undone_at, never a delete. cost is stamped by stamp_stock_move from the lot (FIFO), never taken from a client. id is the invoice claim key.';

drop trigger if exists stamp_org_stock_lots on public.stock_lots;
create trigger stamp_org_stock_lots before insert on public.stock_lots for each row execute function public.set_org_id();
drop trigger if exists stamp_org_stock_moves on public.stock_moves;
create trigger stamp_org_stock_moves before insert on public.stock_moves for each row execute function public.set_org_id();

-- What a receipt line does NOT bill the job, in dollars: the SQL twin of notBilledCost in
-- src/lib/bill-itemisation.ts (billable off = the whole line; billed_amount = what the job used,
-- clamped to the line; a blank, a negative, or a line that costs nothing = billed in full).
-- A roll can only come off what the job does not bill.
create or replace function public.stock_line_not_billed(p_amount numeric, p_billable boolean, p_billed numeric)
returns numeric
language sql
immutable
set search_path = public
as $$
  select round(coalesce(p_amount, 0)
               - case when p_billable is false then 0
                      when p_billed is null or p_billed < 0 or not (coalesce(p_amount, 0) > 0) then coalesce(p_amount, 0)
                      else least(round(p_billed, 2), round(p_amount, 2)) end, 2);
$$;

-- ── 5. what is left on a lot ─────────────────────────────────────────────────────────────────────
-- Consuming moves take pieces AND their stamped dollars off; a job_return puts both back; a found
-- piece (recount_up) puts pieces back with no dollars (there is no paper for it).
create or replace function public.stock_lot_left(p_lot uuid, out pieces_left numeric, out cost_left numeric)
language sql
stable
security definer
set search_path = public
as $$
  select l.pieces
           - coalesce(sum(m.qty) filter (where m.kind in ('draw', 'write_off', 'supplier_return', 'recount_down')), 0)
           + coalesce(sum(m.qty) filter (where m.kind in ('job_return', 'recount_up')), 0),
         l.cost
           - coalesce(sum(m.cost) filter (where m.kind in ('draw', 'write_off', 'supplier_return', 'recount_down')), 0)
           + coalesce(sum(m.cost) filter (where m.kind = 'job_return'), 0)
    from public.stock_lots l
    left join public.stock_moves m on m.lot_id = l.id and m.undone_at is null
   where l.id = p_lot
   group by l.id, l.pieces, l.cost;
$$;
revoke execute on function public.stock_lot_left(uuid) from public, anon, authenticated;

-- The on-hand cache. Written only here, with the one setting the item guard lets through.
create or replace function public.refresh_stock_on_hand(p_item uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v numeric;
begin
  if p_item is null then
    return;
  end if;
  select coalesce((select sum(x.pieces_left)
                     from public.stock_lots l
                     cross join lateral public.stock_lot_left(l.id) x
                    where l.item_id = p_item and l.unshelved_at is null), 0)
       + coalesce((select sum(m.qty) from public.stock_moves m
                    where m.item_id = p_item and m.lot_id is null and m.kind = 'recount_up' and m.undone_at is null), 0)
       - coalesce((select sum(m.qty) from public.stock_moves m
                    where m.item_id = p_item and m.kind = 'short' and m.undone_at is null and m.settled_by is null), 0)
    into v;
  perform set_config('cn.stock_cache', 'on', true);
  update public.inventory_items set quantity_on_hand = v
   where id = p_item and quantity_on_hand is distinct from v;
  perform set_config('cn.stock_cache', '', true);
end $$;
revoke execute on function public.refresh_stock_on_hand(uuid) from public, anon, authenticated;

-- ── 6. the item: its count is the ledger's, never typed ─────────────────────────────────────────
create or replace function public.guard_stock_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_cache boolean := coalesce(current_setting('cn.stock_cache', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if coalesce(new.quantity_on_hand, 0) <> 0 and not v_cache then
      raise exception 'A new stock item starts with none on hand. Its count comes from what goes on the shelf, so put the roll or box on the shelf instead of typing a number.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.quantity_on_hand is distinct from old.quantity_on_hand and not v_cache then
    raise exception 'What is on hand is kept by the shelf''s own record now, so it can''t be typed over. Count it on Shop Stock instead.'
      using errcode = 'P0001';
  end if;
  if (new.unit is distinct from old.unit or new.org_id is distinct from old.org_id)
     and exists (select 1 from public.stock_lots l where l.item_id = old.id) then
    raise exception 'This item already has rolls on the shelf counted in %, so its unit can''t change. Make a new item for the new unit.', old.unit
      using errcode = 'P0001';
  end if;
  return new;
end $$;
-- The price-list link is this company's own price list, or nothing: a foreign key only asks that
-- the row EXISTS, so without this an item could point at another company's price book (and the key
-- error would say whether a guessed id is in it). One refusal for "missing" and "someone else's".
create or replace function public.guard_stock_item_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.price_item_id is not null
     and (tg_op = 'INSERT' or new.price_item_id is distinct from old.price_item_id or new.org_id is distinct from old.org_id)
     -- org_id may still be blank here: this fires before stamp_org_inventory_items fills it in.
     and not exists (select 1 from public.price_list_items p
                      where p.id = new.price_item_id and p.org_id = coalesce(new.org_id, public.auth_org_id())) then
    raise exception 'That price-list item isn''t in this company''s price list.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.guard_stock_item_price() from public, anon, authenticated;
drop trigger if exists guard_stock_item_price on public.inventory_items;
create trigger guard_stock_item_price
  before insert or update on public.inventory_items
  for each row execute function public.guard_stock_item_price();
revoke execute on function public.guard_stock_item() from public, anon, authenticated;
drop trigger if exists guard_stock_item on public.inventory_items;
create trigger guard_stock_item
  before insert or update on public.inventory_items
  for each row execute function public.guard_stock_item();

-- ── 7. a lot: capped at the paper, in the item's unit ───────────────────────────────────────────
create or replace function public.guard_stock_lot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item   record;
  v_line   record;
  v_tax    numeric;
  v_free   numeric;
  v_room   numeric;
  v_others numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'A roll leaves the shelf by being taken off it, never deleted, so its history stays.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    -- WHO FIRST. This runs as the definer and BEFORE row security judges the row, so without this a
    -- tech (or another company's office) could send any receipt line id and read its dollars back
    -- out of the cap's refusal. Only this company's office puts a roll on the shelf.
    if auth.uid() is not null
       and (not public.is_org_staff() or new.org_id is distinct from public.auth_org_id()) then
      raise exception 'Only the office puts rolls on this company''s shelf.' using errcode = '42501';
    end if;
    -- Who did it is the signed-in person, never what the client typed.
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;

  if tg_op = 'UPDATE' then
    -- What a lot IS never changes. Only its money (restamp, before any take), its stale flag, its
    -- note and its unshelving may; the line link may only fall away once it is unshelved.
    if new.id is distinct from old.id or new.org_id is distinct from old.org_id
       or new.item_id is distinct from old.item_id or new.kind is distinct from old.kind
       or new.unit is distinct from old.unit or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at
       or (new.bill_line_id is distinct from old.bill_line_id and not (new.bill_line_id is null and new.unshelved_at is not null)) then
      raise exception 'A roll on the shelf keeps its item, its unit and its receipt line. Take it off the shelf and put it on again instead.'
        using errcode = 'P0001';
    end if;
    if old.unshelved_at is not null
       and (new.unshelved_at is distinct from old.unshelved_at or new.cost is distinct from old.cost
            or new.pieces is distinct from old.pieces) then
      raise exception 'That roll is already off the shelf. Put the receipt line on the shelf again to count it.'
        using errcode = 'P0001';
    end if;
    if new.unshelved_at is not null and old.unshelved_at is null then
      new.unshelved_by := coalesce(auth.uid(), new.unshelved_by);
    end if;
  end if;

  select id, org_id, unit, active into v_item from public.inventory_items where id = new.item_id;
  if not found or v_item.org_id is distinct from new.org_id then
    raise exception 'That stock item isn''t in this company.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.unit is distinct from v_item.unit then
      raise exception 'This roll is counted in % and the item is counted in %. Count it in % or use another item.', new.unit, v_item.unit, v_item.unit
        using errcode = 'P0001';
    end if;
    if new.unshelved_at is not null then
      raise exception 'A new roll goes on the shelf, not off it.' using errcode = 'P0001';
    end if;
  end if;

  -- The paper checks run when a lot is written or its money changes. A stale-flag or unshelving
  -- update never re-judges the paper: a receipt edited after the roll went on the shelf marks the
  -- roll stale (0304) and the reconcile view says so until it is restamped. Refusing the flag would
  -- refuse the receipt edit itself, which is the one thing that has to stay possible.
  if new.kind = 'line' and new.bill_line_id is not null
     and (tg_op = 'INSERT' or new.cost is distinct from old.cost or new.pieces is distinct from old.pieces) then
    -- The line is locked, then the bill's shelf lock is taken, so two rolls put on one ticket, or a
    -- roll and an edit of what the job used, happen one after the other and each sees the other.
    select l.id, l.org_id, l.amount, l.category, l.billable, l.billed_amount, l.bill_id,
           b.org_id as bill_org, b.amount as bill_amount, b.bill_date, b.created_at as bill_created,
           b.superseded_by_bill_id
      into v_line
      from public.bill_line_items l
      join public.bills b on b.id = l.bill_id
     where l.id = new.bill_line_id
       for update of l;
    if not found or v_line.org_id is distinct from new.org_id or v_line.bill_org is distinct from new.org_id then
      raise exception 'That receipt line isn''t in this company.' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('cn.stock_bill:' || v_line.bill_id::text));
    if coalesce(v_line.category, '') ~* 'tax' then
      raise exception 'Sales tax isn''t a thing on a shelf. It rides with the lines it was charged on.' using errcode = 'P0001';
    end if;
    -- THE EXTENSION IS THE PRICE (0274/0275): a $0.00 extension means nothing shipped.
    if not (v_line.amount > 0) then
      raise exception 'That line''s extension is $0.00, which means nothing shipped, so nothing from it can go on the shelf.'
        using errcode = 'P0001';
    end if;
    if tg_op = 'INSERT' and v_line.superseded_by_bill_id is not null then
      raise exception 'That receipt has been replaced by a later bill. Put the line on the shelf from the bill that replaced it.'
        using errcode = 'P0001';
    end if;
    -- A roll comes off what the job does NOT bill (0272's billed_amount). A line still billed in
    -- full is on the customer's invoice; the same dollars on the shelf would be counted twice.
    v_free := public.stock_line_not_billed(v_line.amount, v_line.billable, v_line.billed_amount);
    if not (v_free > 0) then
      raise exception 'This whole line is still billed to the job. Say how much this job used first, so the rest can go on the shelf.'
        using errcode = 'P0001';
    end if;
    -- THE PAPER IS THE CEILING, twice. shelfLotCost (the one copy of the arithmetic, in TypeScript)
    -- is always under both; the caps are what stop a lot written any other way from being worth
    -- more than the receipt it came off.
    --   · this roll: what its line does not bill, plus every cent of tax on its bill;
    --   · every live roll on the ticket together: what the ticket's lines do not bill plus its tax,
    --     and never more than the ticket itself, or the job that bought it would carry less than $0.
    select coalesce(sum(t.amount), 0) into v_tax
      from public.bill_line_items t
     where t.bill_id = v_line.bill_id and coalesce(t.category, '') ~* 'tax';
    if new.cost > v_free + greatest(v_tax, 0) then
      raise exception 'A roll can''t be worth more than its receipt: this line and its tax come to $%, and the roll says $%.', v_free + greatest(v_tax, 0), new.cost
        using errcode = 'P0001';
    end if;
    select least(coalesce(sum(greatest(public.stock_line_not_billed(t.amount, t.billable, t.billed_amount), 0))
                            filter (where coalesce(t.category, '') !~* 'tax'), 0) + greatest(v_tax, 0),
                 v_line.bill_amount)
      into v_room
      from public.bill_line_items t
     where t.bill_id = v_line.bill_id;
    select coalesce(sum(o.cost), 0) into v_others
      from public.stock_lots o
      join public.bill_line_items ob on ob.id = o.bill_line_id
     where ob.bill_id = v_line.bill_id and o.unshelved_at is null and o.id <> new.id;
    if v_others + new.cost > v_room then
      raise exception 'A roll can''t be worth more than its receipt: the rolls from this ticket would come to $%, and the ticket only holds $% the job doesn''t bill.', v_others + new.cost, v_room
        using errcode = 'P0001';
    end if;
    if new.bought_on is null then
      new.bought_on := coalesce(v_line.bill_date, (v_line.bill_created at time zone 'UTC')::date);
    end if;
  elsif new.bought_on is null then
    new.bought_on := current_date;
  end if;
  return new;
end $$;
revoke execute on function public.guard_stock_lot() from public, anon, authenticated;
drop trigger if exists guard_stock_lot on public.stock_lots;
create trigger guard_stock_lot
  before insert or update or delete on public.stock_lots
  for each row execute function public.guard_stock_lot();

-- After a lot changes: its receipt line says whether a roll from it is on the shelf (is_stock is a
-- mirror now, never a separate decision), and the item's on-hand cache is refreshed.
create or replace function public.stock_lot_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_live boolean;
begin
  if new.bill_line_id is not null
     and coalesce(current_setting('cn.stock_skip_line', true), '') is distinct from new.bill_line_id::text then
    v_live := exists (select 1 from public.stock_lots l where l.bill_line_id = new.bill_line_id and l.unshelved_at is null);
    update public.bill_line_items set is_stock = v_live
     where id = new.bill_line_id and is_stock is distinct from v_live;
  end if;
  if tg_op = 'UPDATE' and old.bill_line_id is not null and old.bill_line_id is distinct from new.bill_line_id
     and coalesce(current_setting('cn.stock_skip_line', true), '') is distinct from old.bill_line_id::text then
    v_live := exists (select 1 from public.stock_lots l where l.bill_line_id = old.bill_line_id and l.unshelved_at is null);
    update public.bill_line_items set is_stock = v_live
     where id = old.bill_line_id and is_stock is distinct from v_live;
  end if;
  perform public.refresh_stock_on_hand(new.item_id);
  return null;
end $$;
revoke execute on function public.stock_lot_after() from public, anon, authenticated;
drop trigger if exists stock_lot_after on public.stock_lots;
create trigger stock_lot_after
  after insert or update on public.stock_lots
  for each row execute function public.stock_lot_after();

-- ── 8. a receipt line: is_stock only while a roll from it is on the shelf ──────────────────────
create or replace function public.guard_stock_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_stock and not exists (
    select 1 from public.stock_lots l where l.bill_line_id = new.id and l.unshelved_at is null
  ) then
    raise exception 'A receipt line is shop stock only while a roll from it is on the shelf. Put it on the shelf, and this is marked for you.'
      using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.is_stock and not new.is_stock and exists (
    select 1 from public.stock_lots l where l.bill_line_id = new.id and l.unshelved_at is null
  ) then
    raise exception 'A roll from this line is on the shelf. Take it off the shelf first, and this is cleared for you.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.guard_stock_line() from public, anon, authenticated;
drop trigger if exists guard_stock_line on public.bill_line_items;
create trigger guard_stock_line
  before insert or update of is_stock on public.bill_line_items
  for each row execute function public.guard_stock_line();

-- A line that is deleted takes its take-less roll off the shelf first, so the lot keeps its history
-- and the foreign key can let go of the line. A roll with live takes never gets here: 0304 freezes
-- the whole bill once any piece of it is on a job.
create or replace function public.stock_line_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.stock_lots l where l.bill_line_id = old.id and l.unshelved_at is null) then
    perform set_config('cn.stock_skip_line', old.id::text, true);
    update public.stock_lots set unshelved_at = now(), unshelved_by = auth.uid()
     where bill_line_id = old.id and unshelved_at is null;
    perform set_config('cn.stock_skip_line', '', true);
  end if;
  return old;
end $$;
revoke execute on function public.stock_line_deleted() from public, anon, authenticated;
drop trigger if exists stock_line_deleted on public.bill_line_items;
create trigger stock_line_deleted
  before delete on public.bill_line_items
  for each row execute function public.stock_line_deleted();

-- ── 9. a move: its cost is stamped here, from the lot ───────────────────────────────────────────
create or replace function public.stamp_stock_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item    record;
  v_lot     record;
  v_left    record;
  v_draw    record;
  v_back_q  numeric;
  v_back_c  numeric;
begin
  -- WHO FIRST. This runs as the definer and BEFORE row security judges the row, so a caller the
  -- insert policy would refuse must be refused here, before any lookup can answer them anything:
  -- another company's session, and a tech outside stock_draw (the one way the crew takes pieces,
  -- which says so with the transaction-local cn.stock_rpc).
  if auth.uid() is not null then
    if new.org_id is distinct from public.auth_org_id() then
      raise exception 'That isn''t this company''s shelf.' using errcode = '42501';
    end if;
    if not public.is_org_staff() and coalesce(current_setting('cn.stock_rpc', true), '') <> 'on' then
      raise exception 'Pieces come off the shelf with Took From Stock. The shelf''s record isn''t written directly.'
        using errcode = '42501';
    end if;
  end if;

  -- Nothing about the money, the undo or the settlement comes from the client.
  new.cost := 0;
  new.undone_at := null;
  new.undone_by := null;
  new.settled_by := null;
  new.created_at := now();
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.qty := round(new.qty, 3);

  if new.kind = 'job_return' then
    select id, org_id, item_id, lot_id, job_id, kind, qty, cost, undone_at into v_draw
      from public.stock_moves where id = new.returns_move_id for update;
    if not found or v_draw.org_id is distinct from new.org_id or v_draw.kind <> 'draw' or v_draw.undone_at is not null then
      raise exception 'Pieces can only come back from a take that is still on a job.' using errcode = 'P0001';
    end if;
    new.item_id := v_draw.item_id;
    new.lot_id := v_draw.lot_id;
    new.job_id := v_draw.job_id;
  end if;

  select id, org_id, unit, name into v_item from public.inventory_items where id = new.item_id;
  if not found or v_item.org_id is distinct from new.org_id then
    raise exception 'That stock item isn''t in this company.' using errcode = '42501';
  end if;
  if new.job_id is not null and not exists (
    select 1 from public.jobs j where j.id = new.job_id and j.org_id = new.org_id
  ) then
    raise exception 'That job isn''t in this company.' using errcode = '42501';
  end if;

  if new.lot_id is not null then
    select id, org_id, item_id, pieces, cost, unshelved_at, cost_stale into v_lot
      from public.stock_lots where id = new.lot_id for update;
    if not found or v_lot.org_id is distinct from new.org_id or v_lot.item_id is distinct from new.item_id then
      raise exception 'That roll isn''t this item''s.' using errcode = 'P0001';
    end if;
    if v_lot.unshelved_at is not null then
      raise exception 'That roll is off the shelf, so nothing can move on it.' using errcode = 'P0001';
    end if;
    select * into v_left from public.stock_lot_left(new.lot_id);
  end if;

  if new.kind in ('draw', 'write_off', 'supplier_return', 'recount_down') then
    if new.lot_id is null then
      raise exception 'Say which roll these pieces come off.' using errcode = 'P0001';
    end if;
    -- A stale roll's cost is known to be wrong (its receipt changed after it went on the shelf,
    -- 0304). Stamping a take from it would freeze the wrong figure onto a job for good.
    if v_lot.cost_stale then
      raise exception 'That roll''s receipt changed after it went on the shelf, so its cost is being worked out again. Restamp it from its receipt first.'
        using errcode = 'P0001';
    end if;
    if new.qty > v_left.pieces_left then
      raise exception 'Only % % left on that roll, so % can''t come off it.', v_left.pieces_left, v_item.unit, new.qty
        using errcode = 'P0001';
    end if;
    -- FIFO by lot, never an average. The move that empties the lot takes its exact remaining
    -- dollars, so a lot always adds back up to what it cost to the cent.
    if new.qty = v_left.pieces_left then
      new.cost := v_left.cost_left;
    else
      new.cost := least(round(new.qty * v_lot.cost / v_lot.pieces, 2), v_left.cost_left);
    end if;
  elsif new.kind = 'job_return' then
    select coalesce(sum(r.qty), 0), coalesce(sum(r.cost), 0) into v_back_q, v_back_c
      from public.stock_moves r
     where r.returns_move_id = v_draw.id and r.kind = 'job_return' and r.undone_at is null;
    if new.qty > v_draw.qty - v_back_q then
      raise exception 'Only % % of that take are still on the job, so % can''t come back.', v_draw.qty - v_back_q, v_item.unit, new.qty
        using errcode = 'P0001';
    end if;
    if new.qty = v_draw.qty - v_back_q then
      new.cost := v_draw.cost - v_back_c;
    else
      new.cost := least(round(new.qty * v_draw.cost / v_draw.qty, 2), v_draw.cost - v_back_c);
    end if;
  else
    -- short and recount_up: pieces with no paper behind them cost nothing. A short is settled into
    -- real draws once the roll is filed (settle_short), never priced by guess.
    new.cost := 0;
  end if;
  return new;
end $$;
revoke execute on function public.stamp_stock_move() from public, anon, authenticated;
drop trigger if exists stamp_stock_move on public.stock_moves;
create trigger stamp_stock_move
  before insert on public.stock_moves
  for each row execute function public.stamp_stock_move();

-- Append-only: no delete, and an update may only set undone_at/undone_by once, or settled_by once.
-- A draw or a short is written only by stock_draw / settle_short, so it is undone and settled only
-- by stock_undo / settle_short too: they say so with the transaction-local cn.stock_rpc. The staff
-- update policy is there for the office's own upkeep moves (a count, a write-off, a return).
create or replace function public.guard_stock_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_holder text;
  v_rpc    boolean := coalesce(current_setting('cn.stock_rpc', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    raise exception 'The shelf''s record is never deleted. Undo the take instead.' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'undone_at' - 'undone_by' - 'settled_by') is distinct from (to_jsonb(old) - 'undone_at' - 'undone_by' - 'settled_by') then
    raise exception 'A take on the shelf''s record can''t be changed, only undone.' using errcode = 'P0001';
  end if;
  if new.settled_by is distinct from old.settled_by then
    if old.settled_by is not null or new.settled_by is null or old.kind <> 'short' or old.undone_at is not null then
      raise exception 'Pieces taken past the shelf are settled once, from a roll.' using errcode = 'P0001';
    end if;
    -- Only settle_short names the draws that settle a short. Any other uuid would take the pieces
    -- out of on hand and out of the reconcile view with nothing on the job behind them.
    if auth.uid() is not null and not v_rpc then
      raise exception 'Pieces taken past the shelf are settled with Settle, from a roll on the shelf.' using errcode = 'P0001';
    end if;
  end if;
  if new.undone_at is distinct from old.undone_at or new.undone_by is distinct from old.undone_by then
    if old.undone_at is not null or new.undone_at is null then
      raise exception 'That take is already undone.' using errcode = 'P0001';
    end if;
    -- Who undid it is the signed-in person, never what the client typed.
    new.undone_by := coalesce(auth.uid(), new.undone_by);
    -- A piece an invoice bills stays on the job until the invoice lets go of it (the 0261 law).
    v_holder := public.invoice_holding_claim(array[old.id], old.org_id);
    if v_holder is not null then
      raise exception '% already bills these pieces. Take them off % first, then undo.', v_holder, v_holder
        using errcode = 'P0001';
    end if;
    if old.kind = 'draw' and exists (
      select 1 from public.stock_moves r where r.returns_move_id = old.id and r.undone_at is null
    ) then
      raise exception 'Some of these pieces were already brought back to the shelf. Undo that first.' using errcode = 'P0001';
    end if;
    -- A take is undone whole, by stock_undo, which also undoes the draws that settled a short in it
    -- and refuses to undo a settlement on its own.
    if old.kind in ('draw', 'short') and auth.uid() is not null and not v_rpc then
      raise exception 'A take is undone with Undo, which undoes the whole of it.' using errcode = 'P0001';
    end if;
    -- NO LOT BELOW EMPTY, ONE AT A TIME. An undo can lower what a roll has left (a return or a found
    -- piece taken back). A take locks the roll; so does this, so the check in stock_move_after runs
    -- after the other has committed and sees it.
    if old.lot_id is not null then
      perform 1 from public.stock_lots where id = old.lot_id for update;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_stock_move() from public, anon, authenticated;
drop trigger if exists guard_stock_move on public.stock_moves;
create trigger guard_stock_move
  before update or delete on public.stock_moves
  for each row execute function public.guard_stock_move();

-- No lot below zero, by pieces or by dollars, whatever order moves and undos arrive in; and no lot
-- empty with money still on it, which no take could ever reach (undoing a found piece after the
-- takes that followed it is the way there: 3 pieces at $10, 3 found, three $3.33 takes, undo).
create or replace function public.stock_move_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_left record;
begin
  if new.lot_id is not null then
    select * into v_left from public.stock_lot_left(new.lot_id);
    if v_left.pieces_left < 0 or v_left.cost_left < 0 then
      raise exception 'That would leave the roll below empty. Nothing was changed.' using errcode = 'P0001';
    end if;
    if v_left.pieces_left = 0 and v_left.cost_left <> 0 then
      raise exception 'That would leave the roll empty with $% still on it. Count the roll down instead, so those cents land somewhere.', v_left.cost_left
        using errcode = 'P0001';
    end if;
  end if;
  perform public.refresh_stock_on_hand(new.item_id);
  return null;
end $$;
revoke execute on function public.stock_move_after() from public, anon, authenticated;
drop trigger if exists stock_move_after on public.stock_moves;
create trigger stock_move_after
  after insert or update on public.stock_moves
  for each row execute function public.stock_move_after();

-- ── 10. the take: FIFO across lots, one group, a short past the shelf ───────────────────────────
-- Internal: walk the item's live lots oldest first and write one draw per lot touched. Returns
-- the moves written and how much could NOT be covered. Callers hold the item lock and set
-- cn.stock_rpc. A STALE roll (its receipt changed after it went on the shelf; stamp_stock_move
-- refuses to price from it) is stepped over: the take still saves, the rest is a $0 short the office
-- settles once the roll is restamped, never a dead end in the field.
create or replace function public.stock_take_fifo(
  p_org uuid, p_item uuid, p_job uuid, p_qty numeric, p_group uuid, p_source text, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rem    numeric := p_qty;
  v_lot    record;
  v_left   record;
  v_take   numeric;
  v_id     uuid;
  v_cost   numeric;
  v_moves  jsonb := '[]'::jsonb;
  v_total  numeric := 0;
begin
  for v_lot in
    select l.id from public.stock_lots l
     where l.item_id = p_item and l.org_id = p_org and l.unshelved_at is null and not l.cost_stale
     order by l.bought_on, l.created_at, l.id
       for update
  loop
    exit when v_rem <= 0;
    select * into v_left from public.stock_lot_left(v_lot.id);
    continue when v_left.pieces_left <= 0;
    v_take := least(v_left.pieces_left, v_rem);
    insert into public.stock_moves (org_id, item_id, lot_id, job_id, draw_group, kind, qty, source, note)
    values (p_org, p_item, v_lot.id, p_job, p_group, 'draw', v_take, p_source, p_note)
    returning id, cost into v_id, v_cost;
    v_moves := v_moves || jsonb_build_array(jsonb_build_object('move_id', v_id, 'lot_id', v_lot.id, 'qty', v_take, 'cost', v_cost));
    v_total := v_total + v_cost;
    v_rem := v_rem - v_take;
  end loop;
  return jsonb_build_object('moves', v_moves, 'uncovered', greatest(v_rem, 0), 'cost', v_total);
end $$;
revoke execute on function public.stock_take_fifo(uuid, uuid, uuid, numeric, uuid, text, text) from public, anon, authenticated;

-- THE ONLY WAY TO TAKE PIECES. Crew and office alike; a non-staff caller gets quantities, never a cost.
create or replace function public.stock_draw(
  p_item uuid, p_job uuid, p_qty numeric, p_note text default null, p_source text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_org    uuid := public.auth_org_id();
  v_staff  boolean := public.is_org_staff();
  v_item   record;
  v_qty    numeric;
  v_src    text;
  v_group  uuid := gen_random_uuid();
  v_walk   jsonb;
  v_short  numeric;
  v_short_id uuid;
  v_moves  jsonb;
begin
  if v_uid is null or v_org is null then
    raise exception 'Sign in to take from the shelf.' using errcode = '42501';
  end if;
  v_qty := round(coalesce(p_qty, 0), 3);
  if v_qty <= 0 then
    raise exception 'Say how many to take.' using errcode = 'P0001';
  end if;
  if v_qty > 1000000 then
    raise exception 'That count looks too big for one take. Check it and try again.' using errcode = 'P0001';
  end if;
  select id, org_id, name, unit, active into v_item from public.inventory_items where id = p_item;
  if not found or v_item.org_id is distinct from v_org then
    raise exception 'That item isn''t on this company''s shelf.' using errcode = '42501';
  end if;
  if not v_item.active then
    raise exception '% is no longer kept on the shelf.', v_item.name using errcode = 'P0001';
  end if;
  if p_job is null or not exists (select 1 from public.jobs j where j.id = p_job and j.org_id = v_org) then
    raise exception 'Pick the job these pieces went on.' using errcode = '42501';
  end if;
  v_src := case when v_staff then coalesce(nullif(btrim(p_source), ''), 'office') else 'crew' end;
  if v_src not in ('tray', 'bill_line', 'crew', 'office', 'nort') then
    raise exception 'Unknown source for a take: %.', v_src using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('cn.stock:' || p_item::text));
  perform set_config('cn.stock_rpc', 'on', true);
  v_walk := public.stock_take_fifo(v_org, p_item, p_job, v_qty, v_group, v_src, nullif(btrim(p_note), ''));
  v_short := (v_walk->>'uncovered')::numeric;
  if v_short > 0 then
    -- TAKEN PAST THE SHELF: it still saves (no dead end in the field) and costs $0 until the roll
    -- is filed and the short settled. Never imported onto an invoice while it is a short.
    insert into public.stock_moves (org_id, item_id, lot_id, job_id, draw_group, kind, qty, source, note)
    values (v_org, p_item, null, p_job, v_group, 'short', v_short, v_src, nullif(btrim(p_note), ''))
    returning id into v_short_id;
  end if;
  perform set_config('cn.stock_rpc', '', true);

  v_moves := case when v_staff then v_walk->'moves'
                  else (select coalesce(jsonb_agg(m.value - 'cost'), '[]'::jsonb) from jsonb_array_elements(v_walk->'moves') as m(value)) end;
  return jsonb_build_object(
    'draw_group', v_group,
    'item', v_item.name,
    'unit', v_item.unit,
    'qty', v_qty,
    'moves', v_moves,
    'short', v_short,
    'short_id', v_short_id,
    'on_hand', (select quantity_on_hand from public.inventory_items where id = p_item)
  ) || case when v_staff then jsonb_build_object('cost', (v_walk->>'cost')::numeric) else '{}'::jsonb end;
end $$;
revoke execute on function public.stock_draw(uuid, uuid, numeric, text, text) from public, anon;
grant execute on function public.stock_draw(uuid, uuid, numeric, text, text) to authenticated, service_role;

-- Undo a take (the whole group). Refused once an invoice bills any of it; the refusal names it.
create or replace function public.stock_undo(p_group uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_org     uuid := public.auth_org_id();
  v_staff   boolean := public.is_org_staff();
  v_groups  uuid[];
  v_holder  text;
  v_n       integer;
begin
  if v_uid is null or v_org is null then
    raise exception 'Sign in to undo a take.' using errcode = '42501';
  end if;
  perform 1 from public.stock_moves m where m.draw_group = p_group for update;
  if not found or exists (select 1 from public.stock_moves m where m.draw_group = p_group and m.org_id is distinct from v_org) then
    raise exception 'That take isn''t on this company''s shelf record.' using errcode = '42501';
  end if;
  if exists (select 1 from public.stock_moves s where s.kind = 'short' and s.settled_by = p_group and s.undone_at is null) then
    raise exception 'These pieces settle an earlier take. Undo that take instead, and this goes with it.' using errcode = 'P0001';
  end if;
  -- The take, and the settlement of any short inside it: undoing a take undoes the whole of it.
  v_groups := array[p_group] || coalesce(array(
    select distinct s.settled_by from public.stock_moves s
     where s.draw_group = p_group and s.kind = 'short' and s.settled_by is not null and s.undone_at is null
  ), '{}'::uuid[]);
  -- A tech undoes only what they took themselves, and that means EVERY move the undo reaches: the
  -- settlement draws the office wrote for a short in the take are the office's.
  if not v_staff and exists (
    select 1 from public.stock_moves m where m.draw_group = any (v_groups) and m.undone_at is null and m.created_by is distinct from v_uid
  ) then
    raise exception 'Only the office can undo a take someone else made, or one the office has settled.' using errcode = '42501';
  end if;
  v_holder := public.invoice_holding_claim(
    array(select m.id from public.stock_moves m where m.draw_group = any (v_groups) and m.undone_at is null), v_org);
  if v_holder is not null then
    raise exception '% already bills these pieces. Take them off % first, then undo.', v_holder, v_holder
      using errcode = 'P0001';
  end if;
  -- The rolls, in the order a take locks them (oldest first), so an undo and a take never wait on
  -- each other in a circle.
  perform 1 from public.stock_lots l
   where l.id in (select m.lot_id from public.stock_moves m where m.draw_group = any (v_groups) and m.lot_id is not null)
   order by l.bought_on, l.created_at, l.id
     for update;
  perform set_config('cn.stock_rpc', 'on', true);
  -- Settlement draws first, then the take itself (its short last), so every step stays whole.
  update public.stock_moves set undone_at = now(), undone_by = v_uid
   where draw_group = any (v_groups) and draw_group <> p_group and undone_at is null;
  update public.stock_moves set undone_at = now(), undone_by = v_uid
   where draw_group = p_group and undone_at is null;
  get diagnostics v_n = row_count;
  perform set_config('cn.stock_rpc', '', true);
  return jsonb_build_object('draw_group', p_group, 'undone', v_n);
end $$;
revoke execute on function public.stock_undo(uuid) from public, anon;
grant execute on function public.stock_undo(uuid) to authenticated, service_role;

-- Settle pieces taken past the shelf, once a roll is filed: real draws, with their own ids and so
-- their own claims, at the roll's real cost. All or nothing.
create or replace function public.settle_short(p_short uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid := public.auth_org_id();
  v_short  record;
  v_group  uuid := gen_random_uuid();
  v_walk   jsonb;
begin
  if v_org is null or not public.is_org_staff() then
    raise exception 'Only the office settles pieces taken past the shelf.' using errcode = '42501';
  end if;
  select id, org_id, item_id, job_id, qty, kind, created_at, undone_at, settled_by into v_short
    from public.stock_moves where id = p_short for update;
  if not found or v_short.org_id is distinct from v_org or v_short.kind <> 'short' then
    raise exception 'That isn''t a take past the shelf in this company.' using errcode = '42501';
  end if;
  if v_short.undone_at is not null or v_short.settled_by is not null then
    raise exception 'That take is already settled or undone.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('cn.stock:' || v_short.item_id::text));
  perform set_config('cn.stock_rpc', 'on', true);
  v_walk := public.stock_take_fifo(v_org, v_short.item_id, v_short.job_id, v_short.qty, v_group, 'office',
                                   'Settles pieces taken on ' || to_char(v_short.created_at, 'Mon FMDD'));
  if (v_walk->>'uncovered')::numeric > 0 then
    raise exception 'Only % on the shelf, and % were taken past it. File the roll or count the shelf first.',
      v_short.qty - (v_walk->>'uncovered')::numeric, v_short.qty
      using errcode = 'P0001';
  end if;
  update public.stock_moves set settled_by = v_group where id = p_short;
  perform set_config('cn.stock_rpc', '', true);
  return jsonb_build_object('draw_group', v_group, 'moves', v_walk->'moves', 'cost', (v_walk->>'cost')::numeric);
end $$;
revoke execute on function public.settle_short(uuid) from public, anon;
grant execute on function public.settle_short(uuid) to authenticated, service_role;

-- ── 11. RLS: staff-only, and the take is not a direct write ─────────────────────────────────────
alter table public.stock_lots enable row level security;
alter table public.stock_moves enable row level security;
revoke all on public.stock_lots from anon;
revoke all on public.stock_moves from anon;

drop policy if exists stock_lots_read on public.stock_lots;
create policy stock_lots_read on public.stock_lots for select
  using (org_id = public.auth_org_id() and public.is_org_staff());
drop policy if exists stock_lots_insert on public.stock_lots;
create policy stock_lots_insert on public.stock_lots for insert
  with check (org_id = public.auth_org_id() and public.is_org_staff());
drop policy if exists stock_lots_update on public.stock_lots;
create policy stock_lots_update on public.stock_lots for update
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists stock_moves_read on public.stock_moves;
create policy stock_moves_read on public.stock_moves for select
  using (org_id = public.auth_org_id() and public.is_org_staff());
-- A draw or a short is written ONLY by stock_draw / settle_short. The office's upkeep moves (count,
-- write off, return to the supplier, bring back from a job) may be written directly; their cost
-- is stamped either way.
drop policy if exists stock_moves_insert on public.stock_moves;
create policy stock_moves_insert on public.stock_moves for insert
  with check (org_id = public.auth_org_id() and public.is_org_staff() and kind not in ('draw', 'short'));
drop policy if exists stock_moves_update on public.stock_moves;
create policy stock_moves_update on public.stock_moves for update
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- ── 12. views: one number for TypeScript and SQL readers alike ──────────────────────────────────
create or replace view public.stock_lot_balance with (security_invoker = true) as
select l.id as lot_id,
       l.org_id,
       l.item_id,
       l.kind,
       l.bill_line_id,
       bli.bill_id,
       l.pieces,
       l.unit,
       l.cost,
       l.bought_on,
       l.cost_stale,
       l.unshelved_at is null as live,
       l.pieces
         - coalesce(sum(m.qty) filter (where m.kind in ('draw', 'write_off', 'supplier_return', 'recount_down')), 0)
         + coalesce(sum(m.qty) filter (where m.kind in ('job_return', 'recount_up')), 0) as pieces_left,
       l.cost
         - coalesce(sum(m.cost) filter (where m.kind in ('draw', 'write_off', 'supplier_return', 'recount_down')), 0)
         + coalesce(sum(m.cost) filter (where m.kind = 'job_return'), 0) as cost_left,
       coalesce(sum(m.cost) filter (where m.kind = 'draw'), 0)
         - coalesce(sum(m.cost) filter (where m.kind = 'job_return'), 0) as drawn_cost,
       coalesce(sum(m.cost) filter (where m.kind in ('write_off', 'recount_down')), 0) as lost_cost,
       coalesce(sum(m.cost) filter (where m.kind = 'supplier_return'), 0) as returned_cost,
       count(m.id) as live_moves
  from public.stock_lots l
  left join public.bill_line_items bli on bli.id = l.bill_line_id
  left join public.stock_moves m on m.lot_id = l.id and m.undone_at is null
 group by l.id, bli.bill_id;
comment on view public.stock_lot_balance is
  'Per lot (0303): pieces and dollars left, drawn onto jobs (net of returns), lost (write-offs, recounts down) and returned to the supplier. Security invoker: staff only.';

-- JOB MATERIAL COST = the job''s live bills - off_shelf + from_shelf. src/lib/job-cost.ts reads this.
create or replace view public.job_shelf_net with (security_invoker = true) as
with off as (
  select b.org_id, b.job_id, sum(l.cost) as off_shelf
    from public.stock_lots l
    join public.bill_line_items bli on bli.id = l.bill_line_id
    join public.bills b on b.id = bli.bill_id
   where l.unshelved_at is null
     and b.job_id is not null
     and b.superseded_by_bill_id is null
   group by b.org_id, b.job_id
), frm as (
  select m.org_id, m.job_id,
         sum(case when m.kind = 'draw' then m.cost else -m.cost end) as from_shelf
    from public.stock_moves m
   where m.undone_at is null and m.kind in ('draw', 'job_return') and m.job_id is not null
   group by m.org_id, m.job_id
)
select coalesce(o.org_id, f.org_id) as org_id,
       coalesce(o.job_id, f.job_id) as job_id,
       coalesce(o.off_shelf, 0)::numeric(12,2) as off_shelf,
       coalesce(f.from_shelf, 0)::numeric(12,2) as from_shelf
  from off o
  full join frm f on f.org_id = o.org_id and f.job_id = o.job_id;
comment on view public.job_shelf_net is
  'Per job (0303): off_shelf = cost of live lots on the job''s own live bills; from_shelf = live draws onto the job less pieces brought back. Job material cost = bills - off_shelf + from_shelf. Security invoker: staff only.';

create or replace view public.stock_reconcile_problems with (security_invoker = true) as
select b.org_id, 'lot_empty_with_money_left'::text as problem, b.lot_id, b.item_id, null::uuid as move_id, b.bill_id,
       format('No pieces left but $%s still on the roll', b.cost_left) as detail
  from public.stock_lot_balance b
 where b.live and b.pieces_left = 0 and b.cost_left <> 0
union all
select b.org_id, 'lot_below_empty', b.lot_id, b.item_id, null, b.bill_id,
       format('%s pieces and $%s left', b.pieces_left, b.cost_left)
  from public.stock_lot_balance b
 where b.pieces_left < 0 or b.cost_left < 0
union all
select b.org_id, 'lot_cost_stale', b.lot_id, b.item_id, null, b.bill_id,
       'Its receipt changed after it went on the shelf; its cost needs restamping'
  from public.stock_lot_balance b
 where b.live and b.cost_stale
union all
-- Pieces brought back from a take can never be more than the take, in pieces or dollars, and a
-- take that is undone has nothing left on a job to bring back. (Checked against the draw itself,
-- not the lot's own arithmetic: drawn + lost + returned + left = cost is true by construction.)
select d.org_id, 'return_past_its_take', d.lot_id, d.item_id, d.id, null,
       format('take of %s ($%s), %s ($%s) brought back', d.qty, d.cost, r.qty, r.cost)
  from public.stock_moves d
  join lateral (select coalesce(sum(x.qty), 0) as qty, coalesce(sum(x.cost), 0) as cost, count(*) as n
                  from public.stock_moves x
                 where x.returns_move_id = d.id and x.kind = 'job_return' and x.undone_at is null) r on r.n > 0
 where d.kind = 'draw'
   and (r.qty > d.qty or r.cost > d.cost or d.undone_at is not null)
union all
select l.org_id, 'lot_over_its_paper', l.id, l.item_id, null, bli.bill_id,
       format('roll $%s, line $%s not billed to the job', l.cost,
              public.stock_line_not_billed(bli.amount, bli.billable, bli.billed_amount))
  from public.stock_lots l
  join public.bill_line_items bli on bli.id = l.bill_line_id
 where l.unshelved_at is null
   and l.cost > public.stock_line_not_billed(bli.amount, bli.billable, bli.billed_amount)
                + greatest((select coalesce(sum(t.amount), 0) from public.bill_line_items t
                             where t.bill_id = bli.bill_id and coalesce(t.category, '') ~* 'tax'), 0)
union all
-- Every live roll off one ticket, together, against the ticket: more than the ticket holds that the
-- job doesn't bill, or more than the ticket itself, would put the job that bought it below $0.
select b.org_id, 'rolls_over_their_ticket', null, null, null, b.id,
       format('rolls $%s, ticket $%s (not billed to the job, tax included: $%s)', x.rolls, b.amount, y.room)
  from public.bills b
  join lateral (select sum(l.cost) as rolls
                  from public.stock_lots l
                  join public.bill_line_items bli on bli.id = l.bill_line_id
                 where bli.bill_id = b.id and l.unshelved_at is null) x on x.rolls is not null
  cross join lateral (
    select coalesce(sum(greatest(public.stock_line_not_billed(t.amount, t.billable, t.billed_amount), 0))
                      filter (where coalesce(t.category, '') !~* 'tax'), 0)
           + greatest(coalesce(sum(t.amount) filter (where coalesce(t.category, '') ~* 'tax'), 0), 0) as room
      from public.bill_line_items t where t.bill_id = b.id
  ) y
 where x.rolls > b.amount or x.rolls > y.room
union all
select l.org_id, 'lot_on_a_replaced_bill', l.id, l.item_id, null, b.id, 'The receipt was replaced by a later bill'
  from public.stock_lots l
  join public.bill_line_items bli on bli.id = l.bill_line_id
  join public.bills b on b.id = bli.bill_id
 where l.unshelved_at is null and b.superseded_by_bill_id is not null
union all
select bli.org_id, 'line_marked_stock_without_a_roll', null, null, null, bli.bill_id, bli.description
  from public.bill_line_items bli
 where bli.is_stock
   and not exists (select 1 from public.stock_lots l where l.bill_line_id = bli.id and l.unshelved_at is null)
union all
select l.org_id, 'roll_on_a_line_not_marked_stock', l.id, l.item_id, null, bli.bill_id, bli.description
  from public.stock_lots l
  join public.bill_line_items bli on bli.id = l.bill_line_id
 where l.unshelved_at is null and not bli.is_stock
union all
select m.org_id, 'taken_past_the_shelf_unsettled', null, m.item_id, m.id, null,
       format('%s taken %s with no roll behind them', m.qty, to_char(m.created_at, 'Mon FMDD'))
  from public.stock_moves m
 where m.kind = 'short' and m.undone_at is null and m.settled_by is null
   and m.created_at < now() - interval '7 days'
union all
-- A short counts as settled only while live draws of the same item, onto the same job, cover it.
select m.org_id, 'short_settled_by_nothing', null, m.item_id, m.id, null,
       format('%s taken %s, settled by draws that cover %s', m.qty, to_char(m.created_at, 'Mon FMDD'), coalesce(d.qty, 0))
  from public.stock_moves m
  left join lateral (select sum(x.qty) as qty from public.stock_moves x
                      where x.draw_group = m.settled_by and x.kind = 'draw' and x.undone_at is null
                        and x.item_id = m.item_id and x.job_id = m.job_id) d on true
 where m.kind = 'short' and m.undone_at is null and m.settled_by is not null
   and coalesce(d.qty, 0) <> m.qty
union all
select i.org_id, 'on_hand_cache_drift', null, i.id, null, null,
       format('item says %s, record says %s', i.quantity_on_hand, x.v)
  from public.inventory_items i
  cross join lateral (
    select coalesce((select sum(b.pieces_left) from public.stock_lot_balance b where b.item_id = i.id and b.live), 0)
         + coalesce((select sum(m.qty) from public.stock_moves m
                      where m.item_id = i.id and m.lot_id is null and m.kind = 'recount_up' and m.undone_at is null), 0)
         - coalesce((select sum(m.qty) from public.stock_moves m
                      where m.item_id = i.id and m.kind = 'short' and m.undone_at is null and m.settled_by is null), 0) as v
  ) x
 where i.quantity_on_hand is distinct from x.v;
comment on view public.stock_reconcile_problems is
  'Everything about the shelf that does not add up (0303). Empty is the only healthy answer; the daily ops check and a DB test read it. The TypeScript half (stored lot cost vs shelfLotCost today) is lotCostDrift in src/lib/stock-ledger.ts.';

revoke all on public.stock_lot_balance, public.job_shelf_net, public.stock_reconcile_problems from anon;
grant select on public.stock_lot_balance, public.job_shelf_net, public.stock_reconcile_problems to authenticated, service_role;

-- ── 13. what main's stock door left behind, carried onto the ledger ─────────────────────────────
-- Until the Phase 1 code deploys, the receipt card's "goes in your stock" door (stock-flow.ts on
-- main) and the Inventory page's typed counts still write is_stock and quantity_on_hand. Both are
-- refused from here on, so whatever they wrote before this ran is carried over, row by row, with a
-- notice naming each one - never a failed apply, and never a count quietly thrown away:
--   · a receipt line marked is_stock with no roll behind it is cleared (the ledger re-marks it the
--     moment a roll from it goes on the shelf). Its billed_amount, what the job used, is untouched;
--   · a positive typed count becomes an OPENING roll of that many pieces at $0, with a note. $0,
--     because the dollars are already on the ticket that bought it (job cost read the whole ticket
--     until today) or were never on paper at all; a person may put a cost on it before any take;
--   · a count at or below zero, or on an item with no unit, is set to 0.
-- Production had none of either on 2026-09-24; this is for the window between that and the apply.
do $$
declare
  r record;
  n_lines integer := 0;
  n_lots integer := 0;
  n_zeroed integer := 0;
begin
  for r in select bli.id, bli.bill_id, bli.description from public.bill_line_items bli
            where bli.is_stock
              and not exists (select 1 from public.stock_lots l where l.bill_line_id = bli.id and l.unshelved_at is null)
  loop
    update public.bill_line_items set is_stock = false where id = r.id;
    n_lines := n_lines + 1;
    raise notice '0303 carry-over: receipt line % (bill %, "%") was marked stock with no roll behind it; cleared.', r.id, r.bill_id, r.description;
  end loop;
  for r in select i.id, i.org_id, i.name, i.unit, i.quantity_on_hand from public.inventory_items i
            where coalesce(i.quantity_on_hand, 0) <> 0
              and not exists (select 1 from public.stock_lots l where l.item_id = i.id)
  loop
    if r.quantity_on_hand > 0 and length(btrim(coalesce(r.unit, ''))) > 0 then
      insert into public.stock_lots (org_id, item_id, kind, pieces, unit, cost, note)
      values (r.org_id, r.id, 'opening', round(r.quantity_on_hand, 3), r.unit, 0,
              'Carried over from the count typed before the shelf kept its own record (0303). $0 because its cost is on the ticket that bought it; put a cost on it before anything is taken if it has one.');
      n_lots := n_lots + 1;
      raise notice '0303 carry-over: item % ("%") had % % typed on hand; now an opening roll of that many at $0.', r.id, r.name, r.quantity_on_hand, r.unit;
    else
      perform set_config('cn.stock_cache', 'on', true);
      update public.inventory_items set quantity_on_hand = 0 where id = r.id;
      perform set_config('cn.stock_cache', '', true);
      n_zeroed := n_zeroed + 1;
      raise notice '0303 carry-over: item % ("%") had % typed on hand with nothing behind it; set to 0.', r.id, r.name, r.quantity_on_hand;
    end if;
  end loop;
  raise notice '0303 carry-over: % receipt line(s) cleared, % opening roll(s) made, % count(s) set to 0.', n_lines, n_lots, n_zeroed;
end $$;

-- ── Self-check: shipped with ZERO receipt lots, so nothing anywhere can have moved ─────────────
-- (An opening roll carried over above has no ticket and no take, so it moves no job and no month.)
do $$
declare v integer;
begin
  select count(*) into v from public.stock_lots where kind <> 'opening' or cost <> 0 or note not like 'Carried over from the count typed%';
  if v <> 0 then raise exception '0303: expected no lots at ship but the carried-over counts, found %.', v; end if;
  select count(*) into v from public.stock_moves;
  if v <> 0 then raise exception '0303: expected no moves at ship, found %.', v; end if;
  select count(*) into v from public.job_shelf_net;
  if v <> 0 then raise exception '0303: job_shelf_net should be empty with no lots, has % rows.', v; end if;
  select count(*) into v from public.stock_reconcile_problems;
  if v <> 0 then raise exception '0303: stock_reconcile_problems should be empty, has % rows.', v; end if;
  select count(*) into v from public.bills where on_shelf;
  if v <> 0 then raise exception '0303: no bill should be on the shelf yet, % are.', v; end if;
  select count(*) into v from public.bill_line_items where is_stock;
  if v <> 0 then raise exception '0303: % receipt lines say is_stock with no roll behind them.', v; end if;
  -- Every item's count is the ledger's, including an item with no roll at all (0 on hand).
  select count(*) into v from public.inventory_items i
   where i.quantity_on_hand is distinct from
         coalesce((select sum(b.pieces_left) from public.stock_lot_balance b where b.item_id = i.id and b.live), 0);
  if v <> 0 then raise exception '0303: % stock items have a count the shelf''s record doesn''t hold.', v; end if;
  if exists (select 1 from pg_class where relname in ('stock_lots', 'stock_moves') and relnamespace = 'public'::regnamespace and not relrowsecurity) then
    raise exception '0303: RLS is not on for the shelf tables.';
  end if;
  raise notice '0303: the shelf is a ledger, with 0 receipt lots, 0 moves, 0 job adjustments and 0 problems.';
end $$;
