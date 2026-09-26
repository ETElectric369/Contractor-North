-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0344: the crew reads the job's takes (Shop Stock, Phase 3)
--
-- Erik's decision 3 (2026-09-25): a tech's Took From Stock counts on the job RIGHT AWAY, with a
-- bell to the office and Undo until it is billed. The take itself is 0303's stock_draw; the
-- boundary around BILLING a take, and around undoing or carrying back a billed one, is 0343. This
-- file is the two reads the Took From Stock door needs, and nothing else.
--
-- INTEGRATION NOTE (feat/stock-phase3): the take branch's first draft of this file also rewrote
-- guard_invoice_item_claim and guard_invoice_unvoid (0258/0259/0260) from their live bodies to
-- refuse an undone / short / counted / other-company move id and an un-void after an undo. The
-- bill branch's 0343 does all of that - and more (one line per take, the take's own job only, no
-- jobless invoice, no carry-back of a billed take, Undo on the same claim lock) - as separate
-- triggers that fire BEFORE 0258's guard, without touching the two core guards. Two boundaries
-- saying the same thing in different words (and disagreeing about another job's invoice) is one too
-- many, so those two rewrites were dropped here: the core guards stay exactly as 0260/0290 left
-- them. This file therefore REQUIRES 0343 and refuses without it.
--
-- 1. stock_takes_for_job(p_job): THE JOB'S TAKES, FOR EVERYONE WHO WORKS THE JOB, WITH NO COST.
--    stock_moves is staff-only under RLS (0303), and the crew must still see "Brian took 60 ft of
--    12/2 NM-B, 9/24 · Undo" on the job's Materials tab, and see why an Undo became "Take It Off
--    INV-078 First". Date, item, count, who, the unsettled short, what was brought back, the
--    invoice that bills it (0343's claim: a live line whose source_ids hold the take's move ids),
--    and whether THIS caller may undo it (0303's stock_undo rule: the office any take, a tech only
--    his own, nobody a billed one). Never a cost, never a lot, never a supplier. A take that settled
--    a short is folded into the take it settled, so one take reads as one row.
--
-- 2. shelf_for_crew() LEARNS WHAT A TAKE CAN REACH (0302's body, from production 2026-09-25, md5
--    80768b2ecfed8cf1af2f9cab43743c05, plus one column). on_hand is the shelf's count, and it holds
--    pieces stock_draw steps over: a Count It that found pieces with no roll behind them (recount_up,
--    lot_id null) and a roll whose receipt changed (cost_stale). A take of those saves as a short, so
--    a sheet that warned from on_hand said "100 ft on the shelf" with no warning and then toasted a
--    40 ft short. `takeable` is the pieces left on live, settled rolls, the same walk stock_take_fifo
--    makes; the sheet warns from it. A count, never a cost. The return shape changes, so the function
--    is dropped and made again (nothing depends on it: pg_depend showed 0 dependents), with 0302's
--    grants.
--
-- LOCKS: functions only. No table DDL, no trigger, so no lock on invoices or invoice_items.
--
-- WHAT THIS CHANGES TODAY: nothing anyone can see. Production has 0 lots, 0 moves and 0 items.
--
-- ORDER: after 0343 (which needs 0303/0304 and 0342). Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.stock_moves') is null or to_regprocedure('public.stock_undo(uuid)') is null then
    raise exception '0344: the shelf''s ledger (0303) is not on this database. Apply 0302-0304 first. Nothing was changed.';
  end if;
  if to_regprocedure('public.guard_stock_piece_claim()') is null
     or not exists (select 1 from pg_trigger where tgname = 'invoice_items_a_piece_is_billed_once' and tgrelid = 'public.invoice_items'::regclass)
     or not exists (select 1 from pg_trigger where tgname = 'invoices_unvoid_keeps_its_pieces' and tgrelid = 'public.invoices'::regclass) then
    raise exception '0344: the claim boundary for pieces from the shelf (0343) is not on this database. Apply 0343 first. Nothing was changed.';
  end if;
end $$;

-- ── 1. stock_takes_for_job: the job's takes, for the crew and the office, never a cost ──────────
create or replace function public.stock_takes_for_job(p_job uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid := public.auth_org_id();
  v_staff boolean := coalesce(public.is_org_staff(), false);
  v_out   jsonb;
begin
  if v_uid is null or v_org is null then
    raise exception 'Sign in to see what was taken from stock.' using errcode = '42501';
  end if;
  if p_job is null or not exists (select 1 from public.jobs j where j.id = p_job and j.org_id = v_org) then
    raise exception 'That job isn''t in this company.' using errcode = '42501';
  end if;

  with takes as (
    -- One row per take on this job: its draws and its short, live. A group that only SETTLES an
    -- earlier short is folded into that take below, never a row of its own.
    select m.draw_group,
           min(m.created_at) as taken_at,
           (array_agg(m.item_id order by m.created_at, m.id))[1] as item_id,
           (array_agg(m.created_by order by m.created_at, m.id))[1] as taken_by,
           sum(m.qty) as qty,
           coalesce(sum(m.qty) filter (where m.kind = 'short' and m.settled_by is null), 0) as short_open,
           array_agg(m.id) as ids,
           coalesce(array_agg(distinct m.settled_by) filter (where m.settled_by is not null), '{}'::uuid[]) as settlements
      from public.stock_moves m
     where m.org_id = v_org
       and m.job_id = p_job
       and m.kind in ('draw', 'short')
       and m.undone_at is null
       and m.draw_group is not null
       and not exists (
         select 1 from public.stock_moves s
          where s.org_id = v_org and s.kind = 'short' and s.settled_by = m.draw_group and s.undone_at is null
       )
     group by m.draw_group
  ), whole as (
    select t.*,
           t.ids || coalesce(array(
             select x.id from public.stock_moves x
              where x.org_id = v_org and x.draw_group = any (t.settlements) and x.undone_at is null
           ), '{}'::uuid[]) as all_ids,
           coalesce((
             select bool_and(x.created_by = v_uid) from public.stock_moves x
              where x.org_id = v_org and (x.draw_group = t.draw_group or x.draw_group = any (t.settlements)) and x.undone_at is null
           ), false) as all_mine
      from takes t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'draw_group', w.draw_group,
           'taken_at', w.taken_at,
           'item_id', w.item_id,
           'item', i.name,
           'unit', i.unit,
           'qty', w.qty,
           'short', w.short_open,
           'back', coalesce(b.back, 0),
           'who', coalesce(nullif(btrim(p.full_name), ''), 'Someone'),
           'mine', w.taken_by = v_uid,
           'billed_on', h.invoice_number,
           -- The invoice's id is a door into billing, which is the office's; the crew gets the number.
           'billed_invoice_id', case when v_staff then h.id end,
           'can_undo', h.id is null and coalesce(b.back, 0) = 0 and (v_staff or w.all_mine)
         ) order by w.taken_at desc, w.draw_group), '[]'::jsonb)
    into v_out
    from whole w
    join public.inventory_items i on i.id = w.item_id and i.org_id = v_org
    left join public.profiles p on p.id = w.taken_by
    left join lateral (
      select sum(r.qty) as back from public.stock_moves r
       where r.org_id = v_org and r.kind = 'job_return' and r.undone_at is null and r.returns_move_id = any (w.all_ids)
    ) b on true
    left join lateral (
      select inv.id, coalesce(inv.invoice_number, 'an invoice') as invoice_number
        from public.invoice_items it
        join public.invoices inv on inv.id = it.invoice_id
       where it.source_ids && w.all_ids
         and inv.status <> 'void'
         and inv.org_id = v_org
       order by inv.created_at, inv.id
       limit 1
    ) h on true;
  return v_out;
end $$;

comment on function public.stock_takes_for_job(uuid) is
  'The job''s takes from the shop shelf (0344), for everyone who works the job: date, item, count, who, the unsettled short, what came back, the invoice that bills it, and whether the caller may undo it. Never a cost, a lot or a supplier. Security definer: stock_moves is staff-only under RLS.';
revoke execute on function public.stock_takes_for_job(uuid) from public, anon;
grant execute on function public.stock_takes_for_job(uuid) to authenticated, service_role;

-- ── 2. shelf_for_crew: the count, and what a take can reach ────────────────────────────────────
drop function if exists public.shelf_for_crew();
create function public.shelf_for_crew()
returns table (id uuid, name text, unit text, on_hand numeric, takeable numeric)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.name, i.unit, i.quantity_on_hand as on_hand,
         -- stock_take_fifo's walk: live rolls, not being repriced, pieces left (0303/0304).
         coalesce((select sum(greatest(b.pieces_left, 0))
                     from public.stock_lot_balance b
                    where b.item_id = i.id and b.org_id = i.org_id and b.live and not b.cost_stale), 0) as takeable
    from public.inventory_items i
   where i.org_id = public.auth_org_id()
     and public.auth_org_id() is not null
     and i.active
   order by i.name, i.id;
$$;

comment on function public.shelf_for_crew() is
  'What the crew may read from the shelf (0302, 0344): id, name, unit, on hand, and how much of it a take can reach (pieces on live, settled rolls). Never a cost, vendor or part number. Active members of the caller''s own org only.';

revoke execute on function public.shelf_for_crew() from public, anon;
grant execute on function public.shelf_for_crew() to authenticated, service_role;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  -- 0343's boundary is what the takes list reads "billed on" from; it is still attached.
  if not exists (select 1 from pg_trigger where tgname = 'invoice_items_a_piece_is_billed_once' and tgrelid = 'public.invoice_items'::regclass)
     or not exists (select 1 from pg_trigger where tgname = 'invoices_unvoid_keeps_its_pieces' and tgrelid = 'public.invoices'::regclass) then
    raise exception '0344: 0343''s claim triggers are no longer attached. Nothing was changed.';
  end if;
  -- The core guards are exactly as 0260/0290 left them: this file never touches them.
  if position('0344' in pg_get_functiondef('public.guard_invoice_item_claim()'::regprocedure)) > 0
     or position('0344' in pg_get_functiondef('public.guard_invoice_unvoid()'::regprocedure)) > 0 then
    raise exception '0344: a core claim guard carries an earlier draft of 0344. Nothing was changed.';
  end if;
  -- The takes read: definer, pinned, not anon's.
  if not exists (
    select 1 from pg_proc
     where oid = 'public.stock_takes_for_job(uuid)'::regprocedure
       and prosecdef and coalesce(proconfig::text, '') like '%search_path=public%'
  ) or has_function_privilege('anon', 'public.stock_takes_for_job(uuid)', 'execute')
    or not has_function_privilege('authenticated', 'public.stock_takes_for_job(uuid)', 'execute') then
    raise exception '0344: stock_takes_for_job is not the signed-in, count-only read it should be. Nothing was changed.';
  end if;
  -- shelf_for_crew: definer, pinned, not anon's, and its columns are counts only (never a cost).
  if not exists (
    select 1 from pg_proc
     where oid = 'public.shelf_for_crew()'::regprocedure
       and prosecdef and coalesce(proconfig::text, '') like '%search_path=public%'
       and proargnames = array['id', 'name', 'unit', 'on_hand', 'takeable']::text[]
  ) or has_function_privilege('anon', 'public.shelf_for_crew()', 'execute')
    or not has_function_privilege('authenticated', 'public.shelf_for_crew()', 'execute') then
    raise exception '0344: shelf_for_crew is not the crew''s count-only read it should be. Nothing was changed.';
  end if;
  raise notice '0344: stock_takes_for_job is in place; shelf_for_crew says what a take can reach.';
end $$;
