-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0328: putting things on the shelf (Shop Stock, Phase 2)
--
-- Two new functions. Nothing here replaces an existing function, table, policy or trigger, and
-- no row is written by the migration itself.
--
-- 1. shelve_bill_lines(bill, lines, restamp): every roll one ticket puts on the shelf, in ONE
--    transaction. A roll off a receipt line is two writes that must land together: what the job
--    used (bill_line_items.billed_amount, 0272) and the lot itself (stock_lots, 0303). Written one
--    after the other from the app, a failure between them left the customer billed for less while
--    nothing went on the shelf - a job cost with a hole in it and no roll to show for it. Here they
--    land together or not at all.
--
--    THE ARITHMETIC IS NOT HERE. What each roll costs is shelfLotCost (src/lib/bill-itemisation.ts),
--    the ONE copy of the tax arithmetic, worked out by the server over the ticket's lines as they
--    will stand (planShelving, src/lib/shelf-plan.ts) and handed in. guard_stock_lot (0303) still
--    caps every roll at the paper, so a figure handed in any other way can never be worth more than
--    the receipt. The order inside is what keeps every cap honest:
--      a. every picked line's billed_amount (0304 marks any roll already on the ticket stale);
--      b. those rolls restamped to their new share (the tax is re-split once more lines come off),
--         which clears the stale flag;
--      c. the new rolls, each on an item that exists or is made here in the roll's unit.
--
--    SECURITY INVOKER: it runs as the signed-in person, so every row security policy and every
--    trigger on bills, bill_line_items, inventory_items and stock_lots judges it exactly as it
--    judges a direct write. Only the office passes those (0302/0303), and the org is checked
--    here first as well.
--
--    A TICKET A CUSTOMER ALREADY HOLDS IS REFUSED. A receipt claimed by a sent, part-paid or paid
--    invoice has been charged to that customer as it stands; taking part of it off the job now
--    would put the same roll on the shelf that the customer already paid for. A DRAFT claimant is
--    not a wall (the Herringbone 8/19 coil on INV-078): the draft is refreshed from the receipt.
--
-- 2. stock_recount(item, counted, note): Count It on Shop Stock. The shelf's count is the
--    ledger's, never typed (0303); a count that disagrees is written as moves. Fewer than the
--    record: recount_down moves, oldest roll first, each stamped by the database at the roll's
--    cost (Shop Stock Lost in owner money). More: one recount_up move with no roll behind it, at
--    $0 (there is no paper for a found piece). Both are the office's upkeep moves 0303's policy
--    already lets staff write; this only walks the rolls under the item's lock, so a count and a
--    take never cross.
--
-- ORDER: after 0302-0304. Apply BEFORE the Phase 2 code deploys; until it is applied the new
-- doors say so in words ("needs one more database update") and nothing else changes.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.shelve_bill_lines(p_bill uuid, p_lines jsonb, p_restamp jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
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
    raise exception 'Only the office puts things on this company''s shelf.' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Say what goes on the shelf first.' using errcode = 'P0001';
  end if;
  if p_restamp is not null and jsonb_typeof(p_restamp) <> 'array' then
    raise exception 'The rolls to restamp came in the wrong shape. Nothing was changed.' using errcode = 'P0001';
  end if;

  select b.id, b.org_id, b.superseded_by_bill_id into v_bill from public.bills b where b.id = p_bill;
  if not found or v_bill.org_id is distinct from v_org then
    raise exception 'That ticket isn''t in this company.' using errcode = '42501';
  end if;
  if v_bill.superseded_by_bill_id is not null then
    raise exception 'That ticket was set aside for a later bill. Put its lines on the shelf from the bill that replaced it.'
      using errcode = 'P0001';
  end if;

  -- The ticket's shelf lock (the one guard_stock_lot and 0304's lock_stock_bill take), so two
  -- people shelving the same ticket, or a shelving and a receipt edit, go one after the other.
  perform pg_advisory_xact_lock(hashtext('cn.stock_bill:' || p_bill::text));

  select coalesce(i.invoice_number, 'An invoice') into v_holder
    from public.invoice_items it
    join public.invoices i on i.id = it.invoice_id
   where (it.source_ids @> array[p_bill] or it.import_key = 'bill:' || p_bill::text)
     and i.status not in ('void', 'draft')
   order by i.created_at, i.id
   limit 1;
  if v_holder is not null then
    raise exception '% has gone to the customer and already bills this ticket, so what it used can''t change now. Nothing went on the shelf.', v_holder
      using errcode = 'P0001';
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
      raise exception 'A roll already on the shelf from this ticket changed while this was open. Reload and try again. Nothing was changed.'
        using errcode = 'P0001';
    end if;
  end loop;

  -- c. the new rolls
  for r in select value from jsonb_array_elements(p_lines) loop
    v_line := (r->>'line_id')::uuid;
    v_item := nullif(r->>'item_id', '')::uuid;
    if v_item is null then
      if length(btrim(coalesce(r->>'item_name', ''))) = 0 then
        raise exception 'Name the item this goes on the shelf as. Nothing was changed.' using errcode = 'P0001';
      end if;
      insert into public.inventory_items (org_id, name, unit, key_part, quantity_on_hand, reorder_point)
      values (v_org, left(btrim(r->>'item_name'), 200), btrim(r->>'unit'), nullif(btrim(coalesce(r->>'key_part', '')), ''), 0, 0)
      returning id into v_item;
    end if;
    insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost)
    values (v_org, v_item, 'line', v_line, round((r->>'pieces')::numeric, 3), btrim(r->>'unit'), round((r->>'cost')::numeric, 2))
    returning id into v_lot;
    v_out := v_out || jsonb_build_array(jsonb_build_object('lot_id', v_lot, 'item_id', v_item, 'line_id', v_line));
  end loop;

  return jsonb_build_object('lots', v_out);
end $$;

comment on function public.shelve_bill_lines(uuid, jsonb, jsonb) is
  'Shop Stock Phase 2 (0328): what each picked line''s job used, the ticket''s take-less rolls restamped, and the new rolls, in one transaction. Costs come from shelfLotCost in TypeScript and are capped at the paper by guard_stock_lot. Security invoker: the office only, by the tables'' own policies.';
revoke execute on function public.shelve_bill_lines(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.shelve_bill_lines(uuid, jsonb, jsonb) to authenticated, service_role;

create or replace function public.stock_recount(p_item uuid, p_counted numeric, p_note text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
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
    raise exception 'Only the office counts this company''s shelf.' using errcode = '42501';
  end if;
  if v_count < 0 then
    raise exception 'Say how many are on the shelf (0 if none).' using errcode = 'P0001';
  end if;
  if v_count > 1000000 then
    raise exception 'That count looks too big. Check it and try again.' using errcode = 'P0001';
  end if;
  select id, org_id, name, unit into v_item from public.inventory_items where id = p_item;
  if not found or v_item.org_id is distinct from v_org then
    raise exception 'That item isn''t on this company''s shelf.' using errcode = '42501';
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
    values (v_org, p_item, null, 'recount_up', v_count - v_on_hand, 'office', coalesce(v_note, 'Counted on the shelf'))
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
      values (v_org, p_item, v_lot.id, 'recount_down', v_take, 'office', coalesce(v_note, 'Counted on the shelf'))
      returning id into v_id;
      v_moves := v_moves || jsonb_build_array(jsonb_build_object('move_id', v_id, 'kind', 'recount_down', 'lot_id', v_lot.id, 'qty', v_take));
      v_rem := v_rem - v_take;
    end loop;
    if v_rem > 0 then
      raise exception 'The shelf''s record holds % % more than the rolls it can count down (a roll being restamped, or pieces found without a roll). Restamp or undo that first. Nothing was changed.',
        v_rem, v_item.unit using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'moves', v_moves,
    'on_hand', (select quantity_on_hand from public.inventory_items where id = p_item),
    'changed', true
  );
end $$;

comment on function public.stock_recount(uuid, numeric, text) is
  'Count It on Shop Stock (0328): a count below the record writes recount_down moves oldest roll first (stamped at cost: Shop Stock Lost); above it, one $0 recount_up. Security invoker: the office only.';
revoke execute on function public.stock_recount(uuid, numeric, text) from public, anon;
grant execute on function public.stock_recount(uuid, numeric, text) to authenticated, service_role;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.shelve_bill_lines(uuid, jsonb, jsonb)') is null
     or to_regprocedure('public.stock_recount(uuid, numeric, text)') is null then
    raise exception '0328: the shelf functions are missing after the migration.';
  end if;
  if exists (
    select 1 from pg_proc
     where oid in ('public.shelve_bill_lines(uuid, jsonb, jsonb)'::regprocedure, 'public.stock_recount(uuid, numeric, text)'::regprocedure)
       and prosecdef
  ) then
    raise exception '0328: the shelf functions must run as the signed-in person (security invoker).';
  end if;
  if to_regprocedure('public.stock_draw(uuid, uuid, numeric, text, text)') is null then
    raise exception '0328: 0303 is not applied (stock_draw is missing). Apply 0302-0304 first.';
  end if;
  raise notice '0328: shelve_bill_lines and stock_recount are in place; no rows were written.';
end $$;
