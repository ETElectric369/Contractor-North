-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0334: the crew sees what breakers came (Panel tab plan, phase 3)
--
-- THE NEED. The Panel tab's Breakers card counts the breakers the new work needs against the
-- breakers that came for the job: on J-011, 8 x Q2020 and 1 x Q21530CT on CED 8802-SO-257555, which
-- leaves "Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare." The crew stands at the panel and
-- needs that answer, but bills and bill_line_items are staff-only to read (0056's law for money
-- tables: they carry cost, supplier and bill number). A crew session reading them gets nothing, and
-- a card that counted from nothing would say every breaker is short.
--
-- THE DOOR. breakers_bought_for_job(job) hands back what a tech needs from the job's tickets and
-- nothing else: each breaker-looking line's DESCRIPTION and the QUANTITY that came (a return's
-- negative quantity nets it off). No price, no amount, no supplier, no bill number, no bill id, no
-- date. The office's view adds its sources and prices from its OWN session (bills RLS), and counts
-- from this same function, so the crew and the office read the same Have and the same verdict.
--
--   * SECURITY DEFINER, stable, search_path pinned (shelf_for_crew's shape, 0302).
--   * Answers only for an ACTIVE member of the job's own org: auth_org_id() is null for a
--     deactivated seat (0158) and is_member() checks active, so a stranger, a customer or an old
--     login gets zero rows. Execute is revoked from PUBLIC and anon.
--   * Counts only tickets that are this job's goods: not a superseded bill (a counter receipt the
--     invoice replaced, 518 Crater Lake), not a statement, not a shelf ticket, not a line that went
--     on the shelf (is_stock), not a void bill.
--   * Returns only lines that MIGHT be breakers (the gate below). The app's reader
--     (src/lib/panel/breaker-catalog.ts) decides what each one is; the gate is deliberately wider
--     than the reader so a breaker is never dropped here. A tech never gets the whole ticket.
--
-- bill_line_items has NO part_number column (checked 2026-09-25), so the part number rides in the
-- description ("SIEM Q2020 SP 20/20A 120/240V CB") and the reader takes it from there. The plan's
-- (description, part_number, qty) is therefore (description, qty): one reader, no second copy of
-- the part-number rules in SQL.
--
-- Not a function-replacing migration: breakers_bought_for_job is new (to_regprocedure was null on
-- production 2026-09-25). ORDER: after 0333. Safe to apply before or after the phase-3 code: the
-- card treats a missing function as "tickets can't be read yet" and says so.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.breakers_bought_for_job(p_job uuid)
returns table (description text, qty numeric)
language sql
stable
security definer
set search_path = public
as $$
  select li.description, sum(li.quantity) as qty
    from public.jobs j
    join public.bills b
      on b.job_id = j.id
     and b.org_id = j.org_id
    join public.bill_line_items li
      on li.bill_id = b.id
     and li.org_id = b.org_id
   where j.id = p_job
     and public.auth_org_id() is not null
     and j.org_id = public.auth_org_id()
     and public.is_member()
     and b.superseded_by_bill_id is null
     and not coalesce(b.is_statement, false)
     and not coalesce(b.on_shelf, false)
     and coalesce(b.status, '') <> 'void'
     and not coalesce(li.is_stock, false)
     and li.description is not null
     and li.description ~* '(breaker|brkr|bkr|\ycb\y|miniature|pole|\y[123] ?-? ?p\y|\y(sp|dp)\y|twin|tandem|duplex|quad|\yq-?[a-z]{0,5}-?[0-9]|\y(homt?|qot?|br|bd|cht?)-?[0-9]|\ythq)'
     -- A switch, a receptacle, a sensor or a load centre that says "1P" is not a breaker, unless the
     -- line also says it is one.
     and (li.description ~* '(breaker|brkr|bkr|\ycb\y)'
          or li.description !~* '(switch|\ysw\y|sensor|\ysen\y|dimmer|\ydmr\y|recep|rcpt|recpt|outlet|plate|load ?cent|ld-?ctr)')
   group by li.description
  having sum(li.quantity) <> 0
   order by li.description;
$$;

comment on function public.breakers_bought_for_job(uuid) is
  'What breakers came on a job''s tickets (0334): each breaker-looking line''s description and quantity, never a price, amount, supplier or bill number. Active members of the job''s own org only. The Panel tab''s Breakers card reads it for the crew and the office alike.';

revoke execute on function public.breakers_bought_for_job(uuid) from public, anon;
grant execute on function public.breakers_bought_for_job(uuid) to authenticated, service_role;

-- ── Self-check: the function that shipped is the function described above ────────────────────
do $$
declare
  v_result text;
  v_secdef boolean;
  v_config text[];
begin
  select pg_get_function_result(p.oid), p.prosecdef, p.proconfig
    into v_result, v_secdef, v_config
    from pg_proc p
   where p.oid = 'public.breakers_bought_for_job(uuid)'::regprocedure;
  if v_result is distinct from 'TABLE(description text, qty numeric)' then
    raise exception '0334: breakers_bought_for_job returns % (expected description and qty only).', v_result;
  end if;
  if v_result ~* '(price|amount|cost|supplier|bill|vendor)' then
    raise exception '0334: breakers_bought_for_job would hand a tech money or a supplier (%).', v_result;
  end if;
  if not v_secdef or not (v_config @> array['search_path=public']) then
    raise exception '0334: breakers_bought_for_job must be SECURITY DEFINER with search_path pinned.';
  end if;
  if has_function_privilege('anon', 'public.breakers_bought_for_job(uuid)', 'execute') then
    raise exception '0334: anon can still run breakers_bought_for_job.';
  end if;
  raise notice '0334: breakers_bought_for_job hands the crew descriptions and quantities, never a price.';
end $$;
