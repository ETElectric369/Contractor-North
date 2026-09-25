-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0322: join_time_entries carries BOTH 0313 and 0320.
--
-- 0313 (audit v994 DB2) and 0320 (audit v994 SW9) each replaced join_time_entries, from different
-- bases, on two branches built the same night. 0320 was written from 0288's body, so applying it
-- after 0313 (2026-09-24) put back 0288's wording: a void invoice was again named as a biller, and
-- the live holder was no longer named first. The money guard itself (0313's split_time_entry carry
-- of a void claim) was never touched. This is 0313's join_time_entries, verbatim, with 0320's one
-- paid-hours check inserted after the rate check, exactly where 0320 put it.
--
-- ORDER: after 0313 and 0320. ONE TRANSACTION. Writes no data. Re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.join_time_entries(p_left uuid, p_right uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org     uuid := public.auth_org_id();
  l         public.time_entries%rowtype;
  r         public.time_entries%rowtype;
  v_before  numeric;
  v_after   numeric;
  v_l_lines uuid[];
  v_r_lines uuid[];
  v_odd     record;
  v_n       integer;
  v_released jsonb;
begin
  if v_org is null or not public.is_org_staff() then
    raise exception 'Only the office can join shifts.';
  end if;
  if p_left is null or p_right is null or p_left = p_right then
    raise exception 'Pick two different entries to join.';
  end if;

  -- Both rows, locked in id order so two joins on the same family cannot deadlock.
  perform 1 from public.time_entries where id in (p_left, p_right) order by id for update;
  select * into l from public.time_entries where id = p_left;
  if not found or l.org_id is distinct from v_org then
    raise exception 'That shift was not found.';
  end if;
  select * into r from public.time_entries where id = p_right;
  if not found or r.org_id is distinct from v_org then
    raise exception 'That shift was not found.';
  end if;

  if l.profile_id is distinct from r.profile_id then
    raise exception 'Those entries belong to two different people.';
  end if;
  if l.status <> 'closed' or r.status <> 'closed' or l.clock_out is null or r.clock_out is null then
    raise exception 'Clock out first. A running shift cannot be joined.';
  end if;
  if l.clock_out is distinct from r.clock_in then
    raise exception 'Those two entries do not touch, so they cannot be joined into one shift.';
  end if;
  -- ONLY PIECES OF ONE SPLIT SHIFT. A join takes the absorbed id off every line that holds it, which
  -- is right for an id a split appended and wrong for an ordinary entry a sent or paid line billed
  -- in its own right: that line would lose an original source id. So two entries that merely
  -- touch (a clock-out and a clock-in in the same minute) are not joinable; only one family is.
  if coalesce(l.split_from, l.id) is distinct from coalesce(r.split_from, r.id) then
    raise exception 'Those two entries were not split from one shift, so they cannot be joined. Edit their times instead.';
  end if;

  if l.paid_at is distinct from r.paid_at or l.mileage_paid_at is distinct from r.mileage_paid_at then
    raise exception 'One of these is in a paid period and the other is not, so joining them would change what was paid.';
  end if;
  if l.rate_override is distinct from r.rate_override then
    raise exception 'These two are paid at different rates, so joining them would change the pay.';
  end if;

  -- A PAID SHIFT KEEPS ITS ROUNDED HOURS (0320, audit v994 SW9). Payroll rounds each ENTRY to 0.01 h
  -- (hoursBetween), and payroll_runs holds the rounded pieces: two paid 10-minute pieces were paid
  -- 0.17 + 0.17 = 0.34 h, and joined into one 20-minute entry they read 0.33 h, so the timecard no
  -- longer matches what was paid. split and move already refuse this; join now does too, before
  -- anything is written, in the same sentence shape.
  if l.paid_at is not null then
    v_after := round(greatest(extract(epoch from (r.clock_out - l.clock_in))
                              - (coalesce(l.lunch_minutes, 0) + coalesce(r.lunch_minutes, 0)) * 60, 0) / 3600.0, 2)
             - round(greatest(extract(epoch from (l.clock_out - l.clock_in)) - coalesce(l.lunch_minutes, 0) * 60, 0) / 3600.0, 2)
             - round(greatest(extract(epoch from (r.clock_out - r.clock_in)) - coalesce(r.lunch_minutes, 0) * 60, 0) / 3600.0, 2);
    if v_after <> 0 then
      raise exception 'Joining these would change the paid hours on this shift by % h. Leave them split, or undo the pay on Payroll first.',
        public.split_hours_text(abs(v_after));
    end if;
    v_after := null;
  end if;

  -- THE CLAIM LOCK (0260's org key) before the holder read: the comparison below and the release
  -- after it are check-then-write, and an import committing a claim on one piece in between must
  -- wait for this join, not slip past it.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || v_org::text));

  -- SAME CLAIM HOLDERS, OR NO JOIN. Joining an unbilled piece into a billed one would make hours no
  -- invoice ever billed look billed (and the reverse would hand billed hours back to the importer).
  select coalesce(array_agg(it.id order by it.id), '{}') into v_l_lines
    from public.invoice_items it where it.source_ids && array[l.id];
  select coalesce(array_agg(it.id order by it.id), '{}') into v_r_lines
    from public.invoice_items it where it.source_ids && array[r.id];
  if v_l_lines is distinct from v_r_lines then
    -- The odd holder named is a LIVE invoice when there is one (move_time_entry_cut's order), and
    -- a void one is called void (0313): "INV-V bills the first part" was false for a void invoice,
    -- and the office went looking for a bill that bills nothing.
    select i.invoice_number, i.status::text as status, (it.source_ids && array[l.id]) as bills_first
      into v_odd
      from public.invoice_items it
      join public.invoices i on i.id = it.invoice_id
     where it.id = any (v_l_lines || v_r_lines)
       and not (it.id = any (v_l_lines) and it.id = any (v_r_lines))
     order by (i.status = 'void'), i.created_at, i.id
     limit 1;
    if v_odd.status = 'void' then
      raise exception '% (void) still holds the % part and not the %, so joining them would change what % bills if it is ever un-voided. Leave them split.',
        coalesce(v_odd.invoice_number, 'A void invoice'),
        case when v_odd.bills_first then 'first' else 'second' end,
        case when v_odd.bills_first then 'second' else 'first' end,
        coalesce(v_odd.invoice_number, 'it')
        using errcode = 'P0001',
              hint = 'A void invoice bills nothing, but it keeps the hours it billed so an un-void cannot bill them twice. Nothing was changed.';
    end if;
    raise exception '% (%) bills the % part and not the %, so joining them would make unbilled hours look billed.',
      coalesce(v_odd.invoice_number, 'An invoice'), coalesce(v_odd.status, 'unknown'),
      case when v_odd.bills_first then 'first' else 'second' end,
      case when v_odd.bills_first then 'second' else 'first' end
      using errcode = 'P0001',
            hint = 'Take the part off ' || coalesce(v_odd.invoice_number, 'that invoice') || ' first, or leave them split.';
  end if;

  v_before := extract(epoch from (l.clock_out - l.clock_in)) - coalesce(l.lunch_minutes, 0) * 60
            + extract(epoch from (r.clock_out - r.clock_in)) - coalesce(r.lunch_minutes, 0) * 60;

  -- The claim leaves with the piece: exactly the absorbed id, and only from lines that also hold
  -- the kept id (the holder sets were read under the claim lock and are equal, so that is every
  -- line holding it; the count proves it). Then 0261's delete guard has nothing to refuse.
  with released as (
    update public.invoice_items it
       set source_ids = array_remove(it.source_ids, r.id)
      from public.invoices i
     where i.id = it.invoice_id
       and it.source_ids && array[r.id]
       and it.source_ids && array[l.id]
    returning it.id, i.invoice_number
  )
  select coalesce(jsonb_agg(distinct invoice_number), '[]'::jsonb), count(*)
    into v_released, v_n
    from released;
  if v_n <> cardinality(v_r_lines) then
    raise exception 'The invoices billing these parts changed while they were being joined. Nothing was changed; try again.';
  end if;

  -- The family stays one family. Pieces that pointed at the absorbed one point at the family's
  -- first entry instead; and when the absorbed one WAS that first entry (a rebuilt split whose
  -- own-job part came second), the kept piece becomes the first entry and the rest point at it.
  if l.split_from is not distinct from r.id then
    update public.time_entries set split_from = l.id where split_from = r.id and id <> l.id;
    update public.time_entries set split_from = null, split_how = null where id = l.id;
  else
    update public.time_entries
       set split_from = coalesce(l.split_from, l.id)
     where split_from = r.id;
  end if;

  delete from public.time_entries where id = r.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'The second part could not be removed. Nothing was changed.';
  end if;

  update public.time_entries
     set clock_out          = r.clock_out,
         lunch_minutes      = coalesce(l.lunch_minutes, 0) + coalesce(r.lunch_minutes, 0),
         miles              = coalesce(l.miles, 0) + coalesce(r.miles, 0),
         gps_out            = r.gps_out,
         auto_closed_reason = coalesce(r.auto_closed_reason, l.auto_closed_reason),
         notes              = case
                                when nullif(btrim(r.notes), '') is null then l.notes
                                when nullif(btrim(l.notes), '') is null then r.notes
                                when l.notes = r.notes then l.notes
                                else l.notes || E'\n' || r.notes
                              end
   where id = l.id;

  select extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60
    into v_after
    from public.time_entries t
   where t.id = l.id;
  if v_after is distinct from v_before then
    raise exception 'The joined shift does not add up to its parts (% s vs % s). Nothing was changed.', v_after, v_before;
  end if;

  return jsonb_build_object(
    'kept_id', l.id,
    'removed_id', r.id,
    'hours', round(greatest(v_after, 0) / 3600.0, 2),
    'released', v_released);
end $function$;

revoke execute on function public.join_time_entries(uuid, uuid) from public, anon;
grant execute on function public.join_time_entries(uuid, uuid) to authenticated, service_role;
comment on function public.join_time_entries(uuid, uuid) is
  'Office only (0288, 0313, 0320, 0322). Joins two touching closed pieces of one person back into the left one. Refused unless both have the same claim holders (void lines included; a void holder is named "(void) still holds"), paid_at, mileage_paid_at and rate_override, and (on a paid pair) unless the joined entry rounds to the same paid hours as the two pieces did. Removes exactly the absorbed id from the lines that hold it, deletes it, and widens the kept piece; lunch and miles add. Worked seconds are asserted equal.';

-- THE CHECK: both fixes are in the live body.
do $$
declare src text;
begin
  select p.prosrc into src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'join_time_entries';
  if position('(void) still holds' in src) = 0 then raise exception '0322: the 0313 void wording is missing'; end if;
  if position('would change the paid hours on this shift' in src) = 0 then raise exception '0322: the 0320 paid-hours check is missing'; end if;
end $$;
