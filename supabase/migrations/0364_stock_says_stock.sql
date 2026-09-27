-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0364: stock says stock (the database's own words)
--
-- Erik, 2026-09-27: "we need to uniform our inventory talk to stock and inventory instead of
-- shelf". The app's screens, toasts and Nort changed in the same branch (fix/stock-not-shelf); this
-- is the half the database says itself. Every refusal below reaches a person word for word
-- (dbError hands back what it doesn't recognise, see src/lib/db-error.ts), so "Take it off the
-- shelf first" was still on screen after the app said "Take It Out Of Stock".
--
-- WHAT CHANGES: the MESSAGE TEXT of 55 refusals in 19 functions, and the default note
-- stock_recount writes on a count ('Counted on the shelf' -> 'Counted in stock'; the Shop Stock
-- page hides both). Nothing else: every body below is the LIVE production body (read with
-- pg_get_functiondef, 2026-09-27) with only those quoted strings swapped. Same arguments, same
-- '%' placeholders, same errcodes, same security, search_path, owner, grants and comments
-- (create or replace keeps them). Comments inside the bodies still say "shelf": they are code.
-- Table, column and function names (on_shelf, shelf_for_crew, unshelved_at) do not change.
--
-- LIVE BODIES, PINNED: the first block refuses unless every function's body is byte-for-byte the
-- one this was written from, or already this migration's (md5 of prosrc), so a later migration
-- that rewrote one of them is never quietly undone (the 0320 lesson). The last block checks every
-- new body by md5: each is exactly the live body with only these words changed.
--
-- LOCKS: create or replace on trigger functions and RPCs; no table DDL, no trigger DDL, no rows.
-- WHAT THIS CHANGES TODAY: words only. Production has 0 stock moves.
-- ORDER: after 0350 and 0357 (it rewrites bodies they left). Idempotent: a body already in its new
-- words passes the pin and is written again unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- ── The pin: every body is the one this was written from ────────────────────────────────────────
do $$
declare
  r record;
  v_md5 text;
begin
  for r in select * from (values
    ('public.freeze_used_stock_bill()', 'ca32c43b26b0f6bf543e1e5dd9088b00', '25d6fb74a4fb1e876c412a3dd15af76a'),
    ('public.freeze_used_stock_lot()', 'dd22945bf3b9806bbf64f80e7d8aa613', 'f6916ecd5e4e00924e367c5e55616cf7'),
    ('public.guard_invoice_unvoid_stock()', 'da50a51f1cb2df069452bfee89dca48d', 'ee2379ac30dc502e66de6a315091b883'),
    ('public.guard_shelf_credit_bill()', 'dda0cbc6c68807f4b77617929c728ea9', 'b01b2b696548bf099d70c16ba5749907'),
    ('public.guard_stock_item_delete()', 'af86d120febd8537b2ea6a3b7ff54b0f', '2d0ab3a5e6d2ea040005c07f192b2f75'),
    ('public.guard_stock_item()', '8ef6428bfa4c36ed7ea3aafdc788e688', 'b5d43047080d2bf3496625dc689d3f48'),
    ('public.guard_stock_line()', '2f5161b28f561b654a4bfa6ee8a4d6f5', '720d46fca6a53d785f80939b9a0fc917'),
    ('public.guard_stock_lot()', 'a4dd77904a6912747844e37576870d8f', '6ecede2ce22675742ace373464bdfd5f'),
    ('public.guard_stock_move_exported()', 'd99d2b39127f17a0c2c739218611de5f', 'f3d802ad0739bbf49fd5378febcbeadc'),
    ('public.guard_stock_move()', 'ec7ccb03d0bafa144938c8aeeecfb6de', '5eb0cb386e4787b06939c20b87e27703'),
    ('public.guard_stock_piece_claim()', '4d74f15464f2034b051f241ca7f176c2', 'c07af83bd827446e48410e343593575e'),
    ('public.mark_already_billed(uuid,uuid[])', '1804a59654df4f6277a68693da85ecd6', 'bac66e17c1bd4d4e7e296a82ad5cbc91'),
    ('public.settle_short(uuid)', 'a03d60796072da825e5d7cea6048bdb2', '7d22bc9f88daa71f544047a7a4b1cde6'),
    ('public.shelve_bill_lines(uuid,jsonb,jsonb)', 'f8328784ce3f741f2a96f7b2ac8c4c2b', '915600382618f5cbf994d2553d959957'),
    ('public.stamp_stock_move()', 'e107d05b935a3569df7559311dfd90a6', '69b074028ce02e8e43bdf3f4e6b61298'),
    ('public.stock_draw(uuid,uuid,numeric,text,text)', 'ba67639f1b087dbc43cb816f31a4c12d', '74b08eb7aeaf296a9c5ab8db352fde1d'),
    ('public.stock_move_names_its_credit()', 'd4156d2680a180fdb3d978c98365cc24', 'b60d8a66856b66e30a6600d3975744d8'),
    ('public.stock_recount(uuid,numeric,text)', 'ed396f9088b14e36bd564ed75f506b64', '6f5d2864686f2bf36a19f48b077109b8'),
    ('public.stock_undo(uuid)', '58980537221cec6ced57acbe567b255f', 'b7f7eca8559b73a539aa9d0df8fc3edb')
  ) as t(fn, old_md5, new_md5) loop
    if to_regprocedure(r.fn) is null then
      raise exception '0364: % is not on this database. Nothing was changed.', r.fn;
    end if;
    select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure(r.fn);
    if v_md5 is distinct from r.old_md5 and v_md5 is distinct from r.new_md5 then
      raise exception '0364: % is not the body this migration was written from (md5 %, expected %). Re-read it live and rebuild 0364. Nothing was changed.', r.fn, v_md5, r.old_md5;
    end if;
  end loop;
end $$;

-- ── freeze_used_stock_bill(): 2 messages ──
CREATE OR REPLACE FUNCTION public.freeze_used_stock_bill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      raise exception 'The rolls in stock from this ticket cost $%, more than a $% ticket. Take a roll out of stock first, then change the total.', v_rolls, new.amount
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.superseded_by_bill_id is not null and old.superseded_by_bill_id is null
     and exists (
       select 1 from public.stock_lots l join public.bill_line_items bli on bli.id = l.bill_line_id
        where bli.bill_id = old.id and l.unshelved_at is null
     ) then
    raise exception 'A roll from this ticket is in stock. Take it out of stock first, then set the ticket aside.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $function$;

-- ── freeze_used_stock_lot(): 1 message ──
CREATE OR REPLACE FUNCTION public.freeze_used_stock_lot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_takes integer;
begin
  if new.pieces is not distinct from old.pieces
     and new.cost is not distinct from old.cost
     and not (new.unshelved_at is not null and old.unshelved_at is null) then
    return new;
  end if;
  select count(*)::integer into v_takes from public.stock_moves m where m.lot_id = old.id and m.undone_at is null;
  if v_takes > 0 then
    raise exception 'Pieces from this roll are already on a job, so it stays in stock as it is. Undo % from this roll first.',
      public.stock_takes_phrase(v_takes) using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- ── guard_invoice_unvoid_stock(): 1 message ──
CREATE OR REPLACE FUNCTION public.guard_invoice_unvoid_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_moves uuid[];
  v_gone  record;
begin
  if not (old.status = 'void' and new.status <> 'void') then
    return new;
  end if;
  select coalesce(array_agg(distinct m.id), '{}') into v_moves
    from public.invoice_items li
    join public.stock_moves m on m.id = any (li.source_ids)
   where li.invoice_id = new.id;
  if coalesce(array_length(v_moves, 1), 0) = 0 then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(new.org_id::text, new.id::text)));
  perform 1 from public.stock_moves m where m.id = any (v_moves) order by m.id for update;
  if new.job_id is null then
    raise exception 'This invoice holds pieces taken from stock but has no job, so it can''t come back from void.'
      using errcode = 'P0001',
            hint = 'Pieces taken from stock are billed on their job''s invoice. Leave it void and bill the job on a fresh invoice.';
  end if;
  -- Gone: undone, not a take, another job's, or with pieces carried back to the shelf. A carry-back
  -- is refused while a live invoice holds the take (0343), so one on a held draw came while this
  -- invoice was void - or before it was built, when its line was already net of it; the second is
  -- refused too (this cannot tell them apart, and a fresh invoice bills exactly what is left).
  select m.id,
         coalesce(nullif(btrim(i.name), ''), 'Pieces') as item
    into v_gone
    from public.stock_moves m
    left join public.inventory_items i on i.id = m.item_id
   where m.id = any (v_moves)
     and (m.org_id is distinct from new.org_id
          or m.kind <> 'draw'
          or m.undone_at is not null
          or m.job_id is distinct from new.job_id
          or exists (select 1 from public.stock_moves r
                      where r.returns_move_id = m.id and r.kind = 'job_return' and r.undone_at is null))
   order by m.id
   limit 1;
  if found then
    raise exception '% taken from stock on this invoice went back into stock, so it can''t come back from void.', v_gone.item
      using errcode = 'P0001',
            hint = 'Un-voiding it would bill pieces that are no longer on this job. Leave it void and bill the job on a fresh invoice: New Invoice pulls in only what nobody has billed yet.';
  end if;
  return new;
end $function$;

-- ── guard_shelf_credit_bill(): 2 messages ──
CREATE OR REPLACE FUNCTION public.guard_shelf_credit_bill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_n integer;
begin
  select count(*)::integer into v_n
    from public.stock_moves m
   where m.credit_bill_id = old.id and m.kind = 'supplier_return' and m.undone_at is null;
  if v_n = 0 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This credit is tied to pieces returned from stock (the return on Shop Stock). Undo that return first, then delete the credit.'
      using errcode = 'P0001';
  end if;
  if new.job_id is not null or new.on_shelf is not true or not (new.amount < 0)
     or new.superseded_by_bill_id is not null or new.org_id is distinct from old.org_id then
    raise exception 'This credit is tied to pieces returned from stock (the return on Shop Stock), so it stays a credit on Shop Stock. Undo that return first, then change it.'
      using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- ── guard_stock_item_delete(): 1 message ──
CREATE OR REPLACE FUNCTION public.guard_stock_item_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if exists (select 1 from public.stock_lots l where l.item_id = old.id)
     or exists (select 1 from public.stock_moves m where m.item_id = old.id) then
    raise exception 'This item has rolls on the stock record, so it can''t be deleted. Mark it inactive instead.'
      using errcode = 'P0001';
  end if;
  return old;
end $function$;

-- ── guard_stock_item(): 3 messages ──
CREATE OR REPLACE FUNCTION public.guard_stock_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cache boolean := coalesce(current_setting('cn.stock_cache', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if coalesce(new.quantity_on_hand, 0) <> 0 and not v_cache then
      raise exception 'A new stock item starts with none on hand. Its count comes from what goes into stock, so put the roll or box in stock instead of typing a number.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.quantity_on_hand is distinct from old.quantity_on_hand and not v_cache then
    raise exception 'What is on hand is kept by the stock record now, so it can''t be typed over. Count it on Shop Stock instead.'
      using errcode = 'P0001';
  end if;
  if (new.unit is distinct from old.unit or new.org_id is distinct from old.org_id)
     and exists (select 1 from public.stock_lots l where l.item_id = old.id) then
    raise exception 'This item already has rolls in stock counted in %, so its unit can''t change. Make a new item for the new unit.', old.unit
      using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- ── guard_stock_line(): 2 messages ──
CREATE OR REPLACE FUNCTION public.guard_stock_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.is_stock and not exists (
    select 1 from public.stock_lots l where l.bill_line_id = new.id and l.unshelved_at is null
  ) then
    raise exception 'A receipt line is shop stock only while a roll from it is in stock. Put it in stock, and this is marked for you.'
      using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.is_stock and not new.is_stock and exists (
    select 1 from public.stock_lots l where l.bill_line_id = new.id and l.unshelved_at is null
  ) then
    raise exception 'A roll from this line is in stock. Take it out of stock first, and this is cleared for you.'
      using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- ── guard_stock_lot(): 9 messages ──
CREATE OR REPLACE FUNCTION public.guard_stock_lot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item   record;
  v_line   record;
  v_tax    numeric;
  v_free   numeric;
  v_room   numeric;
  v_others numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'A roll leaves stock by being taken out, never deleted, so its history stays.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    -- WHO FIRST. This runs as the definer and BEFORE row security judges the row, so without this a
    -- tech (or another company's office) could send any receipt line id and read its dollars back
    -- out of the cap's refusal. Only this company's office puts a roll on the shelf.
    if auth.uid() is not null
       and (not public.is_org_staff() or new.org_id is distinct from public.auth_org_id()) then
      raise exception 'Only the office puts rolls in this company''s stock.' using errcode = '42501';
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
      raise exception 'A roll in stock keeps its item, its unit and its receipt line. Take it out of stock and put it in again instead.'
        using errcode = 'P0001';
    end if;
    if old.unshelved_at is not null
       and (new.unshelved_at is distinct from old.unshelved_at or new.cost is distinct from old.cost
            or new.pieces is distinct from old.pieces) then
      raise exception 'That roll is already taken out of stock. Put the receipt line in stock again to count it.'
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
      raise exception 'A new roll goes into stock, not out of it.' using errcode = 'P0001';
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
      raise exception 'Sales tax can''t go into stock. It rides with the lines it was charged on.' using errcode = 'P0001';
    end if;
    -- THE EXTENSION IS THE PRICE (0274/0275): a $0.00 extension means nothing shipped.
    if not (v_line.amount > 0) then
      raise exception 'That line''s extension is $0.00, which means nothing shipped, so nothing from it can go into stock.'
        using errcode = 'P0001';
    end if;
    if tg_op = 'INSERT' and v_line.superseded_by_bill_id is not null then
      raise exception 'That receipt has been replaced by a later bill. Put the line in stock from the bill that replaced it.'
        using errcode = 'P0001';
    end if;
    -- A roll comes off what the job does NOT bill (0272's billed_amount). A line still billed in
    -- full is on the customer's invoice; the same dollars on the shelf would be counted twice.
    v_free := public.stock_line_not_billed(v_line.amount, v_line.billable, v_line.billed_amount);
    if not (v_free > 0) then
      raise exception 'This whole line is still billed to the job. Say how much this job used first, so the rest can go into stock.'
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
end $function$;

-- ── guard_stock_move_exported(): 1 message ──
CREATE OR REPLACE FUNCTION public.guard_stock_move_exported()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception 'This already went to your accountant in the % list, so it stays as it is. Count It puts things right from today.',
      case v_list when 'stock_used' then 'Stock Used' else 'On Hand' end
      using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- ── guard_stock_move(): 5 messages ──
CREATE OR REPLACE FUNCTION public.guard_stock_move()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_holder text;
  v_rpc    boolean := coalesce(current_setting('cn.stock_rpc', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    raise exception 'The stock record is never deleted. Undo the take instead.' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'undone_at' - 'undone_by' - 'settled_by') is distinct from (to_jsonb(old) - 'undone_at' - 'undone_by' - 'settled_by') then
    raise exception 'A take on the stock record can''t be changed, only undone.' using errcode = 'P0001';
  end if;
  if new.settled_by is distinct from old.settled_by then
    if old.settled_by is not null or new.settled_by is null or old.kind <> 'short' or old.undone_at is not null then
      raise exception 'Pieces taken past stock are settled once, from a roll.' using errcode = 'P0001';
    end if;
    -- Only settle_short names the draws that settle a short. Any other uuid would take the pieces
    -- out of on hand and out of the reconcile view with nothing on the job behind them.
    if auth.uid() is not null and not v_rpc then
      raise exception 'Pieces taken past stock are settled with Settle, from a roll in stock.' using errcode = 'P0001';
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
      raise exception 'Some of these pieces were already brought back into stock. Undo that first.' using errcode = 'P0001';
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
end $function$;

-- ── guard_stock_piece_claim(): 4 messages ──
CREATE OR REPLACE FUNCTION public.guard_stock_piece_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_added  uuid[];
  v_moves  uuid[];
  v_inv    record;
  v_m      record;
  v_hit    record;
begin
  -- What this write ADDS, exactly as 0258 reads it: an edit is judged on the ids it adds, so the
  -- importer's in-place refresh (same ids) and a price edit never come here.
  if tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id then
    v_added := coalesce(new.source_ids, '{}');
  else
    select coalesce(array_agg(s), '{}') into v_added
      from unnest(coalesce(new.source_ids, '{}')) as s
     where not (s = any (coalesce(old.source_ids, '{}')));
  end if;
  if coalesce(array_length(v_added, 1), 0) = 0 then
    return new;
  end if;
  -- Only a move from the shelf's record is this guard's business (a primary-key probe per id).
  select coalesce(array_agg(m.id order by m.id), '{}') into v_moves
    from public.stock_moves m where m.id = any (v_added);
  if coalesce(array_length(v_moves, 1), 0) = 0 then
    return new;
  end if;

  select i.id, i.org_id, i.job_id, i.status into v_inv from public.invoices i where i.id = new.invoice_id;
  -- 0260's lock, the same key, taken before any read (see the header). Coalesced: a strict function
  -- with a null key takes no lock at all. stock_undo and a carry-back take it first too.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(v_inv.org_id::text, new.invoice_id::text)));
  -- The take's rows, locked in id order - the order stock_undo locks them in, under the same lock.
  perform 1 from public.stock_moves m where m.id = any (v_moves) order by m.id for update;

  -- WHOSE. Another company's pieces are never named, only refused.
  if exists (select 1 from public.stock_moves m where m.id = any (v_moves) and m.org_id is distinct from v_inv.org_id) then
    raise exception 'Those pieces aren''t on this company''s stock record.' using errcode = '42501';
  end if;
  -- A void invoice bills nothing; what its lines say is history (0258). Only a live one is judged.
  if v_inv.status = 'void' then
    return new;
  end if;
  -- ON ITS JOB'S INVOICE. A jobless invoice holding a take would shut it out of its own job's.
  if v_inv.job_id is null then
    raise exception 'Pieces taken from stock are billed on their job''s invoice.' using errcode = 'P0001';
  end if;

  -- WHAT. A live take, onto this invoice's job.
  for v_m in
    select m.id, m.kind, m.job_id, m.undone_at,
           coalesce(nullif(btrim(j.job_number), ''), nullif(btrim(j.name), ''), 'another job') as job_label
      from public.stock_moves m
      left join public.jobs j on j.id = m.job_id and j.org_id = m.org_id
     where m.id = any (v_moves)
     order by m.id
  loop
    if v_m.kind = 'short' then
      raise exception 'Pieces taken past stock aren''t billed until their roll is filed and they''re settled on Shop Stock.'
        using errcode = 'P0001';
    elsif v_m.kind <> 'draw' then
      raise exception 'Only pieces taken onto a job are billed. That entry is a count, a write-off or a return, not a take.'
        using errcode = 'P0001';
    elsif v_m.undone_at is not null then
      raise exception 'That take was undone, so its pieces are back in stock and can''t be billed.'
        using errcode = 'P0001';
    elsif v_m.job_id is distinct from v_inv.job_id then
      raise exception 'Those pieces were taken for %, so they can''t be billed on this invoice.', v_m.job_label
        using errcode = 'P0001';
    end if;
  end loop;

  -- SOMETHING OF IT IS STILL ON THE JOB. A take carried back whole bills nothing (the importer never
  -- offers one); a line holding it would bill pieces that are on the roll again.
  if exists (
    select 1
      from (select m.draw_group, sum(m.qty - coalesce(r.back, 0)) as net
              from public.stock_moves m
              left join lateral (
                select sum(x.qty) as back from public.stock_moves x
                 where x.returns_move_id = m.id and x.kind = 'job_return' and x.undone_at is null
              ) r on true
             where m.draw_group in (select d.draw_group from public.stock_moves d where d.id = any (v_moves))
               and m.kind = 'draw' and m.undone_at is null
             group by m.draw_group) g
     where g.net <= 0
  ) then
    raise exception 'Every piece of that take went back into stock, so there''s nothing of it to bill.'
      using errcode = 'P0001';
  end if;

  -- ONE LIVE LINE. Any OTHER line, this invoice's included, on a live invoice in the org.
  select xi.invoice_number, (x.invoice_id = new.invoice_id) as same
    into v_hit
    from public.invoice_items x
    join public.invoices xi on xi.id = x.invoice_id
   where x.id <> new.id
     and xi.status <> 'void'
     and xi.org_id is not distinct from v_inv.org_id
     and x.source_ids && v_moves
   order by (x.invoice_id = new.invoice_id) desc, xi.created_at, xi.id
   limit 1;
  if found then
    if v_hit.same then
      raise exception 'These pieces are already on another line of this invoice. A take is billed on one line.'
        using errcode = 'P0001';
    end if;
    raise exception 'materials already billed on %', coalesce(v_hit.invoice_number, 'another invoice')
      using errcode = 'P0001',
            hint = 'A take from stock is billed on one invoice at a time. Void or adjust that invoice first.';
  end if;
  return new;
end $function$;

-- ── mark_already_billed(uuid,uuid[]): 2 messages ──
CREATE OR REPLACE FUNCTION public.mark_already_billed(p_line uuid, p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_org     uuid := public.auth_org_id();
  v_line    record;
  v_inv     record;
  v_ids     uuid[];
  v_jobs    uuid[];
  v_id      uuid;
  v_b       record;
  v_p       record;
  v_t       record;
  v_m       record;
  v_hit     record;
  v_after   record;
  v_num     text;
  v_neg     boolean;
  v_n       integer;
  v_itemized constant text[] := array['labor', 'costs', 'change_orders', 'quote'];
begin
  if v_org is null or not public.is_org_staff() then
    raise exception 'Only the office can mark something as already billed. Nothing was changed.' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids from unnest(coalesce(p_ids, '{}'::uuid[])) as x where x is not null;
  if cardinality(v_ids) = 0 then
    raise exception 'Pick what that line already charged for. Nothing was changed.' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'That is more than 500 things for one line. Mark them in smaller batches. Nothing was changed.' using errcode = '22023';
  end if;

  -- THE CLAIM LOCK (0260's org key) before any claim is read: an import or a split racing this waits.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || v_org::text));

  select ii.id, ii.invoice_id, ii.org_id, ii.description, ii.line_total, ii.import_source, ii.import_key,
         ii.edited, ii.line_kind, ii.source_ids, ii.hand_claims
    into v_line
    from public.invoice_items ii
   where ii.id = p_line
   for update;
  if not found or v_line.org_id is distinct from v_org then
    raise exception 'That invoice line was not found. Nothing was changed.' using errcode = 'P0002';
  end if;
  select i.id, i.org_id, i.invoice_number, i.status::text as status, coalesce(i.invoice_kind, 'standard') as kind,
         i.job_id, i.customer_id, i.total
    into v_inv
    from public.invoices i
   where i.id = v_line.invoice_id
   for update;
  if not found or v_inv.org_id is distinct from v_org then
    raise exception 'That invoice line was not found. Nothing was changed.' using errcode = 'P0002';
  end if;
  v_num := coalesce(v_inv.invoice_number, 'That invoice');

  -- THE INVOICE.
  if v_inv.status = 'draft' then
    raise exception '% is still a draft: Add To % puts it there. Nothing was changed.', v_num, v_num using errcode = 'P0001';
  elsif v_inv.status = 'void' then
    raise exception '% is void, so it bills nothing. Nothing was changed.', v_num using errcode = 'P0001';
  elsif v_inv.kind = 'deposit' then
    raise exception '% is a deposit: it bills a part of the job up front, not this. Pick a line on another invoice. Nothing was changed.', v_num using errcode = 'P0001';
  end if;

  -- THE LINE.
  if v_line.import_source = 'draw_credit' then
    raise exception 'That line is the credit for earlier payments, not a charge. Nothing was changed.' using errcode = 'P0001';
  end if;
  if v_line.import_source = 'milestone'
     or (v_inv.kind <> 'standard'
         and not (coalesce(v_line.import_source, '') = any (v_itemized))
         and not exists (select 1 from public.invoice_items x where x.invoice_id = v_inv.id and x.import_source = any (v_itemized))) then
    raise exception 'That line bills a set part of the contract, not work item by item. Nothing was changed.' using errcode = 'P0001';
  end if;
  if coalesce(v_line.line_total, 0) = 0 then
    raise exception 'That line is $0.00, so it charged for nothing. Nothing was changed.' using errcode = 'P0001';
  end if;
  v_neg := v_line.line_total < 0;
  if v_line.import_source is not null and v_line.edited is not true then
    raise exception 'That line came from an import and nobody has changed it, so the next import rewrites what it holds. Pick a line you typed or changed. Nothing was changed.' using errcode = 'P0001';
  end if;
  if not v_neg and v_line.line_kind = 'other' then
    raise exception 'That line is filed as Other (a fee, a referral, a discount), not work. Nothing was changed.' using errcode = 'P0001';
  end if;
  if v_neg and v_line.import_source is not null then
    raise exception 'A return goes on a line you typed that takes money off. Nothing was changed.' using errcode = 'P0001';
  end if;

  -- WHERE THE ROWS MAY COME FROM: the invoice's job, or, for an invoice with no job, its customer's jobs.
  if v_inv.job_id is not null then
    v_jobs := array[v_inv.job_id];
  elsif v_inv.customer_id is not null then
    select coalesce(array_agg(j.id), '{}'::uuid[]) into v_jobs
      from public.jobs j where j.customer_id = v_inv.customer_id and j.org_id = v_org;
  else
    v_jobs := '{}'::uuid[];
  end if;

  -- WHAT: each id, in the office's words when it is refused.
  foreach v_id in array v_ids loop
    select b.id, b.org_id, b.job_id, b.amount, b.superseded_by_bill_id, b.po_id into v_b from public.bills b where b.id = v_id;
    if found then
      if v_b.org_id is distinct from v_org then
        raise exception 'That receipt isn''t in your company''s books. Nothing was changed.' using errcode = '42501';
      elsif v_b.superseded_by_bill_id is not null then
        raise exception 'That receipt was set aside as a copy of another one, so it is not a cost. Nothing was changed.' using errcode = 'P0001';
      -- ITS ORDER IS BILLED, SO IT IS: the importer skips a receipt whose order a live invoice holds
      -- (the customer paid for the delivery on the order's line). Held again here, it is one cost twice.
      elsif v_b.po_id is not null and exists (
              select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
               where xi.org_id = v_org and xi.status <> 'void' and x.source_ids @> array[v_b.po_id]) then
        raise exception 'That receipt''s order is already billed on %, so the receipt is too. Nothing was changed.',
          coalesce((select xi.invoice_number from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
                     where xi.org_id = v_org and xi.status <> 'void' and x.source_ids @> array[v_b.po_id]
                     order by xi.created_at, xi.id limit 1), 'another invoice') using errcode = 'P0001';
      elsif v_b.job_id is null or not (v_b.job_id = any (v_jobs)) then
        raise exception 'That receipt is on another job, not on %''s. Nothing was changed.', v_num using errcode = 'P0001';
      elsif coalesce(v_b.amount, 0) = 0 then
        raise exception 'That receipt is $0.00, so there is nothing of it to bill. Nothing was changed.' using errcode = 'P0001';
      elsif v_b.amount < 0 and not v_neg then
        raise exception 'That is a return: it takes money off, so it goes on a line you typed that takes money off. Nothing was changed.' using errcode = 'P0001';
      elsif v_b.amount > 0 and v_neg then
        raise exception 'That line takes money off, so only a return goes on it. Nothing was changed.' using errcode = 'P0001';
      end if;
      continue;
    end if;

    select p.id, p.org_id, p.job_id, p.total, p.status::text as status into v_p from public.purchase_orders p where p.id = v_id;
    if found then
      if v_p.org_id is distinct from v_org then
        raise exception 'That order isn''t in your company''s books. Nothing was changed.' using errcode = '42501';
      elsif v_p.job_id is null or not (v_p.job_id = any (v_jobs)) then
        raise exception 'That order is on another job, not on %''s. Nothing was changed.', v_num using errcode = 'P0001';
      elsif v_p.status in ('draft', 'cancelled') then
        raise exception 'That order was never placed (it is a draft or cancelled), so it is not a cost. Nothing was changed.' using errcode = 'P0001';
      elsif exists (select 1 from public.bills b where b.po_id = v_p.id and b.org_id = v_org and b.superseded_by_bill_id is null) then
        raise exception 'The supplier''s bill for that order is in your books, so the bill is the cost now. Mark the bill instead. Nothing was changed.' using errcode = 'P0001';
      elsif coalesce(v_p.total, 0) <= 0 then
        raise exception 'That order is $0.00, so there is nothing of it to bill. Nothing was changed.' using errcode = 'P0001';
      elsif v_neg then
        raise exception 'That line takes money off, so only a return goes on it. Nothing was changed.' using errcode = 'P0001';
      end if;
      continue;
    end if;

    select t.id, t.org_id, t.job_id, t.status::text as status, t.clock_out into v_t from public.time_entries t where t.id = v_id;
    if found then
      if v_t.org_id is distinct from v_org then
        raise exception 'That shift isn''t in your company''s books. Nothing was changed.' using errcode = '42501';
      -- HOURS ON NO JOB (TTUSD on INV-055, Ben Ebenezer on INV-058): a shift nobody put on a job was
      -- billed by hand on an invoice with no job. Only there: on a job's invoice it would count as
      -- that job's work, and a shift on no job belongs to none.
      elsif v_t.job_id is null and v_inv.job_id is not null then
        raise exception 'That shift is on no job, so only an invoice with no job can hold it, not %. Nothing was changed.', v_num using errcode = 'P0001';
      elsif v_t.job_id is not null and not (v_t.job_id = any (v_jobs)) then
        raise exception 'That shift is on another job, not on %''s. Nothing was changed.', v_num using errcode = 'P0001';
      elsif v_t.status <> 'closed' or v_t.clock_out is null then
        raise exception 'That shift is still running. Clock it out first. Nothing was changed.' using errcode = 'P0001';
      elsif v_neg then
        raise exception 'That line takes money off, so only a return goes on it. Nothing was changed.' using errcode = 'P0001';
      end if;
      continue;
    end if;

    select m.id, m.org_id, m.job_id, m.kind, m.undone_at, m.draw_group into v_m from public.stock_moves m where m.id = v_id;
    if found then
      if v_m.org_id is distinct from v_org then
        raise exception 'Those pieces aren''t on your company''s stock record. Nothing was changed.' using errcode = '42501';
      elsif v_inv.job_id is null then
        raise exception 'Pieces taken from stock are billed on their job''s invoice. Nothing was changed.' using errcode = 'P0001';
      elsif v_m.kind <> 'draw' or v_m.draw_group is null then
        raise exception 'Only pieces taken onto a job are billed. That entry is a count, a write-off, a return or a short. Nothing was changed.' using errcode = 'P0001';
      elsif v_m.undone_at is not null then
        raise exception 'That take was undone, so its pieces are back in stock. Nothing was changed.' using errcode = 'P0001';
      elsif v_m.job_id is distinct from v_inv.job_id then
        raise exception 'Those pieces were taken for another job, not for %''s. Nothing was changed.', v_num using errcode = 'P0001';
      elsif v_neg then
        raise exception 'That line takes money off, so only a return goes on it. Nothing was changed.' using errcode = 'P0001';
      end if;
      continue;
    end if;

    raise exception 'One of those isn''t a receipt, an order, a shift or a take from stock in your books. Nothing was changed.' using errcode = 'P0002';
  end loop;

  -- A TIME & MATERIAL JOB'S WORK TO DATE COUNTS ITS OWN INVOICES (tmWorkToDate reads billed work from
  -- the job's invoices): a row of one held on an invoice with no job would drop out of it. So its
  -- rows go on a line of one of its own invoices.
  if v_inv.job_id is null and exists (
    select 1
      from public.jobs j
     where j.org_id = v_org
       and j.billing_type = 'tm'
       and j.id in (select b.job_id from public.bills b where b.id = any (v_ids) and b.org_id = v_org
                    union all
                    select p.job_id from public.purchase_orders p where p.id = any (v_ids) and p.org_id = v_org
                    union all
                    select t.job_id from public.time_entries t where t.id = any (v_ids) and t.org_id = v_org)
  ) then
    raise exception '% has no job, and a Time & Material job counts only its own invoices in its work to date. Pick a line on one of that job''s invoices. Nothing was changed.', v_num using errcode = 'P0001';
  end if;

  -- A TAKE IS BILLED WHOLE: every live draw of each take named here, or none of it.
  if exists (
    select 1
      from public.stock_moves m
     where m.draw_group in (select d.draw_group from public.stock_moves d where d.id = any (v_ids) and d.draw_group is not null)
       and m.org_id = v_org
       and m.kind = 'draw'
       and m.undone_at is null
       and not (m.id = any (v_ids))
  ) then
    raise exception 'A take from stock is billed whole: mark every piece of it, or none. Nothing was changed.' using errcode = 'P0001';
  end if;

  -- A SPLIT SHIFT IS BILLED WHOLE: every piece of each shift named here that is on the same job
  -- (or, like it, on no job), closed, billable, of some length and on no live invoice (every piece
  -- the sheet lists), or none. Then the only piece that joins a hand claim later is one
  -- split_time_entry cuts from a piece already held (the trigger's carry), never a free piece an
  -- importer bills on the same line.
  if exists (
    select 1
      from public.time_entries t
      join public.time_entries m
        on m.id = any (v_ids)
       and m.org_id = v_org
       and coalesce(t.split_from, t.id) = coalesce(m.split_from, m.id)
       and t.job_id is not distinct from m.job_id
     where t.org_id = v_org
       and not (t.id = any (v_ids))
       and t.status = 'closed'
       and t.clock_out is not null
       and extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - greatest(coalesce(t.lunch_minutes, 0), 0) / 60.0 > 0
       and not (t.job_code is not null and exists (
             select 1 from public.job_codes jc
              where jc.org_id = v_org and jc.billable = false and btrim(jc.code) = btrim(t.job_code)))
       and not exists (
             select 1
               from public.invoice_items x
               join public.invoices xi on xi.id = x.invoice_id
              where xi.org_id = v_org and xi.status <> 'void' and x.source_ids @> array[t.id])
  ) then
    raise exception 'A split shift is billed whole: tick every part of it, or none. Nothing was changed.' using errcode = 'P0001';
  end if;

  -- NEVER TWICE: not on any live invoice, this one included.
  select xi.invoice_number, (x.invoice_id = v_inv.id) as same
    into v_hit
    from public.invoice_items x
    join public.invoices xi on xi.id = x.invoice_id
   where xi.org_id = v_org
     and xi.status <> 'void'
     and x.source_ids && v_ids
   order by (x.invoice_id = v_inv.id) desc, xi.created_at, xi.id
   limit 1;
  if found then
    if v_hit.same then
      raise exception '% already holds that. Nothing was changed.', v_num using errcode = 'P0001';
    end if;
    raise exception 'That is already billed on %. Nothing was changed.', coalesce(v_hit.invoice_number, 'another invoice') using errcode = 'P0001';
  end if;

  -- THE WRITE: the claim lists, nothing else. 0258/0260 and 0343 judge the new ids as they judge any.
  update public.invoice_items
     set source_ids  = source_ids || v_ids,
         hand_claims = hand_claims || v_ids
   where id = v_line.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'That line could not be marked just now. Nothing was changed.' using errcode = 'P0001';
  end if;

  -- NOTHING ON THE BILL MOVED, or nothing is kept.
  select ii.line_total, i.total, i.status::text as status
    into v_after
    from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
   where ii.id = v_line.id;
  if v_after.line_total is distinct from v_line.line_total
     or v_after.total is distinct from v_inv.total
     or v_after.status is distinct from v_inv.status then
    raise exception 'Marking that would have changed %''s total or status, so nothing was changed.', v_num using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'line_id', v_line.id,
    'invoice_id', v_inv.id,
    'invoice_number', v_inv.invoice_number,
    'description', v_line.description,
    'line_total', v_line.line_total,
    'added', to_jsonb(v_ids));
end;
$function$;

-- ── settle_short(uuid): 3 messages ──
CREATE OR REPLACE FUNCTION public.settle_short(p_short uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org    uuid := public.auth_org_id();
  v_short  record;
  v_group  uuid := gen_random_uuid();
  v_walk   jsonb;
begin
  if v_org is null or not public.is_org_staff() then
    raise exception 'Only the office settles pieces taken past stock.' using errcode = '42501';
  end if;
  select id, org_id, item_id, job_id, qty, kind, created_at, undone_at, settled_by into v_short
    from public.stock_moves where id = p_short for update;
  if not found or v_short.org_id is distinct from v_org or v_short.kind <> 'short' then
    raise exception 'That isn''t a take past stock in this company.' using errcode = '42501';
  end if;
  if v_short.undone_at is not null or v_short.settled_by is not null then
    raise exception 'That take is already settled or undone.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('cn.stock:' || v_short.item_id::text));
  perform set_config('cn.stock_rpc', 'on', true);
  v_walk := public.stock_take_fifo(v_org, v_short.item_id, v_short.job_id, v_short.qty, v_group, 'office',
                                   'Settles pieces taken on ' || to_char(v_short.created_at, 'Mon FMDD'));
  if (v_walk->>'uncovered')::numeric > 0 then
    raise exception 'Only % in stock, and % were taken past it. A count can''t settle it: file the roll on Shop Stock first, or Undo the take.',
      v_short.qty - (v_walk->>'uncovered')::numeric, v_short.qty
      using errcode = 'P0001';
  end if;
  update public.stock_moves set settled_by = v_group where id = p_short;
  perform set_config('cn.stock_rpc', '', true);
  return jsonb_build_object('draw_group', v_group, 'moves', v_walk->'moves', 'cost', (v_walk->>'cost')::numeric);
end $function$;

-- ── shelve_bill_lines(uuid,jsonb,jsonb): 7 messages ──
CREATE OR REPLACE FUNCTION public.shelve_bill_lines(p_bill uuid, p_lines jsonb, p_restamp jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_org    uuid := public.auth_org_id();
  v_bill   record;
  v_holder text;
  r        jsonb;
  v_line   uuid;
  v_item   uuid;
  v_lot    uuid;
  v_n      integer;
  v_out    jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or v_org is null or not public.is_org_staff() then
    raise exception 'Only the office puts things in this company''s stock.' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Say what goes into stock first.' using errcode = 'P0001';
  end if;
  if p_restamp is not null and jsonb_typeof(p_restamp) <> 'array' then
    raise exception 'The rolls to restamp came in the wrong shape. Nothing was changed.' using errcode = 'P0001';
  end if;

  select b.id, b.org_id, b.superseded_by_bill_id, b.po_id into v_bill from public.bills b where b.id = p_bill;
  if not found or v_bill.org_id is distinct from v_org then
    raise exception 'That ticket isn''t in this company.' using errcode = '42501';
  end if;
  if v_bill.superseded_by_bill_id is not null then
    raise exception 'That ticket was set aside for a later bill. Put its lines in stock from the bill that replaced it.'
      using errcode = 'P0001';
  end if;

  -- The ticket's shelf lock (the one guard_stock_lot and 0304's lock_stock_bill take), so two
  -- people shelving the same ticket, or a shelving and a receipt edit, go one after the other.
  perform pg_advisory_xact_lock(hashtext('cn.stock_bill:' || p_bill::text));

  select coalesce(i.invoice_number, 'An invoice') into v_holder
    from public.invoice_items it
    join public.invoices i on i.id = it.invoice_id
   where (it.source_ids @> array[p_bill] or it.import_key = 'bill:' || p_bill::text or it.import_key like 'bill:' || p_bill::text || ':%')
     and i.status not in ('void', 'draft')
   order by i.created_at, i.id
   limit 1;
  if v_holder is not null then
    raise exception '% has gone to the customer and already bills this ticket, so what it used can''t change now. Nothing went into stock.', v_holder
      using errcode = 'P0001';
  end if;
  if v_bill.po_id is not null then
    select coalesce(i.invoice_number, 'An invoice') into v_holder
      from public.invoice_items it
      join public.invoices i on i.id = it.invoice_id
     where (it.source_ids @> array[v_bill.po_id] or it.import_key = 'po:' || v_bill.po_id::text or it.import_key like 'po:' || v_bill.po_id::text || ':%')
       and i.status not in ('void', 'draft')
     order by i.created_at, i.id
     limit 1;
    if v_holder is not null then
      raise exception '% has gone to the customer and already bills the order this ticket delivered, so what it used can''t change now. Nothing went into stock.', v_holder
        using errcode = 'P0001';
    end if;
  end if;

  -- a. what each line's job used
  for r in select value from jsonb_array_elements(p_lines) loop
    v_line := nullif(r->>'line_id', '')::uuid;
    if v_line is null or not exists (
      select 1 from public.bill_line_items l where l.id = v_line and l.bill_id = p_bill and l.org_id = v_org
    ) then
      raise exception 'A line on this ticket isn''t there any more. Reload and try again. Nothing was changed.' using errcode = 'P0001';
    end if;
    if (r->>'billed_amount') is null or (r->>'billed_amount')::numeric < 0 then
      raise exception 'Say what this job used of each line (0 if none). Nothing was changed.' using errcode = 'P0001';
    end if;
    update public.bill_line_items
       set billed_amount = round((r->>'billed_amount')::numeric, 2)
     where id = v_line and org_id = v_org
       and billed_amount is distinct from round((r->>'billed_amount')::numeric, 2);
  end loop;

  -- b. the rolls already on this ticket, at their new share
  for r in select value from jsonb_array_elements(coalesce(p_restamp, '[]'::jsonb)) loop
    update public.stock_lots l
       set cost = round((r->>'cost')::numeric, 2), cost_stale = false
     where l.id = nullif(r->>'lot_id', '')::uuid
       and l.org_id = v_org
       and l.unshelved_at is null
       and l.bill_line_id in (select bli.id from public.bill_line_items bli where bli.bill_id = p_bill);
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'A roll already in stock from this ticket changed while this was open. Reload and try again. Nothing was changed.'
        using errcode = 'P0001';
    end if;
  end loop;

  -- c. the new rolls
  for r in select value from jsonb_array_elements(p_lines) loop
    v_line := (r->>'line_id')::uuid;
    v_item := nullif(r->>'item_id', '')::uuid;
    if v_item is null then
      if length(btrim(coalesce(r->>'item_name', ''))) = 0 then
        raise exception 'Name the item this goes into stock as. Nothing was changed.' using errcode = 'P0001';
      end if;
      insert into public.inventory_items (org_id, name, unit, key_part, quantity_on_hand, reorder_point)
      values (v_org, left(btrim(r->>'item_name'), 200), btrim(r->>'unit'), nullif(btrim(coalesce(r->>'key_part', '')), ''), 0, 0)
      returning id into v_item;
    else
      -- A roll landing on an item someone marked inactive makes it active again: an inactive item
      -- is off Shop Stock's list, and a roll on it would be shelf money no screen shows.
      update public.inventory_items set active = true where id = v_item and org_id = v_org and active is false;
    end if;
    insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost)
    values (v_org, v_item, 'line', v_line, round((r->>'pieces')::numeric, 3), btrim(r->>'unit'), round((r->>'cost')::numeric, 2))
    returning id into v_lot;
    v_out := v_out || jsonb_build_array(jsonb_build_object('lot_id', v_lot, 'item_id', v_item, 'line_id', v_line));
  end loop;

  return jsonb_build_object('lots', v_out);
end $function$;

-- ── stamp_stock_move(): 4 messages ──
CREATE OR REPLACE FUNCTION public.stamp_stock_move()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      raise exception 'That isn''t this company''s stock.' using errcode = '42501';
    end if;
    if not public.is_org_staff() and coalesce(current_setting('cn.stock_rpc', true), '') <> 'on' then
      raise exception 'Pieces come out of stock with Took From Stock. The stock record isn''t written directly.'
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
      raise exception 'That roll is taken out of stock, so nothing can move on it.' using errcode = 'P0001';
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
      raise exception 'That roll''s receipt changed after it went into stock, so its cost is being worked out again. Restamp it from its receipt first.'
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
end $function$;

-- ── stock_draw(uuid,uuid,numeric,text,text): 3 messages ──
CREATE OR REPLACE FUNCTION public.stock_draw(p_item uuid, p_job uuid, p_qty numeric, p_note text DEFAULT NULL::text, p_source text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_reach  numeric;  -- 0347
  v_open   numeric;  -- 0347
  v_walk_qty numeric;  -- 0347
begin
  if v_uid is null or v_org is null then
    raise exception 'Sign in to take from stock.' using errcode = '42501';
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
    raise exception 'That item isn''t in this company''s stock.' using errcode = '42501';
  end if;
  if not v_item.active then
    raise exception '% is no longer kept in stock.', v_item.name using errcode = 'P0001';
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
  -- 0347: OPEN SHORTS KEEP THEIR PIECES. Under the item's lock, what a take can reach is the pieces
  -- left on live, settled rolls (stock_take_fifo's own walk) less every open short on the item: those
  -- pieces are owed to the older takes, and Settle From The Shelf draws them. The rest of this take,
  -- if any, is its own short, said before the tap (shelf_for_crew.takeable, the same figure), after
  -- it (the toast) and to the office (the bell).
  select coalesce(sum(greatest(x.pieces_left, 0)), 0) into v_reach
    from public.stock_lots l
    cross join lateral public.stock_lot_left(l.id) x
   where l.item_id = p_item and l.org_id = v_org and l.unshelved_at is null and not l.cost_stale;
  select coalesce(sum(m.qty), 0) into v_open
    from public.stock_moves m
   where m.item_id = p_item and m.org_id = v_org and m.kind = 'short' and m.undone_at is null and m.settled_by is null;
  v_walk_qty := least(v_qty, greatest(v_reach - v_open, 0));
  v_walk := public.stock_take_fifo(v_org, p_item, p_job, v_walk_qty, v_group, v_src, nullif(btrim(p_note), ''));
  v_short := (v_qty - v_walk_qty) + (v_walk->>'uncovered')::numeric;
  -- /0347
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
end $function$;

-- ── stock_move_names_its_credit(): 1 message ──
CREATE OR REPLACE FUNCTION public.stock_move_names_its_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception 'That credit is filed on a job, where it would come off the customer''s bill. A return from Shop Stock is tied to a credit filed to Shop Stock.'
      using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- ── stock_recount(uuid,numeric,text): 6 messages ──
CREATE OR REPLACE FUNCTION public.stock_recount(p_item uuid, p_counted numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_org     uuid := public.auth_org_id();
  v_item    record;
  v_count   numeric := round(coalesce(p_counted, -1), 3);
  v_on_hand numeric;
  v_rem     numeric;
  v_lot     record;
  v_take    numeric;
  v_id      uuid;
  v_moves   jsonb := '[]'::jsonb;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null or v_org is null or not public.is_org_staff() then
    raise exception 'Only the office counts this company''s stock.' using errcode = '42501';
  end if;
  if v_count < 0 then
    raise exception 'Say how many are in stock (0 if none).' using errcode = 'P0001';
  end if;
  if v_count > 1000000 then
    raise exception 'That count looks too big. Check it and try again.' using errcode = 'P0001';
  end if;
  select id, org_id, name, unit into v_item from public.inventory_items where id = p_item;
  if not found or v_item.org_id is distinct from v_org then
    raise exception 'That item isn''t in this company''s stock.' using errcode = '42501';
  end if;

  -- The item's lock, the one stock_draw takes, so a count and a take happen one after the other.
  perform pg_advisory_xact_lock(hashtext('cn.stock:' || p_item::text));
  select quantity_on_hand into v_on_hand from public.inventory_items where id = p_item;
  v_on_hand := coalesce(v_on_hand, 0);

  if v_count = v_on_hand then
    return jsonb_build_object('moves', v_moves, 'on_hand', v_on_hand, 'changed', false);
  end if;

  if v_count > v_on_hand then
    insert into public.stock_moves (org_id, item_id, lot_id, kind, qty, source, note)
    values (v_org, p_item, null, 'recount_up', v_count - v_on_hand, 'office', coalesce(v_note, 'Counted in stock'))
    returning id into v_id;
    v_moves := v_moves || jsonb_build_array(jsonb_build_object('move_id', v_id, 'kind', 'recount_up', 'qty', v_count - v_on_hand));
  else
    v_rem := v_on_hand - v_count;
    for v_lot in
      select l.id, b.pieces_left
        from public.stock_lots l
        join public.stock_lot_balance b on b.lot_id = l.id
       where l.item_id = p_item and l.org_id = v_org and l.unshelved_at is null and not l.cost_stale
       order by l.bought_on, l.created_at, l.id
         for update of l
    loop
      exit when v_rem <= 0;
      continue when v_lot.pieces_left <= 0;
      v_take := least(v_lot.pieces_left, v_rem);
      insert into public.stock_moves (org_id, item_id, lot_id, kind, qty, source, note)
      values (v_org, p_item, v_lot.id, 'recount_down', v_take, 'office', coalesce(v_note, 'Counted in stock'))
      returning id into v_id;
      v_moves := v_moves || jsonb_build_array(jsonb_build_object('move_id', v_id, 'kind', 'recount_down', 'lot_id', v_lot.id, 'qty', v_take));
      v_rem := v_rem - v_take;
    end loop;
    if v_rem > 0 then
      raise exception 'The stock record holds % % more than the rolls it can count down (a roll being restamped, or pieces found without a roll). Restamp or undo that first. Nothing was changed.',
        v_rem, v_item.unit using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'moves', v_moves,
    'on_hand', (select quantity_on_hand from public.inventory_items where id = p_item),
    'changed', true
  );
end $function$;

-- ── stock_undo(uuid): 1 message ──
CREATE OR REPLACE FUNCTION public.stock_undo(p_group uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 0343: the invoice claim lock first (an import and a carry-back take it too), then the take's
  -- rows in id order - the order the invoice-line guard locks them in - so they queue, never deadlock.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || v_org::text));
  perform 1 from public.stock_moves m where m.draw_group = p_group order by m.id for update;
  if not found or exists (select 1 from public.stock_moves m where m.draw_group = p_group and m.org_id is distinct from v_org) then
    raise exception 'That take isn''t on this company''s stock record.' using errcode = '42501';
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
end $function$;

-- ── Self-check: the new bodies, and not one message says shelf ──────────────────────────────────
do $$
declare
  r record;
  v_md5 text;
begin
  for r in select * from (values
    ('public.freeze_used_stock_bill()', 'ca32c43b26b0f6bf543e1e5dd9088b00', '25d6fb74a4fb1e876c412a3dd15af76a'),
    ('public.freeze_used_stock_lot()', 'dd22945bf3b9806bbf64f80e7d8aa613', 'f6916ecd5e4e00924e367c5e55616cf7'),
    ('public.guard_invoice_unvoid_stock()', 'da50a51f1cb2df069452bfee89dca48d', 'ee2379ac30dc502e66de6a315091b883'),
    ('public.guard_shelf_credit_bill()', 'dda0cbc6c68807f4b77617929c728ea9', 'b01b2b696548bf099d70c16ba5749907'),
    ('public.guard_stock_item_delete()', 'af86d120febd8537b2ea6a3b7ff54b0f', '2d0ab3a5e6d2ea040005c07f192b2f75'),
    ('public.guard_stock_item()', '8ef6428bfa4c36ed7ea3aafdc788e688', 'b5d43047080d2bf3496625dc689d3f48'),
    ('public.guard_stock_line()', '2f5161b28f561b654a4bfa6ee8a4d6f5', '720d46fca6a53d785f80939b9a0fc917'),
    ('public.guard_stock_lot()', 'a4dd77904a6912747844e37576870d8f', '6ecede2ce22675742ace373464bdfd5f'),
    ('public.guard_stock_move_exported()', 'd99d2b39127f17a0c2c739218611de5f', 'f3d802ad0739bbf49fd5378febcbeadc'),
    ('public.guard_stock_move()', 'ec7ccb03d0bafa144938c8aeeecfb6de', '5eb0cb386e4787b06939c20b87e27703'),
    ('public.guard_stock_piece_claim()', '4d74f15464f2034b051f241ca7f176c2', 'c07af83bd827446e48410e343593575e'),
    ('public.mark_already_billed(uuid,uuid[])', '1804a59654df4f6277a68693da85ecd6', 'bac66e17c1bd4d4e7e296a82ad5cbc91'),
    ('public.settle_short(uuid)', 'a03d60796072da825e5d7cea6048bdb2', '7d22bc9f88daa71f544047a7a4b1cde6'),
    ('public.shelve_bill_lines(uuid,jsonb,jsonb)', 'f8328784ce3f741f2a96f7b2ac8c4c2b', '915600382618f5cbf994d2553d959957'),
    ('public.stamp_stock_move()', 'e107d05b935a3569df7559311dfd90a6', '69b074028ce02e8e43bdf3f4e6b61298'),
    ('public.stock_draw(uuid,uuid,numeric,text,text)', 'ba67639f1b087dbc43cb816f31a4c12d', '74b08eb7aeaf296a9c5ab8db352fde1d'),
    ('public.stock_move_names_its_credit()', 'd4156d2680a180fdb3d978c98365cc24', 'b60d8a66856b66e30a6600d3975744d8'),
    ('public.stock_recount(uuid,numeric,text)', 'ed396f9088b14e36bd564ed75f506b64', '6f5d2864686f2bf36a19f48b077109b8'),
    ('public.stock_undo(uuid)', '58980537221cec6ced57acbe567b255f', 'b7f7eca8559b73a539aa9d0df8fc3edb')
  ) as t(fn, old_md5, new_md5) loop
    select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure(r.fn);
    if v_md5 is distinct from r.new_md5 then
      raise exception '0364: % did not come out as written (md5 %, expected %). Nothing was changed.', r.fn, v_md5, r.new_md5;
    end if;
  end loop;
  raise notice '0364: stock says stock in 19 functions.';
end $$;
