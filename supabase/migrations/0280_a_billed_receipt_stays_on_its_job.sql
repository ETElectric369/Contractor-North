-- TWO CEILINGS THE FIX WAVE ASKED FOR, AND ONE IT ASKED ME NOT TO BUILD (2026-09-20).
--
-- ── 1. A RECEIPT AN INVOICE BILLS MAY NOT CHANGE JOBS ─────────────────────────────────────────
--
-- 0278 stopped a claimed bill being DELETED. Moving one is the same wound with the bleeding
-- somewhere else: the claim is a uuid inside invoice_items.source_ids and it survives the move, so
-- the old customer's invoice goes on charging for a receipt that now sits on another job, while
-- the importer skips that bill on its new job forever because something already claims it. The
-- cost lands nowhere and is billed anyway.
--
-- The app-side refusal shipped in the same wave (jobs/bill-claims.ts). This is the boundary under
-- it, for the same reason 0261 gave: a rule at one read path is a convention.
--
-- GATED ON THE JOB MOVING, AND ONLY THAT. A re-price, a supplier correction, a paid/unpaid tick,
-- a PO link, a note - all still save. The AMOUNT deliberately stays a warning rather than a
-- refusal: a price correction is the thing Erik does when the real invoice arrives after a counter
-- preview, and a door that refuses it is a door he works around.
create or replace function public.guard_bill_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_holder text;
begin
  if new.job_id is not distinct from old.job_id then
    return new;
  end if;
  v_holder := public.invoice_holding_claim(array[new.id], new.org_id);
  if v_holder is not null then
    raise exception '% already bills this receipt on the job it is on. Void that invoice, or take its materials lines off, then move this receipt.', v_holder
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists guard_bill_claim on public.bills;
create trigger guard_bill_claim
  before update on public.bills
  for each row execute function public.guard_bill_claim();

-- ── 2. THE ONE SPLIT DOOR THAT CARRIES NO CLAIM ───────────────────────────────────────────────
--
-- An un-split shift is billed by its OWN id (0256's backfill shape - 81 of 157 live claims are
-- entry ids). When the office splits such a shift, updateTimeEntry and completeAutoClockOut insert
-- the rows DIRECTLY and then carry the claim onto them, so the invoice keeps billing the same
-- hours once. replace_time_allocations carries nothing: it deletes every row for the entry and
-- inserts a fresh set with new ids that no claim covers. On an entry with no allocations yet, the
-- delete touches nothing, no trigger fires, and the hours become billable a second time - by a
-- TECH, since the RPC is SECURITY DEFINER and granted to authenticated, and it checks only shift
-- ownership, the payroll lock and the hours ceiling. 72 live entries are in exactly that state.
--
-- A TRIGGER ON time_allocations CANNOT BE THE ANSWER, and this is worth writing down because the
-- audit asked for one. carryEntryClaim (timeclock/actions.ts) ADDS the new ids and deliberately
-- KEEPS the entry id in the claim, in a separate request after the insert. So a trigger that
-- refused an insert onto a claimed entry would refuse the honest office edit forever, not just
-- once - and reordering the carry ahead of the insert would trade a rare exploit for a window
-- where the claim points at rows that do not exist yet. Worse trade.
--
-- So the guard goes on the one door that carries nothing, and only in the one state it can be
-- abused from: the entry is claimed by its own id AND has no split yet, which is never true of a
-- legitimate call here (both real callers pass rows they are REPLACING). The read side of the fix
-- shipped with the wave in labor-billing.ts and is what actually stops the money today; this is
-- the ceiling, not the fix.
create or replace function public.replace_time_allocations(p_entry uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  ent          record;
  worked_hours numeric;
  new_total    numeric;
  existing     integer;
  v_holder     text;
  n            integer;
begin
  select te.id, te.profile_id, te.org_id, te.clock_in, te.clock_out, te.lunch_minutes,
         te.paid_at, te.mileage_paid_at
    into ent
    from public.time_entries te
   where te.id = p_entry;
  if not found then
    raise exception 'That shift no longer exists.';
  end if;

  -- WHO MAY RESHAPE THIS SPLIT: the person whose shift it is, or staff in the same org. Both
  -- helpers already refuse a deactivated seat (0158), so an ex-employee's token gets nothing.
  if not (ent.profile_id = auth.uid()
          or (public.is_org_staff() and ent.org_id = public.auth_org_id())) then
    raise exception 'That is not your shift.';
  end if;

  -- A settled shift's split is history — same rule guard_time_allocation enforces.
  if ent.paid_at is not null or ent.mileage_paid_at is not null then
    raise exception 'That shift is in a paid period — ask the office to undo it on Payroll first.';
  end if;

  -- SPLITTING AN ALREADY-BILLED SHIFT THROUGH THIS DOOR WOULD BILL IT TWICE. See the header: the
  -- app's own split paths insert directly and carry the claim; this one replaces a set that is
  -- already there. No existing rows plus a claim on the entry itself is the shape that only an
  -- RPC call can make, and it is the shape that frees billed hours.
  select count(*) into existing from public.time_allocations where time_entry_id = p_entry;
  if existing = 0 then
    v_holder := public.invoice_holding_claim(array[p_entry], ent.org_id);
    if v_holder is not null then
      raise exception '% already bills this shift, so its hours cannot be split from here. Void or adjust that invoice first.', v_holder
        using errcode = 'P0001';
    end if;
  end if;

  select coalesce(sum((r->>'hours')::numeric), 0) into new_total
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  if new_total < 0 then
    raise exception 'Allocated hours cannot be negative.';
  end if;

  -- THE no-over-bill law (C7), checked once for the whole set instead of row by row.
  if ent.clock_out is not null then
    worked_hours := extract(epoch from (ent.clock_out - ent.clock_in)) / 3600.0
                    - coalesce(ent.lunch_minutes, 0) / 60.0;
    if new_total > worked_hours + 0.01 then
      raise exception 'That split adds up to more hours than the shift worked.';
    end if;
  end if;

  delete from public.time_allocations where time_entry_id = p_entry;

  insert into public.time_allocations (time_entry_id, org_id, job_id, job_code, hours, description, sort_order)
  select p_entry,
         ent.org_id,
         nullif(r->>'job_id', '')::uuid,
         nullif(r->>'job_code', ''),
         coalesce((r->>'hours')::numeric, 0),
         nullif(r->>'description', ''),
         coalesce((r->>'sort_order')::integer, (row_number() over ())::integer - 1)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, ord);
  get diagnostics n = row_count;
  return n;
end;
$function$;
