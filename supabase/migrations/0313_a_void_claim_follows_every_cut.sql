-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0313: a void claim follows every cut
--
-- ORDER: after 0290 (the old split table is gone). Nothing in the app has to deploy first or after:
-- the three functions keep their names, arguments and return shapes, and the app already leaves a
-- void invoice out of its "already bills this shift" sentence (timeclock/actions.ts splitTimeEntry).
--
-- ONE TRANSACTION, AND ONLY IF THE RUNNER MAKES IT ONE (as 0290): scripts/run-one-migration.mjs,
-- `psql -1 -f`, or the Supabase SQL editor or CLI. A failed check at the bottom then rolls ALL of it
-- back. Re-runnable: the functions are CREATE OR REPLACE and the backfill only adds a missing id.
--
-- WHAT THIS CLOSES (audit v994, DB2). A void invoice bills nothing, but its lines still say which
-- hours it billed, and that is what decides whether it may come back: guard_invoice_unvoid
-- (0259/0260) and the app's unvoidConflict refuse an un-void while any live line holds one of
-- the same ids. 0288's split_time_entry carried a void line's claim onto the new piece only when
-- the new piece stayed on the same job. On a cross-job cut the void line kept the first piece
-- alone, so:
--   INV-V bills Brian's 8 h shift P and is voided. The office cuts P at noon, the afternoon on
--   job B (allowed: a void invoice bills nothing). INV-X on job B imports the afternoon piece R.
--   Someone puts INV-V back to Sent. Both guards compare [P] with [R], find no overlap, and let it
--   through: INV-V bills its stored 8 h and INV-X bills 4 of them again.
-- And the Undo after that cut (join_time_entries) compared the pieces' holder sets, found the void
-- line on one and not the other, and refused with "INV-V bills the first part and not the
-- second": a void invoice named as the biller, and pieces that could never be joined.
--
-- THE FIX
--   1. split_time_entry: the void-lines carry runs on EVERY cut, as its own statement before the
--      live one (the per-row claim guard sees earlier rows; void first keeps row order irrelevant).
--      The live-line carry stays same-job only; a cross-job cut of a live-billed shift is still
--      refused, naming the invoice. Nothing else in the function changes (the body is the LIVE
--      definition, pg_get_functiondef 2026-09-24, identical to 0290's text).
--   2. join_time_entries and move_time_entry_cut: when the holder that differs is a void invoice,
--      the refusal says "(void) still holds", never "bills"; a live holder is named first when
--      there is one, and join now gives its status too, as move always did. Their rules are
--      unchanged: holder sets still include void lines, because a void line that holds one piece
--      and not the other is exactly what an un-void would re-bill.
--   3. Backfill: every piece cut from a shift that a void line held before the cut gets its id
--      appended to that line, so existing pieces are covered too. Read-only sweep 2026-09-24:
--      5 pieces in the whole database, and no void line holds any piece's family, so this writes
--      nothing today. A piece a LIVE invoice already bills cannot be appended (the claim guard
--      refuses it, and an un-void there is the double bill itself): the file stops and names it
--      instead, so a person decides.
--   4. Check: the three functions exist and carry this file's rules, the grants stand, and no void
--      line is left holding a shift's first piece without a later piece cut from it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1–2. THE THREE FUNCTIONS ──────────────────────────────────────────────────────────────────
-- split_time_entry: the void carry leaves the same-job branch.
CREATE OR REPLACE FUNCTION public.split_time_entry(p_entry uuid, p_at timestamp with time zone, p_right_job uuid, p_right_code text, p_lunch_on text DEFAULT NULL::text, p_miles_on text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org        uuid := public.auth_org_id();
  p            public.time_entries%rowtype;
  v_code       text := nullif(btrim(p_right_code), '');
  v_right_id   uuid := gen_random_uuid();
  v_tz         text;
  v_span_l     numeric;
  v_span_r     numeric;
  v_lunch_s    numeric;
  v_lunch_left boolean;
  v_miles_left boolean;
  v_before     numeric;
  v_after      numeric;
  v_same_job   boolean;
  v_owner      boolean;
  v_hold       record;
  v_carried    jsonb := '[]'::jsonb;
  v_n          integer;
begin
  if v_org is null or not public.is_org_staff() then
    raise exception 'Only the office can split a shift after it ends.';
  end if;

  select * into p from public.time_entries where id = p_entry for update;
  if not found or p.org_id is distinct from v_org then
    raise exception 'That shift was not found.';
  end if;

  -- THE CLAIM LOCK (0260's org key), taken after the row lock and before any claim is read. The
  -- holder read below and the carry after it are check-then-write: under READ COMMITTED an import
  -- committing a claim on this shift in between would be invisible to the check, and a cross-job
  -- cut of a shift that had just been billed would go through. guard_invoice_item_claim takes this
  -- same key before its own read, so an import and a split now wait for each other.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || v_org::text));

  if p.status <> 'closed' or p.clock_out is null then
    raise exception 'That shift is still running. Use Switch Job to start the next part now.';
  end if;
  if p.clock_out <= p.clock_in then
    raise exception 'That shift has no length, so there is nothing to split.';
  end if;

  v_tz := public.split_org_tz(p.org_id);
  if p_at is null or p_at <= p.clock_in or p_at >= p.clock_out then
    raise exception 'Pick a split time inside the shift, between % and %.',
      to_char(p.clock_in at time zone v_tz, 'FMHH12:MIam'), to_char(p.clock_out at time zone v_tz, 'FMHH12:MIam');
  end if;

  v_span_l := extract(epoch from (p_at - p.clock_in));
  v_span_r := extract(epoch from (p.clock_out - p_at));
  if v_span_l < 60 or v_span_r < 60 then
    raise exception 'Each part has to be at least a minute long.';
  end if;

  if p_right_job is null and v_code is null then
    raise exception 'Pick a job or a time code for the new part.';
  end if;
  if p_right_job is not null and not exists (
       select 1 from public.jobs j where j.id = p_right_job and j.org_id = p.org_id) then
    raise exception 'That job is not in your company.';
  end if;

  if p_lunch_on is not null and p_lunch_on not in ('left', 'right') then
    raise exception 'Lunch goes on the left or the right part.';
  end if;
  if p_miles_on is not null and p_miles_on not in ('left', 'right') then
    raise exception 'Miles go on the left or the right part.';
  end if;
  v_lunch_left := coalesce(p_lunch_on = 'left', v_span_l >= v_span_r);
  v_miles_left := coalesce(p_miles_on, 'left') = 'left';

  v_lunch_s := greatest(coalesce(p.lunch_minutes, 0), 0) * 60;
  if v_lunch_s > 0 and ((case when v_lunch_left then v_span_l else v_span_r end) - v_lunch_s) < 60 then
    raise exception 'The %-minute lunch does not fit in the % part. Put it on the other part.',
      p.lunch_minutes, case when v_lunch_left then 'first' else 'second' end;
  end if;

  -- A PAID SHIFT: pay was settled on its day and its rounded hours. Both pieces stay on that day,
  -- and the two rounded halves must add back to what was paid (hoursBetween rounds each entry to
  -- 0.01 h, so a cut on an odd second could add or lose a cent of paid time).
  if p.paid_at is not null or p.mileage_paid_at is not null then
    if (p_at at time zone v_tz)::date <> (p.clock_in at time zone v_tz)::date then
      raise exception 'That shift is already paid, so both parts have to stay on %.',
        to_char(p.clock_in at time zone v_tz, 'Mon FMDD');
    end if;
  end if;
  if p.paid_at is not null then
    v_after := round(greatest(v_span_l - case when v_lunch_left then v_lunch_s else 0 end, 0) / 3600.0, 2)
             + round(greatest(v_span_r - case when v_lunch_left then 0 else v_lunch_s end, 0) / 3600.0, 2)
             - round(greatest(extract(epoch from (p.clock_out - p.clock_in)) - v_lunch_s, 0) / 3600.0, 2);
    if v_after <> 0 then
      raise exception 'Cutting at % would change the paid hours on this shift by % h. Move the split a minute earlier or later.',
        to_char(p_at at time zone v_tz, 'FMHH12:MIam'), public.split_hours_text(abs(v_after));
    end if;
    v_after := null;
  end if;

  -- ONE HOUR, ONE CLAIM. The earliest live invoice holding this shift (0261's rule).
  v_same_job := p_right_job is not distinct from p.job_id;
  select i.id, i.invoice_number, i.status::text as status, i.org_id
    into v_hold
    from public.invoice_items it
    join public.invoices i on i.id = it.invoice_id
   where it.source_ids && array[p.id]
     and i.status <> 'void'
   order by i.created_at, i.id
   limit 1;
  if found and not v_same_job then
    if v_hold.org_id is distinct from p.org_id then
      raise exception 'Another invoice already bills this whole shift, so part of it cannot move to another job.';
    end if;
    raise exception '% (%) already bills this whole shift to %. Moving % h to % would bill it twice.',
      coalesce(v_hold.invoice_number, 'An invoice'), v_hold.status,
      public.split_job_label(p.job_id, p.job_code),
      public.split_hours_text(greatest(v_span_r - case when v_lunch_left then 0 else v_lunch_s end, 0) / 3600.0),
      public.split_job_label(p_right_job, v_code)
      using errcode = 'P0001',
            detail = 'invoice:' || v_hold.id::text,
            hint = 'Take the shift off ' || coalesce(v_hold.invoice_number, 'that invoice')
                   || ' first, or split it on the same job.';
  end if;

  v_owner := exists (select 1 from public.profiles pr where pr.id = p.profile_id and pr.role = 'owner');
  v_before := extract(epoch from (p.clock_out - p.clock_in)) - coalesce(p.lunch_minutes, 0) * 60;

  -- Shorten the parent first, so the new piece never overlaps it (zz_guard_time_entry_sanity).
  update public.time_entries
     set clock_out          = p_at,
         lunch_minutes      = case when v_lunch_left then p.lunch_minutes else 0 end,
         miles              = case when v_miles_left then p.miles else 0 end,
         gps_out            = null,
         -- The reason why a shift ran past 18 h stays with any piece still over 18 h (0281's
         -- sanity guard refuses one without it), exactly as the carve in 0289 keeps it.
         auto_closed_reason = case when p_at - p.clock_in > interval '18 hours' then p.auto_closed_reason end
   where id = p.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'That shift could not be shortened. Nothing was changed.';
  end if;

  insert into public.time_entries (
    id, profile_id, org_id, job_id, job_code, clock_in, clock_out, lunch_minutes, miles,
    gps_in, gps_out, notes, status, source, rate_override, paid_at, mileage_paid_at,
    auto_closed_reason, split_from, split_how)
  values (
    v_right_id, p.profile_id, p.org_id, p_right_job, v_code, p_at, p.clock_out,
    case when v_lunch_left then 0 else p.lunch_minutes end,
    case when v_miles_left then 0 else p.miles end,
    null, p.gps_out, null, 'closed', p.source,
    -- An owner is paid by draw (0286): his shift carries no pay rate, and a copy must not add one.
    case when v_owner then null else p.rate_override end,
    p.paid_at, p.mileage_paid_at,
    p.auto_closed_reason,
    coalesce(p.split_from, p.id), 'after');

  -- A VOID LINE KEEPS ITS WHOLE CLAIM, ON EVERY CUT (0313). A void invoice bills nothing today,
  -- but it still says which hours it billed, and guard_invoice_unvoid (0259/0260) and the app's
  -- unvoidConflict decide whether it may come back by comparing THOSE ids with every live line.
  -- The line billed the whole shift, so after the cut it has to hold both pieces, wherever the new
  -- piece's job is. 0288 carried void lines only on a same-job cut, so a cross-job cut left the void
  -- line holding the first piece alone: the second piece was then billed on the other job, the
  -- un-void compared [first] with [second], found no overlap, and let the void invoice bill its
  -- stored hours beside the new one. It also made the pieces' holder sets differ, so the Undo and
  -- Join Back refused, naming a void invoice as if it billed something.
  --
  -- VOID LINES FIRST, IN THEIR OWN STATEMENT. guard_invoice_item_claim runs per row and sees the
  -- rows this command already wrote: in one statement, a void line reached after the live line
  -- would find the live invoice already holding the new id and refuse ("hours already billed"),
  -- so the split would work or fail on row order. Void first, the live line's check then skips
  -- the void holders, as it always has. A void holder never blocks the cut (the check above reads
  -- live invoices only) and never makes the new piece look billed (every importer and
  -- invoice_holding_claim read live invoices only).
  with carried as (
    update public.invoice_items it
       set source_ids = it.source_ids || v_right_id
      from public.invoices i
     where i.id = it.invoice_id
       and i.org_id = p.org_id
       and i.status = 'void'
       and it.source_ids && array[p.id]
       and not (v_right_id = any (it.source_ids))
    returning i.id, i.invoice_number, i.status::text as status
  )
  select coalesce(jsonb_agg(distinct jsonb_build_object(
           'invoice_id', c.id, 'invoice_number', c.invoice_number, 'status', c.status)), '[]'::jsonb)
    into v_carried
    from carried c;

  -- The same job: the new piece carries the hours a live invoice already bills, so it carries the
  -- claim too. (A cross-job cut of a shift a live invoice bills was refused above.)
  if v_same_job then
    with carried as (
      update public.invoice_items it
         set source_ids = it.source_ids || v_right_id
        from public.invoices i
       where i.id = it.invoice_id
         and i.org_id = p.org_id
         and i.status <> 'void'
         and it.source_ids && array[p.id]
         and not (v_right_id = any (it.source_ids))
      returning i.id, i.invoice_number, i.status::text as status
    )
    select v_carried || coalesce(jsonb_agg(distinct jsonb_build_object(
             'invoice_id', c.id, 'invoice_number', c.invoice_number, 'status', c.status)), '[]'::jsonb)
      into v_carried
      from carried c;
  end if;

  select sum(extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60)
    into v_after
    from public.time_entries t
   where t.id in (p.id, v_right_id);
  if v_after is distinct from v_before then
    raise exception 'The two parts do not add up to the shift (% s vs % s). Nothing was changed.', v_after, v_before;
  end if;

  return jsonb_build_object(
    'left_id', p.id,
    'right_id', v_right_id,
    'left_hours', round(greatest(v_span_l - case when v_lunch_left then v_lunch_s else 0 end, 0) / 3600.0, 2),
    'right_hours', round(greatest(v_span_r - case when v_lunch_left then 0 else v_lunch_s end, 0) / 3600.0, 2),
    'lunch_on', case when v_lunch_left then 'left' else 'right' end,
    'miles_on', case when v_miles_left then 'left' else 'right' end,
    'carried', v_carried);
end $function$;

-- join_time_entries: a void holder is called void; a live one is named first, with its status.
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

-- move_time_entry_cut: a void holder is called void.
CREATE OR REPLACE FUNCTION public.move_time_entry_cut(p_left uuid, p_right uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org    uuid := public.auth_org_id();
  l        public.time_entries%rowtype;
  r        public.time_entries%rowtype;
  v_tz     text;
  v_before numeric;
  v_after  numeric;
  v_l_new  numeric;
  v_r_new  numeric;
  v_billed jsonb;
  v_l_lines uuid[];
  v_r_lines uuid[];
  v_odd    record;
  v_diff   numeric;
begin
  if v_org is null or not public.is_org_staff() then
    raise exception 'Only the office can move a split.';
  end if;
  if p_left is null or p_right is null or p_left = p_right then
    raise exception 'Pick the two parts of the split.';
  end if;

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
    raise exception 'Clock out first. A running shift has no split to move.';
  end if;
  if l.clock_out is distinct from r.clock_in then
    raise exception 'Those two entries do not touch, so there is no split between them to move.';
  end if;

  v_tz := public.split_org_tz(l.org_id);
  if p_at is null or p_at <= l.clock_in or p_at >= r.clock_out then
    raise exception 'Pick a time between % and %.',
      to_char(l.clock_in at time zone v_tz, 'FMHH12:MIam'), to_char(r.clock_out at time zone v_tz, 'FMHH12:MIam');
  end if;
  if p_at = l.clock_out then
    return jsonb_build_object('left_id', l.id, 'right_id', r.id, 'moved', false, 'billed', '[]'::jsonb);
  end if;

  v_l_new := extract(epoch from (p_at - l.clock_in));
  v_r_new := extract(epoch from (r.clock_out - p_at));
  if v_l_new < 60 or v_r_new < 60 then
    raise exception 'Each part has to be at least a minute long.';
  end if;
  if v_l_new - greatest(coalesce(l.lunch_minutes, 0), 0) * 60 < 60 then
    raise exception 'The first part''s %-minute lunch would not fit. Move the lunch first, or pick a later time.', l.lunch_minutes;
  end if;
  if v_r_new - greatest(coalesce(r.lunch_minutes, 0), 0) * 60 < 60 then
    raise exception 'The second part''s %-minute lunch would not fit. Move the lunch first, or pick an earlier time.', r.lunch_minutes;
  end if;

  -- PAY DOES NOT MOVE. Time may only slide between two pieces that are paid the same way, and a
  -- paid pair keeps its day and its rounded total.
  if l.paid_at is not null or r.paid_at is not null or l.mileage_paid_at is not null or r.mileage_paid_at is not null then
    if l.paid_at is distinct from r.paid_at or l.mileage_paid_at is distinct from r.mileage_paid_at then
      raise exception 'One part is in a paid period and the other is not, so time cannot move between them.';
    end if;
    if l.rate_override is distinct from r.rate_override then
      raise exception 'These parts are paid at different rates and already paid, so time cannot move between them.';
    end if;
    if (p_at at time zone v_tz)::date <> (r.clock_in at time zone v_tz)::date then
      raise exception 'Those hours are already paid, so the split has to stay on %.',
        to_char(r.clock_in at time zone v_tz, 'Mon FMDD');
    end if;
    if l.paid_at is not null then
      v_diff := round(greatest(v_l_new - coalesce(l.lunch_minutes, 0) * 60, 0) / 3600.0, 2)
              + round(greatest(v_r_new - coalesce(r.lunch_minutes, 0) * 60, 0) / 3600.0, 2)
              - round(greatest(extract(epoch from (l.clock_out - l.clock_in)) - coalesce(l.lunch_minutes, 0) * 60, 0) / 3600.0, 2)
              - round(greatest(extract(epoch from (r.clock_out - r.clock_in)) - coalesce(r.lunch_minutes, 0) * 60, 0) / 3600.0, 2);
      if v_diff <> 0 then
        raise exception 'Cutting at % would change the paid hours on this shift by % h. Move the split a minute earlier or later.',
          to_char(p_at at time zone v_tz, 'FMHH12:MIam'), public.split_hours_text(abs(v_diff));
      end if;
    end if;
  end if;

  -- ONE HOUR, ONE CLAIM, ACROSS THE BOUNDARY TOO. 0261's C7 lets the hours on a claimed row change
  -- (the invoice keeps its figure), but a moved boundary also hands those hours to the piece on the
  -- other side. If that piece is billed by a different invoice, or by none, the importer would bill
  -- them again: the double bill the cross-job split refusal stops, reached sideways. So the cut
  -- moves only between pieces with the same claim holders (every line, void included, as join
  -- compares), which keeps the typo fix on a same-job split or an unbilled pair. Read under the
  -- claim lock (0260's org key) so an import cannot land a claim between this check and the write.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || v_org::text));
  select coalesce(array_agg(it.id order by it.id), '{}') into v_l_lines
    from public.invoice_items it where it.source_ids && array[l.id];
  select coalesce(array_agg(it.id order by it.id), '{}') into v_r_lines
    from public.invoice_items it where it.source_ids && array[r.id];
  if v_l_lines is distinct from v_r_lines then
    select i.id, i.invoice_number, i.status::text as status, (it.source_ids && array[l.id]) as bills_first
      into v_odd
      from public.invoice_items it
      join public.invoices i on i.id = it.invoice_id
     where it.id = any (v_l_lines || v_r_lines)
       and not (it.id = any (v_l_lines) and it.id = any (v_r_lines))
     order by (i.status = 'void'), i.created_at, i.id
     limit 1;
    if v_odd.status = 'void' then
      raise exception '% (void) still holds the % part and not the %, so moving the split would change what % bills if it is ever un-voided. Leave the split where it is.',
        coalesce(v_odd.invoice_number, 'A void invoice'),
        case when v_odd.bills_first then 'first' else 'second' end,
        case when v_odd.bills_first then 'second' else 'first' end,
        coalesce(v_odd.invoice_number, 'it')
        using errcode = 'P0001',
              detail = 'invoice:' || coalesce(v_odd.id::text, ''),
              hint = 'A void invoice bills nothing, but it keeps the hours it billed so an un-void cannot bill them twice. Nothing was changed.';
    end if;
    raise exception '% (%) bills the % part and not the %, so moving the split would hand billed hours to a part that could be billed again.',
      coalesce(v_odd.invoice_number, 'An invoice'), coalesce(v_odd.status, 'unknown'),
      case when v_odd.bills_first then 'first' else 'second' end,
      case when v_odd.bills_first then 'second' else 'first' end
      using errcode = 'P0001',
            detail = 'invoice:' || coalesce(v_odd.id::text, ''),
            hint = 'Leave the split where it is, or take the shift off ' || coalesce(v_odd.invoice_number, 'that invoice')
                   || ' first. Nothing was changed.';
  end if;

  v_before := extract(epoch from (l.clock_out - l.clock_in)) - coalesce(l.lunch_minutes, 0) * 60
            + extract(epoch from (r.clock_out - r.clock_in)) - coalesce(r.lunch_minutes, 0) * 60;

  -- Shrink first, then grow, so the two never overlap in between.
  if p_at > l.clock_out then
    update public.time_entries set clock_in = p_at where id = r.id;
    update public.time_entries set clock_out = p_at where id = l.id;
  else
    update public.time_entries set clock_out = p_at where id = l.id;
    update public.time_entries set clock_in = p_at where id = r.id;
  end if;

  select sum(extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60)
    into v_after
    from public.time_entries t
   where t.id in (l.id, r.id);
  if v_after is distinct from v_before then
    raise exception 'The two parts no longer add up to the shift (% s vs % s). Nothing was changed.', v_after, v_before;
  end if;

  -- Who bills a piece that just changed length (both did). billedPartMoved's facts, one per line.
  select coalesce(jsonb_agg(jsonb_build_object(
           'invoice_id', i.id, 'invoice_number', i.invoice_number, 'status', i.status::text,
           'entry_id', x.id, 'hours_before', x.before_h, 'hours_after', x.after_h)
           order by i.created_at, x.ord), '[]'::jsonb)
    into v_billed
    from (values
            (l.id, 1,
             round(greatest(extract(epoch from (l.clock_out - l.clock_in)) - coalesce(l.lunch_minutes, 0) * 60, 0) / 3600.0, 2),
             round(greatest(v_l_new - coalesce(l.lunch_minutes, 0) * 60, 0) / 3600.0, 2)),
            (r.id, 2,
             round(greatest(extract(epoch from (r.clock_out - r.clock_in)) - coalesce(r.lunch_minutes, 0) * 60, 0) / 3600.0, 2),
             round(greatest(v_r_new - coalesce(r.lunch_minutes, 0) * 60, 0) / 3600.0, 2))
         ) as x(id, ord, before_h, after_h)
    join public.invoice_items it on it.source_ids && array[x.id]
    join public.invoices i on i.id = it.invoice_id and i.status <> 'void' and i.org_id = l.org_id;

  return jsonb_build_object(
    'left_id', l.id,
    'right_id', r.id,
    'moved', true,
    'left_hours', round(greatest(v_l_new - coalesce(l.lunch_minutes, 0) * 60, 0) / 3600.0, 2),
    'right_hours', round(greatest(v_r_new - coalesce(r.lunch_minutes, 0) * 60, 0) / 3600.0, 2),
    'billed', v_billed);
end $function$;

comment on function public.split_time_entry(uuid, timestamptz, uuid, text, text, text) is
  'Office only (0288, 0313). Cuts one closed entry at p_at: the entry keeps its id as the left piece, a right piece is inserted on p_right_job / p_right_code. Worked seconds are asserted equal; lunch and miles move whole; rate_override, paid_at and mileage_paid_at are copied (never an override onto an owner); a paid shift keeps its day and rounded hours. Every VOID line holding the parent gets the new id on every cut (0313: an un-void must not re-bill); a same-job piece also inherits a live claim by an appended id; a cross-job cut of a shift a live invoice bills is refused, naming it (detail invoice:<id>).';
comment on function public.join_time_entries(uuid, uuid) is
  'Office only (0288, 0313). Joins two touching closed pieces of one person back into the left one. Refused unless both have the same claim holders (void lines included; a void holder is named "(void) still holds"), paid_at, mileage_paid_at and rate_override. Removes exactly the absorbed id from the lines that hold it, deletes it, and widens the kept piece; lunch and miles add. Worked seconds are asserted equal.';
comment on function public.move_time_entry_cut(uuid, uuid, timestamptz) is
  'Office only (0288, 0313). Slides the boundary between two touching closed pieces of one person to p_at, never reordering them. Refused across a paid/unpaid or rate difference, off a paid day, when the paid rounded hours would change, or when the two pieces have different claim holders, void lines included (detail invoice:<id>; a void holder is named "(void) still holds"). Returns every live invoice billing a piece whose length changed (billed[]).';

-- ── 3. BACKFILL: PIECES CUT BEFORE THIS FILE ──────────────────────────────────────────────────
-- A void line held the shift before a piece was cut from it when the line's invoice is older than
-- the piece; then the line billed the piece's hours too. Every piece points at the family's first
-- entry (split_from), and the first entry keeps its id, so "a void line holding split_from, on an
-- invoice created before the piece" is the test. It can over-reach only one way (a line added to
-- an old invoice after an earlier cut), and that way only widens a void claim: an un-void may be
-- refused where it could have gone, never let through where it must not.
-- A plain session temp table, dropped at the end, NOT `on commit drop` (0290's reason: run without a
-- wrapping transaction, that clause drops it the moment its own statement commits).
create temp table _0313_owed as
  select it.id as line_id, i.id as invoice_id, i.invoice_number, i.org_id, c.id as piece_id,
         public.invoice_holding_claim(array[c.id], c.org_id) as live_holder
    from public.time_entries c
    join public.invoice_items it on it.source_ids && array[c.split_from]
    join public.invoices i on i.id = it.invoice_id
   where c.split_from is not null
     and i.status = 'void'
     and i.org_id = c.org_id
     and i.created_at < c.created_at
     and not (c.id = any (it.source_ids));

do $$
declare
  v_names text;
begin
  -- A piece a live invoice already bills: the void invoice beside it is the double bill waiting for
  -- an un-void, and the claim guard would refuse the append in words about hours. Say it plainly and
  -- change nothing; a person decides which invoice bills those hours.
  select string_agg(distinct coalesce(o.invoice_number, o.invoice_id::text) || ' (void) and ' || o.live_holder, '; ')
    into v_names
    from _0313_owed o
   where o.live_holder is not null;
  if v_names is not null then
    raise exception '0313: these void invoices billed a shift whose later piece is now billed live: %. Un-voiding one would bill those hours twice, and this file will not decide which invoice keeps them. Nothing was changed.', v_names;
  end if;
end $$;

-- Void first is not needed here (every holder written is void), and the claim guard finds no live
-- holder of these ids (checked just above), so each append passes it.
-- ONE write per line, with ALL its owed pieces: a line cut cross-job twice owes two, and an
-- UPDATE ... FROM that joins a target row to several source rows applies only one of them, so a
-- per-piece join would append one piece, leave the other, and trip the check below on every run.
update public.invoice_items it
   set source_ids = it.source_ids || a.pieces
  from (select o.line_id, array_agg(distinct o.piece_id) as pieces
          from _0313_owed o
         group by o.line_id) a
 where it.id = a.line_id;

-- ── 4. THE CHECK ──────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_n     bigint;
  v_owed  bigint;
  v_lines bigint;
  v_names text;
begin
  select count(*), count(distinct line_id) into v_owed, v_lines from _0313_owed;

  select string_agg(w.fn, ', ') into v_names
    from (values
      ('split_time_entry(uuid, timestamptz, uuid, text, text, text)', 'A VOID LINE KEEPS ITS WHOLE CLAIM, ON EVERY CUT (0313)'),
      ('join_time_entries(uuid, uuid)',                                '(void) still holds the % part and not the %, so joining'),
      ('move_time_entry_cut(uuid, uuid, timestamptz)',                 '(void) still holds the % part and not the %, so moving')
    ) as w(fn, marker)
   where to_regprocedure('public.' || w.fn) is null
      or position(w.marker in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.' || w.fn))) = 0;
  if v_names is not null then
    raise exception '0313: these functions are missing or do not carry this file''s rules: %. Nothing was changed.', v_names;
  end if;

  -- The void carry sits OUTSIDE the same-job branch: it comes before the first "if v_same_job then".
  if position('i.status = ''void''' in (select prosrc from pg_proc where oid = to_regprocedure('public.split_time_entry(uuid, timestamptz, uuid, text, text, text)')))
     > position('if v_same_job then' in (select prosrc from pg_proc where oid = to_regprocedure('public.split_time_entry(uuid, timestamptz, uuid, text, text, text)'))) then
    raise exception '0313: split_time_entry still carries void lines only on a same-job cut. Nothing was changed.';
  end if;

  -- CREATE OR REPLACE keeps grants; prove it. The office calls all three as authenticated; anon never.
  select string_agg(f, ', ') into v_names
    from unnest(array['split_time_entry(uuid, timestamptz, uuid, text, text, text)',
                      'join_time_entries(uuid, uuid)',
                      'move_time_entry_cut(uuid, uuid, timestamptz)']) as f
   where not has_function_privilege('authenticated', 'public.' || f, 'execute')
      or not has_function_privilege('service_role', 'public.' || f, 'execute')
      or has_function_privilege('anon', 'public.' || f, 'execute');
  if v_names is not null then
    raise exception '0313: the grants on these changed: %. Nothing was changed.', v_names;
  end if;

  -- Nothing owed is left: every void line that held a shift before a piece was cut holds the piece.
  select count(*) into v_n
    from public.time_entries c
    join public.invoice_items it on it.source_ids && array[c.split_from]
    join public.invoices i on i.id = it.invoice_id
   where c.split_from is not null
     and i.status = 'void'
     and i.org_id = c.org_id
     and i.created_at < c.created_at
     and not (c.id = any (it.source_ids));
  if v_n <> 0 then
    raise exception '0313: % void lines still hold a shift without a piece cut from it after them. Nothing was changed.', v_n;
  end if;

  raise notice '0313: void claims follow every cut; % piece(s) added to % void line(s).', v_owed, v_lines;
end $$;

drop table _0313_owed;
