-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0347: a take leaves open shorts their pieces (Shop Stock, audit v1018)
--
-- THE DEFECT (audit v1018, stock-3). The shelf's count (refresh_stock_on_hand, 0303) takes every
-- open short off: pieces taken past the shelf are owed to it. What a take can REACH did not:
-- shelf_for_crew.takeable (0344) and stock_take_fifo's walk (0303) both counted every piece left on
-- a live roll, including the pieces an older short is waiting for. So:
--
--   A tech takes 20 ft from an empty shelf: a 20 ft short. The office files a 100 ft roll:
--   on_hand 80, takeable 100. A tech types 90: the sheet warns "10 ft more than the shelf shows",
--   stock_draw takes all 90 off the roll and records no short, the toast and the office's bell say
--   nothing, the shelf reads -10, and Settle From The Shelf on the first short then refuses ("Only
--   10 on the shelf, and 20 were taken past it"). The sheet, the toast and the bell disagree, and the
--   first 20 ft sit at $0 until yet another roll arrives.
--
-- THE FIX: the item's open shorts (live, not settled) come off what a NEW take can reach, in both
-- places that decide it, in one spelling:
--
--   1. stock_draw walks at most (pieces on live, settled rolls - open shorts) and records the rest
--      as this take's own short. The older short keeps its pieces, so Settle From The Shelf still
--      works for it; the new take says its own short, before the tap (the sheet), after it (the
--      toast) and to the office (the bell). settle_short is NOT changed: settling one short from
--      the roll is exactly what the reserved pieces are for.
--   2. shelf_for_crew.takeable is the same figure, so what the sheet warns before the tap is what
--      stock_draw records after it (0344's promise, kept).
--
-- With no open short on the item, both are exactly what they were.
--
-- LIVE BODIES (production, read 2026-09-26 with pg_get_functiondef):
--   stock_draw(uuid,uuid,numeric,text,text)  prosrc md5 07dbdaa9c361662432c001aead4fa824 (0303)
--   shelf_for_crew()                         prosrc md5 5c3c6e8e9006abc8fac0b2546150e58b (0344)
-- Each body below is that one, with the 0347 pieces marked in place. Grants and comments as live.
--
-- LOCKS: two functions. No table DDL, no trigger.
--
-- WHAT THIS CHANGES TODAY: nothing anyone can see. Production has 0 stock moves (0 shorts).
--
-- ORDER: after 0344 (shelf_for_crew's takeable column). Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.stock_draw(uuid,uuid,numeric,text,text)') is null
     or to_regprocedure('public.shelf_for_crew()') is null
     or to_regprocedure('public.stock_take_fifo(uuid,uuid,uuid,numeric,uuid,text,text)') is null then
    raise exception '0347: the shelf (0303) and the crew''s shelf read (0344) are not on this database. Apply them first. Nothing was changed.';
  end if;
  if position('takeable' in pg_get_function_result('public.shelf_for_crew()'::regprocedure)) = 0 then
    raise exception '0347: shelf_for_crew has no takeable column (0344 not applied). Nothing was changed.';
  end if;
end $$;

-- ── 1. stock_draw: the live body, and a new take walks only what open shorts leave ────────────────
create or replace function public.stock_draw(p_item uuid, p_job uuid, p_qty numeric, p_note text default null::text, p_source text default null::text)
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
  v_reach  numeric;  -- 0347
  v_open   numeric;  -- 0347
  v_walk_qty numeric;  -- 0347
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
end $$;

revoke execute on function public.stock_draw(uuid, uuid, numeric, text, text) from public, anon;
grant execute on function public.stock_draw(uuid, uuid, numeric, text, text) to authenticated, service_role;

-- ── 2. shelf_for_crew: the live body, with takeable less the open shorts ──────────────────────────
-- Same return shape as 0344, so create or replace (no drop).
create or replace function public.shelf_for_crew()
returns table (id uuid, name text, unit text, on_hand numeric, takeable numeric)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.name, i.unit, i.quantity_on_hand as on_hand,
         -- stock_take_fifo's walk: live rolls, not being repriced, pieces left (0303/0304), less the
         -- item's open shorts (0347: those pieces are owed to older takes; stock_draw holds them back).
         greatest(
           coalesce((select sum(greatest(b.pieces_left, 0))
                       from public.stock_lot_balance b
                      where b.item_id = i.id and b.org_id = i.org_id and b.live and not b.cost_stale), 0)
           - coalesce((select sum(m.qty)
                         from public.stock_moves m
                        where m.item_id = i.id and m.org_id = i.org_id and m.kind = 'short'
                          and m.undone_at is null and m.settled_by is null), 0),
           0) as takeable
    from public.inventory_items i
   where i.org_id = public.auth_org_id()
     and public.auth_org_id() is not null
     and i.active
   order by i.name, i.id;
$$;

comment on function public.shelf_for_crew() is
  'What the crew may read from the shelf (0302, 0344, 0347): id, name, unit, on hand, and how much of it a take can reach (pieces on live, settled rolls, less what open shorts are owed). Never a cost, vendor or part number. Active members of the caller''s own org only.';
revoke execute on function public.shelf_for_crew() from public, anon;
grant execute on function public.shelf_for_crew() to authenticated, service_role;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_proc
     where oid = 'public.stock_draw(uuid,uuid,numeric,text,text)'::regprocedure
       and prosecdef and coalesce(proconfig::text, '') like '%search_path=public%'
       and position('v_open' in prosrc) > 0
       and position('stock_take_fifo' in prosrc) > 0
  ) or has_function_privilege('anon', 'public.stock_draw(uuid,uuid,numeric,text,text)', 'execute')
    or not has_function_privilege('authenticated', 'public.stock_draw(uuid,uuid,numeric,text,text)', 'execute') then
    raise exception '0347: stock_draw is not the signed-in take that leaves open shorts their pieces. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
     where oid = 'public.shelf_for_crew()'::regprocedure
       and prosecdef and coalesce(proconfig::text, '') like '%search_path=public%'
       and position('settled_by is null' in prosrc) > 0
       and position('cost' in regexp_replace(prosrc, 'cost_stale', '', 'g')) = 0
  ) or has_function_privilege('anon', 'public.shelf_for_crew()', 'execute')
    or not has_function_privilege('authenticated', 'public.shelf_for_crew()', 'execute') then
    raise exception '0347: shelf_for_crew is not the cost-free crew read with open shorts held back. Nothing was changed.';
  end if;
  raise notice '0347: a take leaves open shorts their pieces.';
end $$;
