-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0348: a settled take says who can undo it (Shop Stock, audit v1018)
--
-- THE DEFECT (audit v1018, stock-4). A tech takes 60 ft with 40 on the shelf: a 20 ft short. The
-- office files a roll and taps Settle From The Shelf, and settle_short writes the settlement draws
-- under the office's user. From then on stock_undo refuses the tech ("Only the office can undo a take
-- someone else made, or one the office has settled"), and stock_takes_for_job agrees (can_undo is
-- false: all_mine covers the settlement groups). But nothing said WHY: the tech's own row "You took
-- 60 ft of 12/2" simply lost its Undo, with no reason and no name of who can fix a mis-key.
--
-- THE FIX: one more key, `settled_by_office`: the take has a settlement in it and not every move it
-- reaches is the caller's. The row maps it to "The office settled part of this take, so ask the
-- office to undo it." Nothing else moves: can_undo, billed_on, part_billed are exactly as 0345 made
-- them. A yes/no, never a cost, a lot or a name.
--
-- LIVE BODY: production's stock_takes_for_job (read 2026-09-26 with pg_get_functiondef; prosrc md5
-- b006598eccb2561a8b93f07d01a9e196, 0345's). This body is that one plus the 0348 key, marked in place.
--
-- LOCKS: one function. No table DDL, no trigger.
--
-- WHAT THIS CHANGES TODAY: nothing anyone can see. Production has 0 stock moves.
--
-- ORDER: after 0345. Independent of 0347. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.stock_takes_for_job(uuid)') is null then
    raise exception '0348: the job''s takes read (0344) is not on this database. Apply 0344 and 0345 first. Nothing was changed.';
  end if;
  if position('part_billed' in (select prosrc from pg_proc where oid = 'public.stock_takes_for_job(uuid)'::regprocedure)) = 0 then
    raise exception '0348: stock_takes_for_job is not 0345''s body (no part_billed). Apply 0345 first. Nothing was changed.';
  end if;
end $$;

-- ── stock_takes_for_job: 0345's live body, plus settled_by_office ───────────────────────────────
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
           'can_undo', h.id is null and coalesce(b.back, 0) = 0 and (v_staff or w.all_mine),
           -- 0348: WHY A TECH'S OWN TAKE LOST ITS UNDO. The office settled a short inside it, so the
           -- take now reaches settlement draws the office wrote, and stock_undo refuses anyone but
           -- the office. The row says so instead of going quiet. A yes/no, never who or what it cost.
           'settled_by_office', cardinality(w.settlements) > 0 and not w.all_mine
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
  'The job''s takes from the shop shelf (0344, 0345, 0348), for everyone who works the job: date, item, count, who, the unsettled short, what came back, the invoice that bills it, whether another part of it is still unbilled, whether the caller may undo it, and whether the office''s settlement is why not. Never a cost, a lot or a supplier. Security definer: stock_moves is staff-only under RLS.';
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
       and position('settled_by_office' in prosrc) > 0
  ) or has_function_privilege('anon', 'public.stock_takes_for_job(uuid)', 'execute')
    or not has_function_privilege('authenticated', 'public.stock_takes_for_job(uuid)', 'execute') then
    raise exception '0348: stock_takes_for_job is not the signed-in, count-only read with settled_by_office it should be. Nothing was changed.';
  end if;
  raise notice '0348: a settled take says who can undo it.';
end $$;
