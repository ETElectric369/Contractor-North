-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0261: hours that are billed cannot vanish
--
-- ORDER: after 0255 (the source_ids column) and 0258 (its GIN index, which both triggers here
-- read through). Writes no data. Re-runnable (create or replace / drop trigger if exists).
--
-- WHY. 0255 put the claim on the invoice line and 0258 made it a boundary THERE. Nothing guards
-- the other end of the same claim: the time rows the line points at.
--
-- It is easy to read time_allocations as already covered — it carries guard_time_allocation
-- (0154), live in production, BEFORE INSERT OR DELETE OR UPDATE. Read it: it guards PAYROLL
-- (paid_at / mileage_paid_at), the C7 worked-hours ceiling and negative hours, and it returns
-- early for staff and privileged writers. Billing is not in it. So this, through PostgREST, by any
-- signed-in member on their own shift (the 0010 policy allows exactly that):
--
--   delete from time_allocations where id = '<a row INV-061's labor line claims>';
--
-- leaves INV-061 billing hours that are no longer on the timecard, and — the money failure — hands
-- those hours back to the next importer: its claim read finds no row holding them, so they go out
-- again on the next invoice. The same hour billed twice, reached through the timecard instead of
-- the invoice. Deleting the ENTRY is the same failure one level up: the FK cascades to the
-- allocations (0010), and the entry's own id may be the claim.
--
-- The app's doors already refuse this — deleteTimeEntry and updateTimeEntry read claimsOnSources
-- first and name the invoice. A rule at one write path is a convention (0173). This is the
-- boundary underneath it, and it says the same thing in the same words.
--
-- NOT EVERY SOURCE ID IS AN ALLOCATION ID. Counted live before this was written: 157 claim
-- references exist and 81 of them match no time_allocations row at all. Those are time_entries ids
-- — a labor line on an UN-SPLIT shift claims the entry (0256's backfill, and every un-split shift
-- since). Nothing is wrong with them. A single trigger that assumed "source id = allocation id"
-- would leave 81 of 157 claims unguarded, so this is two triggers: the allocation's own id, and
-- the entry's id PLUS every allocation hanging off it (the entry door has to look at both, because
-- the cascade takes the allocations with it).
--
-- WHAT IS REFUSED
--   · DELETE of a claimed allocation.
--   · DELETE of a time entry whose id, or any of whose allocations' ids, is claimed.
--   · UPDATE that MOVES a claimed allocation to another time_entry or another job. Its hours are
--     on a live invoice for the job it sits on; moving them bills one customer for work the
--     timecard now says was done somewhere else. planAllocationEdit already refuses it door-side.
--
-- WHAT IS NOT REFUSED, deliberately: the HOURS on a claimed row. updateTimeEntry trims claimed
-- rows IN PLACE to keep billed hours under paid hours (the C7 no-over-bill law) and confirmDebrief
-- does the same once a lunch is confirmed. A claim says "these rows are billed", never "at this
-- many hours": the invoice keeps the figure it went out with, and the office is told both figures
-- and adjusts the document by hand. Refusing here would block every honest correction.
--
-- ALSO NOT HERE, and named so nobody reads this file as covering it: moving a claimed TIME ENTRY
-- to another job. updateTimeEntry refuses it (claimedMoveRefusal) and this file does not, so that
-- one is still a convention. It is not a double bill — the claim is by id and survives the move,
-- exactly as 0258's header says a shift billed on J-021 and moved to J-028 is still billed. What
-- it breaks is which job the money sits against, which is worth a boundary of its own, later.
--
-- NOBODY IS EXEMPT — not staff, not the office, not a migration. Unlike 0154 this guard has no
-- role check, because the failure it prevents is the same failure whoever types it. The way out is
-- the invoice, and the hint says which one: void it, or take the row off the line. Either releases
-- the claim for free (0255 — the claim dies with the line and with the invoice, no tidy-up), and
-- the delete then goes through.
--
-- ONE KNOCK-ON WORTH KNOWING: profiles.id cascades to time_entries (0001), so deleting a profile
-- whose shifts were billed now fails loudly instead of quietly emptying the invoices that bill
-- them. Offboarding sets active = false (0158) and never deleted a profile anyway.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── WHO BILLS THESE ROWS ──────────────────────────────────────────────────────────────────────
-- One read, shared by both triggers. `&&` against the GIN index from 0258 (invoice_items_source_
-- ids_gin), so the cost is an index probe per deleted row, not a scan. Earliest invoice first, the
-- same claimant rule the app's foldClaims uses, so both doors name the same invoice.
--
-- SECURITY DEFINER because a tech cannot read invoice_items at all, and the guard must. The number
-- is only spoken when the holder is in the row's own org: a claim held across a tenant boundary
-- would be corruption, and it still blocks the delete, but it is never named (0173).
create or replace function public.invoice_holding_claim(p_ids uuid[], p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when i.org_id is not distinct from p_org
              then coalesce(i.invoice_number, 'another invoice')
              else 'another invoice' end
    from public.invoice_items it
    join public.invoices i on i.id = it.invoice_id
   where it.source_ids && p_ids
     and i.status <> 'void'
   order by i.created_at, i.id
   limit 1;
$$;

revoke execute on function public.invoice_holding_claim(uuid[], uuid) from public, anon;
comment on function public.invoice_holding_claim(uuid[], uuid) is
  'The non-void invoice (earliest) whose lines claim any of these source ids, named only when it is in p_org (0261). Read by the time-row guards; not callable by clients.';

-- ── A CLAIMED ALLOCATION CANNOT BE DELETED OR MOVED ───────────────────────────────────────────
create or replace function public.guard_billed_time_allocation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_holder text;
  v_verb   text;
begin
  if tg_op = 'UPDATE' then
    -- Only a MOVE is judged. Hours, code, description and sort order are the office's to correct
    -- on a billed shift (see the header) and must stay writable.
    if new.time_entry_id is not distinct from old.time_entry_id
       and new.job_id is not distinct from old.job_id then
      return new;
    end if;
    v_verb := case when new.time_entry_id is distinct from old.time_entry_id
                   then 'moving them to another shift'
                   else 'moving them to another job' end;
  else
    v_verb := 'removing them from the split';
  end if;

  v_holder := public.invoice_holding_claim(array[old.id], old.org_id);
  if v_holder is null then
    -- TWO PLAIN RETURNS, NOT ONE CASE OVER OLD/NEW. This is the line the ORDINARY path takes:
    -- every clock-out with a submitted split goes through replace_time_allocations (0244), which
    -- deletes the whole set before re-inserting it, so every unbilled row leaves through here —
    -- as does the office re-filing an unbilled shift onto the right job. A plain `return old` /
    -- `return new` is a plpgsql special case that is never planned; a CASE is an expression,
    -- planned with NEW as a parameter, and NEW is empty in a DELETE trigger. 0154:163 has run
    -- exactly that on this table for months, so it does resolve — but the line that gates every
    -- clock-out should not rest on that argument, and two returns cost nothing.
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception '% already bills these hours', v_holder
    using errcode = 'P0001',
          hint = 'Void or adjust ' || v_holder || ' before ' || v_verb || '. Nothing was changed.';
end $$;

comment on function public.guard_billed_time_allocation() is
  'BEFORE DELETE OR UPDATE OF time_entry_id, job_id on time_allocations (0261): a row a non-void invoice claims (invoice_items.source_ids) may not be deleted, nor moved to another shift or job. Hours on a claimed row stay editable on purpose (the C7 trim). Raises "INV-0xx already bills these hours".';

drop trigger if exists time_allocations_billed_hours_stay on public.time_allocations;
create trigger time_allocations_billed_hours_stay
  before delete or update of time_entry_id, job_id on public.time_allocations
  for each row
  execute function public.guard_billed_time_allocation();

-- ── A CLAIMED SHIFT CANNOT BE DELETED ─────────────────────────────────────────────────────────
-- Both id sets in one probe: the entry's own id (an un-split shift is claimed by it — the 81 above)
-- and every allocation on it, because the FK cascade would take those with the entry. This fires
-- BEFORE the parent row goes, so the allocations are all still there to be read.
create or replace function public.guard_billed_time_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids    uuid[];
  v_holder text;
begin
  select array[old.id] || coalesce(array_agg(a.id), '{}'::uuid[])
    into v_ids
    from public.time_allocations a
   where a.time_entry_id = old.id;

  v_holder := public.invoice_holding_claim(v_ids, old.org_id);
  if v_holder is null then
    return old;
  end if;

  raise exception '% already bills this shift', v_holder
    using errcode = 'P0001',
          hint = 'Void or adjust ' || v_holder || ' before deleting the shift. Nothing was changed.';
end $$;

comment on function public.guard_billed_time_entry() is
  'BEFORE DELETE on time_entries (0261): a shift whose own id, or any of whose allocations'' ids, a non-void invoice claims may not be deleted — the delete would cascade the allocations away too and free the hours for a second invoice. Raises "INV-0xx already bills this shift".';

drop trigger if exists time_entries_billed_hours_stay on public.time_entries;
create trigger time_entries_billed_hours_stay
  before delete on public.time_entries
  for each row
  execute function public.guard_billed_time_entry();

-- ── PROVE IT ──────────────────────────────────────────────────────────────────────────────────
-- Pick a live claim and try to take its row away. Nothing below commits.
--
--   -- a claimed source row and who bills it
--   select it.source_ids[1] as src, i.invoice_number
--     from public.invoice_items it
--     join public.invoices i on i.id = it.invoice_id
--    where cardinality(it.source_ids) > 0 and i.status <> 'void'
--    limit 1;
--
--   -- A · the allocation door (skip if <SRC> is an entry id — B covers that)
--   begin;
--     delete from public.time_allocations where id = '<SRC>';
--     → ERROR: INV-0xx already bills these hours
--       HINT:  Void or adjust INV-0xx before removing them from the split. Nothing was changed.
--     update public.time_allocations set job_id = null where id = '<SRC>';
--     → ERROR: INV-0xx already bills these hours   (HINT: ... before moving them to another job.)
--     update public.time_allocations set hours = hours - 0.25 where id = '<SRC>';
--     → 1 row: a trim on a billed row is allowed on purpose (the C7 correction).
--   rollback;
--
--   -- B · the entry door, by the entry itself OR by one of its allocations
--   begin;
--     delete from public.time_entries
--      where id = coalesce((select time_entry_id from public.time_allocations where id = '<SRC>'), '<SRC>');
--     → ERROR: INV-0xx already bills this shift
--       HINT:  Void or adjust INV-0xx before deleting the shift. Nothing was changed.
--   rollback;
--
--   -- C · the way out really is a way out
--   begin;
--     update public.invoices set status = 'void' where invoice_number = 'INV-0xx';
--     delete from public.time_allocations where id = '<SRC>';   -- now goes through
--   rollback;
--
--   -- D · THE ORDINARY PATH, which is the one that must not change. A and B prove the refusal;
--   --     these prove that everything NOT billed still deletes, including through the RPC every
--   --     clock-out uses. Run them at hand-application: they are the only lines of this file the
--   --     refusal tests never reach.
--
--   -- an UNPAID shift nothing bills — neither its own id nor any of its allocations'
--   select te.id as entry, a.id as alloc
--     from public.time_entries te
--     left join public.time_allocations a on a.time_entry_id = te.id
--    where te.paid_at is null and te.mileage_paid_at is null
--      and not exists (
--        select 1
--          from public.invoice_items it
--          join public.invoices i on i.id = it.invoice_id
--         where i.status <> 'void'
--           and it.source_ids && (array[te.id] || coalesce(
--                 (select array_agg(x.id) from public.time_allocations x where x.time_entry_id = te.id),
--                 '{}'::uuid[])))
--    limit 1;
--
--   begin;
--     delete from public.time_allocations where id = '<ALLOC>';   -- → DELETE 1
--     delete from public.time_entries    where id = '<ENTRY>';    -- → DELETE 1 (cascade included)
--   rollback;
--
--   -- and through the real caller, which deletes the set before it re-inserts it (0244).
--   -- The claims line is not optional: with no JWT, auth.uid() is null and the RPC refuses with
--   -- "That is not your shift." before it ever reaches this file.
--   begin;
--     select set_config('request.jwt.claims',
--                       json_build_object('sub', (select profile_id from public.time_entries
--                                                  where id = '<ENTRY>'))::text, true);
--     select public.replace_time_allocations('<ENTRY>', '[{"hours":1}]'::jsonb);
--     → 1.  ("more hours than the shift worked" just means that shift is under an hour long —
--            pick another <ENTRY>, or send its own total instead of 1.)
--   rollback;
