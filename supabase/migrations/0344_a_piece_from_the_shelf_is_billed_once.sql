-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0344: a piece from the shelf is billed once (Shop Stock, Phase 3)
--
-- Erik's decision 3 (2026-09-25): a tech's Took From Stock counts on the job RIGHT AWAY, with a
-- bell to the office and Undo until it is billed. The take itself is 0303's stock_draw. This file
-- is the boundary around BILLING it and around UNDOING it once billed, plus the one read the crew
-- needs to see a job's takes without ever reading a cost.
--
-- 1. THE CLAIM BOUNDARY LEARNS WHAT A STOCK MOVE IS (guard_invoice_item_claim, 0258/0260).
--    A take is billed by its move ids in invoice_items.source_ids (import_key 'stock:'+draw_group),
--    and 0258's rule already holds any uuid to ONE non-void invoice in the org, so the same piece
--    can never sit on two live invoices. What the rule could not know is whether the id it guards
--    is a piece that is still on the job. Tonight a direct write, or a hand-carried claim, could
--    bill:
--      · a take that was UNDONE (the pieces are back on the shelf, and the customer pays for them);
--      · a SHORT, pieces taken past what the shelf showed, which cost $0 until the office settles
--        them from a roll (settle_short writes real draws, with their own ids, for that);
--      · a recount, a write-off or a return to the supplier, which are never a customer's;
--      · another company's move id.
--    And an undo and a claim of the same piece could pass each other in the dark: stock_undo reads
--    "nobody bills this" and undoes, while an import that read "this take is live" commits its
--    claim. The guard now locks every stock move it is asked to claim FOR SHARE (stock_undo locks
--    the take's rows FOR UPDATE before it reads the claim), so the two go one after the other and
--    the second one sees the first. The word in the refusal becomes "materials".
--
-- 2. UN-VOID LEARNS IT TOO (guard_invoice_unvoid, 0259/0260). Voiding an invoice releases its
--    claims (the 0255 law), and a released take can then be undone. Bringing that invoice back
--    from void would bill pieces that are on the shelf again. Refused, with the reason.
--
-- 3. stock_takes_for_job(p_job): THE JOB'S TAKES, FOR EVERYONE WHO WORKS THE JOB, WITH NO COST.
--    stock_moves is staff-only under RLS (0303), and the crew must still see "Brian took 60 ft of
--    12/2 NM-B, 9/24 · Undo" on the job's Materials tab, and see why an Undo became "Take It Off
--    INV-078 First". Date, item, count, who, the unsettled short, what was brought back, the
--    invoice that bills it, and whether THIS caller may undo it (0303's stock_undo rule: the office
--    any take, a tech only his own, nobody a billed one). Never a cost, never a lot, never a
--    supplier. A take that settled a short is folded into the take it settled, so one take reads
--    as one row.
--
-- 4. shelf_for_crew() LEARNS WHAT A TAKE CAN REACH (0302's body, from production 2026-09-25, md5
--    80768b2ecfed8cf1af2f9cab43743c05, plus one column). on_hand is the shelf's count, and it holds
--    pieces stock_draw steps over: a Count It that found pieces with no roll behind them (recount_up,
--    lot_id null) and a roll whose receipt changed (cost_stale). A take of those saves as a short, so
--    a sheet that warned from on_hand said "100 ft on the shelf" with no warning and then toasted a
--    40 ft short. `takeable` is the pieces left on live, settled rolls, the same walk stock_take_fifo
--    makes; the sheet warns from it. A count, never a cost. The return shape changes, so the function
--    is dropped and made again (nothing depends on it: pg_depend showed 0 dependents), with 0302's
--    grants.
--
-- HOW THE TWO GUARDS ARE REWRITTEN: FROM THEIR LIVE BODIES (the 0315 / 0326 / 0335 / 0342
-- technique). pg_get_functiondef of each, in production, 2026-09-25 (md5 70a23ca65ab3b1e6df24a22801f7690a
-- and 7493be55854401ff06f7476a25d5d274): guard_invoice_item_claim as 0260 left it and 0290 cut
-- (time_allocations gone from the hours word), guard_invoice_unvoid as 0260 left it. Each block
-- below is INSERTED at an anchor copied from those bodies, and each anchor must appear exactly
-- once or nothing is changed. A body that already carries the 0344 marker is left alone
-- (re-running this file is a no-op). Nothing else in either function moves.
--
-- WHAT THIS CHANGES TODAY: nothing anyone can see. Production has 0 lots, 0 moves and 0 items, so no
-- invoice line holds a stock move id, every claim and un-void reads exactly as before (the new
-- blocks run only when a claimed id IS a stock move), and the self-check at the bottom proves the
-- hours/materials/work words and the org lock survived.
--
-- ORDER: after 0303/0304 (stock_moves, stock_undo) and 0260/0290 (the guards as they stand).
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.stock_moves') is null or to_regprocedure('public.stock_undo(uuid)') is null then
    raise exception '0344: the shelf''s ledger (0303) is not on this database. Apply 0302-0304 first. Nothing was changed.';
  end if;
  if to_regprocedure('public.guard_invoice_item_claim()') is null or to_regprocedure('public.guard_invoice_unvoid()') is null then
    raise exception '0344: the claim guards (0258/0259/0260) are not on this database. Nothing was changed.';
  end if;
  if position('cn.invoice_claim:' in pg_get_functiondef('public.guard_invoice_item_claim()'::regprocedure)) = 0 then
    raise exception '0344: guard_invoice_item_claim is older than 0260 (no org lock). Apply 0260 first. Nothing was changed.';
  end if;
end $$;

-- ── 1. guard_invoice_item_claim: a claimed stock move must be a live take onto this job ─────────
do $$
declare
  v_def text;
  v_n   int;
  -- anchor, replacement
  a_decl_old text := $a$  v_what  text;$a$;
  a_decl_new text := $a$  v_what  text;
  v_mv    record; -- 0344$a$;
  a_read_old text := $a$  -- The earliest OTHER non-void invoice holding any of these ids, and which ids it holds.$a$;
  a_read_new text := $a$  -- A PIECE FROM THE SHELF (0344). A stock move is billable only while it is a live take onto a
  -- job in this org (a draw, not undone). Like an hour, a piece is judged on WHAT it is, not on
  -- which job's invoice names it (0258: any job, one live invoice). A short has no cost until
  -- the office settles it from a roll (settle_short writes real draws with their own ids); a
  -- recount, a write-off or a return is never a customer's. FOR SHARE: stock_undo locks the take's
  -- rows FOR UPDATE before it reads the claim, so an undo and a claim of the same piece go one
  -- after the other, and whichever is second sees the first.
  for v_mv in
    select m.id, m.org_id, m.kind, m.undone_at
      from public.stock_moves m
     where m.id = any (v_added)
     order by m.id
       for share
  loop
    if v_mv.org_id is distinct from v_org then
      raise exception 'those pieces from stock aren''t this company''s' using errcode = '42501';
    end if;
    if v_mv.undone_at is not null then
      raise exception 'that take from stock was undone, so there is nothing to bill for it'
        using errcode = 'P0001', hint = 'The pieces are back on the shelf. Take the line off, or take them again with Took From Stock.';
    end if;
    if v_mv.kind = 'short' then
      raise exception 'pieces taken past what the shelf showed have no cost yet'
        using errcode = 'P0001', hint = 'Settle them from a roll on the shelf first; the settled pieces bill as their own line.';
    end if;
    if v_mv.kind <> 'draw' then
      raise exception 'only pieces taken for a job can go on an invoice' using errcode = 'P0001';
    end if;
  end loop;

  -- The earliest OTHER non-void invoice holding any of these ids, and which ids it holds.$a$;
  a_word_old text := $a$    when exists (select 1 from public.bills b where b.id = any (v_hit.ids))$a$;
  a_word_new text := $a$    when exists (select 1 from public.stock_moves sm where sm.id = any (v_hit.ids)) then 'materials' -- 0344
    when exists (select 1 from public.bills b where b.id = any (v_hit.ids))$a$;
  pairs text[][];
  i int;
begin
  v_def := pg_get_functiondef('public.guard_invoice_item_claim()'::regprocedure);
  if position('0344' in v_def) > 0 then
    raise notice '0344: guard_invoice_item_claim already knows stock moves; left as it is.';
    return;
  end if;
  pairs := array[array[a_decl_old, a_decl_new], array[a_read_old, a_read_new], array[a_word_old, a_word_new]];
  for i in 1 .. array_length(pairs, 1) loop
    v_n := (length(v_def) - length(replace(v_def, pairs[i][1], ''))) / length(pairs[i][1]);
    if v_n <> 1 then
      raise exception '0344: guard_invoice_item_claim anchor % appears % time(s), not once, so the live body changed since 0260/0290. Nothing was changed.', i, v_n;
    end if;
    v_def := replace(v_def, pairs[i][1], pairs[i][2]);
  end loop;
  execute v_def;
end $$;

-- ── 2. guard_invoice_unvoid: a voided invoice whose take was undone stays void ──────────────────
do $$
declare
  v_def text;
  v_n   int;
  a_decl_old text := $a$  live   text;$a$;
  a_decl_new text := $a$  live   text;
  v_undone text; -- 0344$a$;
  a_block_old text := $a$    -- (2) 0259, unchanged:$a$;
  a_block_new text := $a$    -- (1b) 0344: A PIECE FROM THE SHELF THAT WENT BACK. Voiding released this invoice's takes
    -- from stock, and a released take can be undone (its pieces go back on the shelf). Coming back
    -- from void would bill pieces that are no longer on the job. Locked FOR SHARE, as the claim
    -- guard does, so an undo of the same take waits for this or is seen by it (the lock first, then
    -- the read, which is its own statement and so sees whatever the undo committed).
    perform 1
       from public.stock_moves m
      where m.id in (select unnest(li.source_ids) from public.invoice_items li where li.invoice_id = new.id)
      order by m.id
        for share;
    select string_agg(distinct coalesce(i.name, 'stock'), ', ')
      into v_undone
      from public.invoice_items li
      join public.stock_moves m on m.id = any (li.source_ids)
      left join public.inventory_items i on i.id = m.item_id
     where li.invoice_id = new.id
       and (m.undone_at is not null or m.kind <> 'draw' or m.org_id is distinct from new.org_id);
    if v_undone is not null then
      raise exception 'pieces from stock on this invoice (%) were taken back off the job after it was voided', v_undone
        using errcode = 'P0001',
              hint = 'Their take was undone, so they are on the shelf again. Leave this invoice void and bill what is on the job on a fresh one.';
    end if;

    -- (2) 0259, unchanged:$a$;
  pairs text[][];
  i int;
begin
  v_def := pg_get_functiondef('public.guard_invoice_unvoid()'::regprocedure);
  if position('0344' in v_def) > 0 then
    raise notice '0344: guard_invoice_unvoid already knows stock moves; left as it is.';
    return;
  end if;
  pairs := array[array[a_decl_old, a_decl_new], array[a_block_old, a_block_new]];
  for i in 1 .. array_length(pairs, 1) loop
    v_n := (length(v_def) - length(replace(v_def, pairs[i][1], ''))) / length(pairs[i][1]);
    if v_n <> 1 then
      raise exception '0344: guard_invoice_unvoid anchor % appears % time(s), not once, so the live body changed since 0260. Nothing was changed.', i, v_n;
    end if;
    v_def := replace(v_def, pairs[i][1], pairs[i][2]);
  end loop;
  execute v_def;
end $$;

-- ── 3. stock_takes_for_job: the job's takes, for the crew and the office, never a cost ──────────
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

-- ── 4. shelf_for_crew: the count, and what a take can reach ────────────────────────────────────
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
declare
  v_claim  text := pg_get_functiondef('public.guard_invoice_item_claim()'::regprocedure);
  v_unvoid text := pg_get_functiondef('public.guard_invoice_unvoid()'::regprocedure);
  v_bad    int;
begin
  -- The new blocks landed.
  if position('0344' in v_claim) = 0 or position('from public.stock_moves m' in v_claim) = 0 or position('for share' in v_claim) = 0 then
    raise exception '0344: guard_invoice_item_claim does not carry the stock-move block. Nothing was changed.';
  end if;
  if position('0344' in v_unvoid) = 0 or position('were taken back off the job' in v_unvoid) = 0 then
    raise exception '0344: guard_invoice_unvoid does not carry the stock-move block. Nothing was changed.';
  end if;
  -- What was there survived: the org lock (0260), the three words (0258, as 0290 left hours), the
  -- un-void's legacy check (0260 part 1) and its 0259 overlap read.
  if position('cn.invoice_claim:' in v_claim) = 0
     or position('time_entries te' in v_claim) = 0
     or position('time_allocations' in v_claim) > 0
     or position('public.purchase_orders p' in v_claim) = 0
     or position('already billed on' in v_claim) = 0 then
    raise exception '0344: guard_invoice_item_claim lost part of its 0258/0260/0290 body. Nothing was changed.';
  end if;
  if position('cn.invoice_claim:' in v_unvoid) = 0
     or position('nothing on this invoice records what it billed' in v_unvoid) = 0
     or position('work already billed on' in v_unvoid) = 0 then
    raise exception '0344: guard_invoice_unvoid lost part of its 0259/0260 body. Nothing was changed.';
  end if;
  -- Still definer, still pinned, still attached.
  if exists (
    select 1 from pg_proc
     where oid in ('public.guard_invoice_item_claim()'::regprocedure, 'public.guard_invoice_unvoid()'::regprocedure, 'public.stock_takes_for_job(uuid)'::regprocedure)
       and (not prosecdef or not coalesce(proconfig::text, '') like '%search_path=public%')
  ) then
    raise exception '0344: a guard or the takes read is not security definer with search_path pinned. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'invoice_items_claim_is_a_boundary' and tgrelid = 'public.invoice_items'::regclass)
     or not exists (select 1 from pg_trigger where tgname = 'invoices_unvoid_is_a_boundary' and tgrelid = 'public.invoices'::regclass) then
    raise exception '0344: a claim trigger is no longer attached. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.stock_takes_for_job(uuid)', 'execute') then
    raise exception '0344: stock_takes_for_job is callable without signing in. Nothing was changed.';
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
  -- Nothing billed today reads differently: no live line claims a stock move yet.
  select count(*) into v_bad
    from public.invoice_items it join public.stock_moves m on m.id = any (it.source_ids);
  raise notice '0344: the claim guards know stock moves (% invoice line(s) claim one today); stock_takes_for_job is in place; shelf_for_crew says what a take can reach.', v_bad;
end $$;
