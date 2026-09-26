-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0345: a take billed in part says so (Shop Stock, Phase 3)
--
-- 0344's stock_takes_for_job folds a settlement (the draw group settle_short makes when the office
-- settles a short from a roll) into the take it settled, so one take reads as one row, and it reads
-- that row as billed when ANY of its moves sits on a live invoice line. The money side bills each
-- draw group as its own line (0303's settle_short mints a new group; stockTakesOnJob keys on
-- draw_group; computeUnbilledWork gives each group its own verdict; the importer writes one
-- stock:<group> line each). So once the original draw is on INV-A and the settled pieces are not yet
-- on any invoice, the Materials tab said "Billed on INV-A" while the Costs tab's Not Billed Yet row
-- (which links straight to that Materials tab), the Unbilled card and work to date all counted the
-- settled pieces as open. Nothing was billed twice or lost; one take read billed on one tab and open
-- on another.
--
-- THE FIX: one more key, `part_billed`: an invoice holds one of the take's units and another unit
-- still has pieces and cost to bill, counted the money side's way (live draws on this job, net of
-- returns, cost above zero, no move on a live line). The row then says "Part billed on INV-A".
-- Nothing else moves: billed_on, billed_invoice_id and can_undo are exactly as 0344 made them (an
-- Undo of the original still cascades to its settlements, and guard_stock_move refuses it while any
-- of their moves is held). Never a cost in the payload: cost is read inside, to answer a yes/no.
--
-- LIVE BODY: 0344 is on production (2026-09-25; stock_takes_for_job prosrc md5
-- 8e852a2da31d3ef641b0a3ac65407e81, identical to 0344's file). This body is that one plus the two
-- 0345 pieces, marked in place.
--
-- LOCKS: one function. No table DDL, no trigger.
--
-- WHAT THIS CHANGES TODAY: nothing anyone can see. Production has 0 stock moves.
--
-- ORDER: after 0344. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.stock_takes_for_job(uuid)') is null then
    raise exception '0345: the job''s takes read (0344) is not on this database. Apply 0343 and 0344 first. Nothing was changed.';
  end if;
end $$;

-- ── stock_takes_for_job: 0344's body, plus part_billed ──────────────────────────────────────────
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
           ), false) as all_mine,
           -- 0345: the take's BILLING UNITS. The money side (stockTakesOnJob, computeUnbilledWork,
           -- the importer) bills each draw group as its own line, and a settlement is its own group.
           array[t.draw_group] || t.settlements as groups
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
           -- 0345: billed in part. An invoice holds one of the take's units and another still has
           -- pieces to bill, exactly as the Costs tab and the Unbilled card count it, so the row can
           -- say "Part billed on INV-A" instead of reading billed where the money side reads open.
           'part_billed', h.id is not null and coalesce(u.open_units, 0) > 0,
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
    ) h on true
    -- 0345: the units still open, counted the money side's way: a group's live draws on this job,
    -- net of what came back, with pieces and cost left (a $0 take bills nothing, so it is never
    -- "open"), and no move of it on a live invoice line (a take is billed whole or not at all).
    left join lateral (
      select count(*) as open_units
        from (
          select d.draw_group,
                 array_agg(d.id) as ids,
                 sum(d.qty) - coalesce(sum(d.back_qty), 0) as net_qty,
                 sum(d.cost) - coalesce(sum(d.back_cost), 0) as net_cost
            from (
              select x.id, x.draw_group, x.qty, x.cost,
                     (select sum(r.qty) from public.stock_moves r
                       where r.org_id = v_org and r.kind = 'job_return' and r.undone_at is null and r.returns_move_id = x.id) as back_qty,
                     (select sum(r.cost) from public.stock_moves r
                       where r.org_id = v_org and r.kind = 'job_return' and r.undone_at is null and r.returns_move_id = x.id) as back_cost
                from public.stock_moves x
               where x.org_id = v_org
                 and x.job_id = p_job
                 and x.kind = 'draw'
                 and x.undone_at is null
                 and x.draw_group = any (w.groups)
            ) d
           group by d.draw_group
        ) g
       where g.net_qty > 0
         and g.net_cost > 0
         and not exists (
           select 1
             from public.invoice_items it
             join public.invoices inv on inv.id = it.invoice_id
            where it.source_ids && g.ids
              and inv.status <> 'void'
              and inv.org_id = v_org
         )
    ) u on true;
  return v_out;
end $$;

comment on function public.stock_takes_for_job(uuid) is
  'The job''s takes from the shop shelf (0344, 0345), for everyone who works the job: date, item, count, who, the unsettled short, what came back, the invoice that bills it, whether another part of it is still unbilled, and whether the caller may undo it. Never a cost, a lot or a supplier. Security definer: stock_moves is staff-only under RLS.';
revoke execute on function public.stock_takes_for_job(uuid) from public, anon;
grant execute on function public.stock_takes_for_job(uuid) to authenticated, service_role;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_proc
     where oid = 'public.stock_takes_for_job(uuid)'::regprocedure
       and prosecdef and coalesce(proconfig::text, '') like '%search_path=public%'
       and position('part_billed' in prosrc) > 0
  ) or has_function_privilege('anon', 'public.stock_takes_for_job(uuid)', 'execute')
    or not has_function_privilege('authenticated', 'public.stock_takes_for_job(uuid)', 'execute') then
    raise exception '0345: stock_takes_for_job is not the signed-in, count-only read with part_billed it should be. Nothing was changed.';
  end if;
  raise notice '0345: a take billed in part says so.';
end $$;
