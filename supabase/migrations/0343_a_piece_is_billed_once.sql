-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0343: a piece from the shelf is billed once, and has a date
--
-- Shop Stock, Phase 3 (the plan's items 4-6). A take from the shelf (stock_draw, 0303) is now billed:
-- importCostsIntoInvoice adds one invoice line per take ("12/2 NM-B, 40 ft"), claimed by the take's
-- move ids in invoice_items.source_ids and keyed 'stock:<draw_group>', priced at the invoice's own
-- markup on the pieces' stamped cost. This file is the database half of that.
--
-- 1. A PIECE IS BILLED ON ONE LIVE LINE. 0258/0260's guard_invoice_item_claim already refuses an id
--    that another NON-VOID INVOICE holds, and it reads any uuid, so a move id is covered by it as it
--    stands. It is deliberately looser than a piece needs in two ways, and this adds a second guard
--    beside it (a mirror, not a rewrite: 0258/0260's function is not touched):
--      · 0258 lets the SAME invoice hold an id on several lines, because a bill is stamped on every
--        row of that bill. A take is one line. Two lines of one invoice holding the same move bill
--        the same 40 ft twice, and 0258 waves that through. Here a move id may sit on ONE line of
--        ONE live invoice.
--      · 0258 checks only WHO else holds an id, never WHAT it is. A move id on a line must be a
--        live take, onto this invoice's job, in this invoice's company: never a short (pieces taken
--        past the shelf are $0 until their roll is filed and settled - the importer never offers
--        them), never an undone take (its pieces are back on the shelf), never a count, write-off
--        or return, and never a take for another job.
--    Its refusal speaks the office's word, "materials already billed on INV-0xx" (0258's own
--    sentence says "work" for an id it does not recognise). It fires BEFORE 0258's guard (triggers
--    fire in name order: invoice_items_a_piece_... < invoice_items_claim_...).
--
--    RACES. It takes 0260's org-wide claim lock (the same key, so an import, an un-void and this
--    guard all queue on one lock), and it locks the take's move rows FOR UPDATE before it reads
--    them. stock_undo (0303) locks the same rows first thing. So an import and an Undo of the same
--    take in the same second cannot both win: whichever holds the rows second re-reads them after
--    the first commits and refuses in words ("That take was undone" / "INV-0xx already bills these
--    pieces").
--
-- 2. RELEASED THE WAY HOURS ARE. Voiding the invoice releases the claim (0258: void invoices hold
--    nothing), and deleting the line or the invoice takes the claim with it. Nothing new is needed
--    for that, and guard_stock_move (0303) already refuses an Undo while a live invoice holds the
--    take (invoice_holding_claim, 0261). THE WAY BACK is new: an invoice may not leave 'void' while
--    a line of it holds a move that is no longer a live take on its job - undone after the void, so
--    its pieces are back on the shelf (and may be on another job by now). 0259/0260's un-void guard
--    catches a move another live line holds; this catches the one nobody holds because it is gone.
--    A separate trigger again (0259/0260's function is not touched), under the same lock, with the
--    move rows locked FOR UPDATE for the same race.
--
-- 3. A PIECE FROM THE SHELF HAS A DATE ON THE PORTAL. portal_job_view (0301; live body today = 0301
--    + 0315 customer_line_words + 0326 shared papers + 0335 panels + 0342 line_kind) tells the
--    customer WHEN a material line's purchase happened: a bill's date, an order's date, never who
--    sold it or what it cost. A take is neither, so a stock line came back with no date and the
--    ledger put it on the invoice's day. A third lookup is added: the day the pieces were taken, in
--    the company's time zone - the DATE ONLY, org-checked, draws only. Never the cost, the roll, the
--    lot, the ticket or the supplier. Rewritten FROM THE LIVE DEFINITION by replacing exactly ONE
--    fragment (the 0315 / 0326 / 0335 / 0342 technique), refusing unless it appears exactly once:
--       select json_build_object('date', null, 'at', coalesce(po.ordered_at, po.created_at)), po.created_at
--         from public.purchase_orders po where po.id = any(it.source_ids) and po.org_id = a.org_id
--    LIVE BODY THIS STARTS FROM: pg_get_functiondef('public.portal_job_view(text, uuid)') in
--    production, 2026-09-25 (md5 bb8556223024638209cc584d0eb5615e), after 0342. The fragment above
--    was copied from it. Grants unchanged (service role only).
--
-- 4. START IT OVER FORGETS A DELETED TAKE TOO. reset_import_source (0212) forgets the tombstones of
--    the materials import's key families (bill:, po:, bli:) so a rebuilt import brings deleted lines
--    back; a take's key (stock:<draw_group>) is added to that list, from the LIVE body, one fragment.
--
-- WHAT THIS CHANGES TODAY: nothing anyone can see. Production has 0 lots, 0 moves and 0 items, so no
-- line holds a move id, no un-void meets one, and every customer job page reads byte for byte what it
-- read before - checked below, for every page every enabled portal link opens.
--
-- ORDER: after 0342 (applied) and 0303/0304/0328 (the shelf). Deploy-safe either way: the importer
-- writes stock lines only when there are takes, and there are none until the Took From Stock door
-- ships; the claim itself is already a boundary through 0258 without this file.
--
-- Idempotent: create or replace / drop trigger if exists; the portal rewrite is skipped when the
-- body already reads stock_moves.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. the ground this stands on ───────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.stock_moves') is null then
    raise exception '0343: the shelf (0303) is not on this database. Nothing was changed.';
  end if;
  if to_regprocedure('public.guard_invoice_item_claim()') is null or to_regprocedure('public.invoice_holding_claim(uuid[], uuid)') is null then
    raise exception '0343: the claim boundary (0258/0261) is not on this database. Nothing was changed.';
  end if;
  if to_regprocedure('public.portal_job_view(text, uuid)') is null
     or position('it.line_kind' in pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure)) = 0 then
    raise exception '0343: portal_job_view is older than 0342 (no line_kind). Apply 0342 first. Nothing was changed.';
  end if;
  if to_regprocedure('public.split_org_tz(uuid)') is null then
    raise exception '0343: split_org_tz (0288) is not on this database. Nothing was changed.';
  end if;
end $$;

-- ── 1. a piece is billed on one live line ──────────────────────────────────────────────────────
create or replace function public.guard_stock_piece_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
  -- with a null key takes no lock at all.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(v_inv.org_id::text, new.invoice_id::text)));
  -- The take's rows, locked in id order (stock_undo locks the same rows first), so an Undo racing
  -- this import is read after it commits.
  perform 1 from public.stock_moves m where m.id = any (v_moves) order by m.id for update;

  -- WHOSE. Another company's pieces are never named, only refused.
  if exists (select 1 from public.stock_moves m where m.id = any (v_moves) and m.org_id is distinct from v_inv.org_id) then
    raise exception 'Those pieces aren''t on this company''s shelf record.' using errcode = '42501';
  end if;
  -- A void invoice bills nothing; what its lines say is history (0258). Only a live one is judged.
  if v_inv.status = 'void' then
    return new;
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
      raise exception 'Pieces taken past the shelf aren''t billed until their roll is filed and they''re settled on Shop Stock.'
        using errcode = 'P0001';
    elsif v_m.kind <> 'draw' then
      raise exception 'Only pieces taken onto a job are billed. That entry is a count, a write-off or a return, not a take.'
        using errcode = 'P0001';
    elsif v_m.undone_at is not null then
      raise exception 'That take was undone, so its pieces are back on the shelf and can''t be billed.'
        using errcode = 'P0001';
    elsif v_inv.job_id is not null and v_m.job_id is distinct from v_inv.job_id then
      raise exception 'Those pieces were taken for %, so they can''t be billed on this invoice.', v_m.job_label
        using errcode = 'P0001';
    end if;
  end loop;

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
end $$;

revoke execute on function public.guard_stock_piece_claim() from public, anon, authenticated;
comment on function public.guard_stock_piece_claim() is
  'BEFORE INSERT / UPDATE OF source_ids, invoice_id on invoice_items (0343): a stock_moves id added to a line must be a live draw (not a short, not undone, not a count/write-off/return) on the invoice''s job, in its org, and held by no other line of any live invoice, this one included. Takes 0260''s org claim lock and locks the move rows FOR UPDATE (stock_undo locks them too). Fires before 0258''s guard, which it mirrors and does not replace.';

drop trigger if exists invoice_items_a_piece_is_billed_once on public.invoice_items;
create trigger invoice_items_a_piece_is_billed_once
  before insert or update of source_ids, invoice_id on public.invoice_items
  for each row
  execute function public.guard_stock_piece_claim();

-- ── 2. the way back from void: the pieces must still be on the job ─────────────────────────────
create or replace function public.guard_invoice_unvoid_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
  select m.id, m.kind, m.undone_at,
         coalesce(nullif(btrim(i.name), ''), 'Pieces') as item
    into v_gone
    from public.stock_moves m
    left join public.inventory_items i on i.id = m.item_id
   where m.id = any (v_moves)
     and (m.org_id is distinct from new.org_id
          or m.kind <> 'draw'
          or m.undone_at is not null
          or (new.job_id is not null and m.job_id is distinct from new.job_id))
   order by m.id
   limit 1;
  if found then
    raise exception '% taken from stock on this invoice went back on the shelf after it was voided, so it can''t come back from void.', v_gone.item
      using errcode = 'P0001',
            hint = 'Un-voiding it would bill pieces that are no longer on this job. Leave it void and bill the job on a fresh invoice: New Invoice pulls in only what nobody has billed yet.';
  end if;
  return new;
end $$;

revoke execute on function public.guard_invoice_unvoid_stock() from public, anon, authenticated;
comment on function public.guard_invoice_unvoid_stock() is
  'BEFORE UPDATE OF status on invoices (0343): a void invoice may not come back while a line of it holds a stock move that is no longer a live draw on its job (undone after the void, or not a take). Same org claim lock as 0260; locks the move rows FOR UPDATE. Beside 0259/0260''s guard, which it does not replace.';

drop trigger if exists invoices_unvoid_keeps_its_pieces on public.invoices;
create trigger invoices_unvoid_keeps_its_pieces
  before update of status on public.invoices
  for each row execute function public.guard_invoice_unvoid_stock();

-- ── 3. the portal: a piece from the shelf has a date ───────────────────────────────────────────
-- Arrays compared as sets (sorted by text), as 0342 does; `drop_sources` also takes every line's
-- 'sources' away, for the one comparison a page with a stock line is allowed to differ by.
create or replace function pg_temp._0343_norm(j jsonb, drop_sources boolean) returns jsonb
language plpgsql immutable as $$
begin
  if j is null then
    return null;
  elsif jsonb_typeof(j) = 'object' then
    return coalesce((select jsonb_object_agg(k, pg_temp._0343_norm(v, drop_sources)) from jsonb_each(j) e(k, v)
                      where not (drop_sources and k = 'sources')), '{}'::jsonb);
  elsif jsonb_typeof(j) = 'array' then
    return coalesce((select jsonb_agg(s order by s::text) from (select pg_temp._0343_norm(v, drop_sources) as s from jsonb_array_elements(j) a(v)) x), '[]'::jsonb);
  end if;
  return j;
end $$;

-- Every customer job page every enabled portal link opens, as it reads TODAY, and whether any of
-- its lines holds a move from the shelf (the only pages allowed to gain a date).
drop table if exists _0343_pages;
create temp table _0343_pages as
select a.token, jb.id as job_id, public.portal_job_view(a.token, jb.id)::jsonb as j,
       exists (select 1 from public.invoice_items it
                join public.stock_moves m on m.id = any (it.source_ids)
                join public.invoices i on i.id = it.invoice_id
               where i.job_id = jb.id and i.org_id = a.org_id) as has_stock
  from public.customer_portal_access a
  join public.jobs jb on jb.customer_id = a.customer_id and jb.org_id = a.org_id
 where a.enabled;

do $$
declare
  v_def text;
  v_n int;
  v_old text := $old$            select json_build_object('date', null, 'at', coalesce(po.ordered_at, po.created_at)), po.created_at
              from public.purchase_orders po where po.id = any(it.source_ids) and po.org_id = a.org_id$old$;
  v_new text := $new$            select json_build_object('date', null, 'at', coalesce(po.ordered_at, po.created_at)), po.created_at
              from public.purchase_orders po where po.id = any(it.source_ids) and po.org_id = a.org_id
            union all
            -- 0343: a piece taken from the shelf, dated the day it was taken in the company's own
            -- time zone. The DATE only: never its cost, its roll, its ticket or its supplier.
            select json_build_object('date', (m.created_at at time zone public.split_org_tz(a.org_id))::date, 'at', null), m.created_at
              from public.stock_moves m
             where m.id = any(it.source_ids) and m.org_id = a.org_id and m.kind = 'draw' and m.undone_at is null$new$;
begin
  v_def := pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure);
  if position('public.stock_moves' in v_def) = 0 then
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0343: portal_job_view''s material-sources fragment appears % time(s), not once, so someone changed it since 0342. Nothing was changed.', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

-- ── 4. Start It Over forgets a take's tombstone too ────────────────────────────────────────────
-- reset_import_source (0204, 0212) is the amber Start It Over: it clears a source's lines AND the
-- keys the office deleted from it, so the rebuilt import brings them back. For 'costs' it forgets
-- the three key families the materials import minted until now (bill:, po:, bli:). A take's line
-- is keyed stock:<draw_group>, so without this a take deleted from a draft stayed deleted through
-- Start It Over - the one button whose whole promise is "rebuild it" - and the Unbilled card kept
-- counting it. Rewritten FROM THE LIVE DEFINITION (pg_get_functiondef in production, 2026-09-25,
-- md5 a939a1a475b27008a4f069c9468bcffd = 0212's body) by replacing exactly ONE fragment, refusing
-- unless it appears exactly once. Grants unchanged (create or replace keeps them).
do $$
declare
  v_def text;
  v_n int;
  v_old text := $old$when 'costs' then (k not like 'bill:%' and k not like 'po:%' and k not like 'bli:%')$old$;
  v_new text := $new$when 'costs' then (k not like 'bill:%' and k not like 'po:%' and k not like 'bli:%' and k not like 'stock:%')$new$;
begin
  v_def := pg_get_functiondef('public.reset_import_source(uuid, text)'::regprocedure);
  if position('stock:%' in v_def) = 0 then
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0343: reset_import_source''s costs fragment appears % time(s), not once, so someone changed it since 0212. Nothing was changed.', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

-- ── self-check ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_bad int;
  v_def text := pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure);
  v_n int;
  v_sample text;
begin
  -- The rewrite kept every earlier block and added exactly the one lookup.
  if position('public.stock_moves' in v_def) = 0
     or position('it.line_kind' in v_def) = 0
     or position('job_panels' in v_def) = 0
     or position('customer_line_words' in v_def) = 0
     or position('job_share_shows' in v_def) = 0 then
    raise exception '0343: the portal rewrite lost a block (0315 / 0326 / 0335 / 0342) or did not land. Nothing was changed.';
  end if;
  -- It reads a take's DATE and nothing else off the shelf's record.
  if v_def ~* 'm\.(cost|lot_id|qty|item_id|note|source)\M' then
    raise exception '0343: the portal would read more than a date off the shelf''s record. Nothing was changed.';
  end if;

  -- Every page reads exactly as before; a page with a line holding a move may differ ONLY in its
  -- lines' sources (the new date).
  select count(*) into v_bad
    from _0343_pages b
   where (not b.has_stock and pg_temp._0343_norm(b.j, false) is distinct from pg_temp._0343_norm(public.portal_job_view(b.token, b.job_id)::jsonb, false))
      or (b.has_stock and pg_temp._0343_norm(b.j, true) is distinct from pg_temp._0343_norm(public.portal_job_view(b.token, b.job_id)::jsonb, true));
  if v_bad > 0 then
    raise exception '0343: % customer job page(s) would read differently. Nothing was changed.', v_bad;
  end if;

  -- The door keeps the grants it had.
  if has_function_privilege('anon', 'public.portal_job_view(text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.portal_job_view(text, uuid)', 'execute') then
    raise exception '0343: the customer job page became callable without the service role. Nothing was changed.';
  end if;

  -- Start It Over forgets a take's tombstone, and still every family it forgot before.
  if position($q$k not like 'stock:%'$q$ in pg_get_functiondef('public.reset_import_source(uuid, text)'::regprocedure)) = 0
     or position($q$k not like 'bli:%'$q$ in pg_get_functiondef('public.reset_import_source(uuid, text)'::regprocedure)) = 0 then
    raise exception '0343: reset_import_source does not forget the materials import''s tombstones. Nothing was changed.';
  end if;

  -- Both guards are on, in the order the header says.
  if not exists (select 1 from pg_trigger where tgname = 'invoice_items_a_piece_is_billed_once' and tgrelid = 'public.invoice_items'::regclass and tgenabled <> 'D')
     or not exists (select 1 from pg_trigger where tgname = 'invoices_unvoid_keeps_its_pieces' and tgrelid = 'public.invoices'::regclass and tgenabled <> 'D')
     or not exists (select 1 from pg_trigger where tgname = 'invoice_items_claim_is_a_boundary' and tgrelid = 'public.invoice_items'::regclass and tgenabled <> 'D') then
    raise exception '0343: a claim guard is missing or switched off. Nothing was changed.';
  end if;

  -- WHAT IT INHERITS, reported not frozen (0258's rule): a live line already holding a move that is
  -- not a live take on its job, or a move held by two live lines. Expected none (0 moves today).
  select count(*), string_agg(distinct coalesce(i.invoice_number, i.id::text), ', ')
    into v_n, v_sample
    from public.invoice_items it
    join public.invoices i on i.id = it.invoice_id and i.status <> 'void'
    join public.stock_moves m on m.id = any (it.source_ids)
   where m.org_id is distinct from i.org_id
      or m.kind <> 'draw'
      or m.undone_at is not null
      or (i.job_id is not null and m.job_id is distinct from i.job_id)
      or exists (select 1 from public.invoice_items o
                   join public.invoices oi on oi.id = o.invoice_id and oi.status <> 'void'
                  where o.id <> it.id and m.id = any (o.source_ids));
  if v_n > 0 then
    raise notice '0343: % live line(s) already hold a piece the new guard would refuse (%): look at them; nothing was rewritten.', v_n, v_sample;
  else
    raise notice '0343: no live line holds a piece from the shelf that the guard would refuse - it starts clean.';
  end if;
  raise notice '0343: % customer job page(s) checked, the same as before.', (select count(*) from _0343_pages);
end $$;

drop table _0343_pages;
