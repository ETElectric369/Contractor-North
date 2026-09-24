-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0290: the old split table is gone
--
-- ORDER: after 0288 (a split is a cut) and 0289 (the old splits became entries; the table was
-- emptied, archived and frozen), and at least one deploy after the code that stopped reading it
-- (cn-v985). Apply AFTER this branch's code is live: the DB suite it ships no longer builds
-- old-style rows, and the one on main before it still does.
--
-- ONE TRANSACTION, AND ONLY IF THE RUNNER MAKES IT ONE. The file has no BEGIN/COMMIT of its own
-- (no migration here does; the runners own the transaction). Apply it with
-- scripts/run-one-migration.mjs (begin/commit around the file), `psql -1 -f`, or the Supabase SQL
-- editor or CLI (one implicit transaction). Under any of those a failed check at the bottom rolls
-- ALL of it back. NEVER a plain `psql -f` without -1: each statement would commit on its own, and a
-- failure half way would leave the table dropped with the checks unrun. Writes no data. Not
-- re-runnable by design: a second run stops at the first DROP, loudly, and changes nothing.
--
-- WHAT THIS CLOSES. Phase 5 of "a split shift is separate timecard entries" (Erik, 2026-09-24).
-- public.time_allocations was the second ledger: a list of HOURS beside the clock times, tied to
-- them by nothing but a per-row check. 0289 turned every row into ordinary time entries, copied all
-- 20 rows to archive.time_allocations, and froze the table with an insert trigger. This drops the
-- table and everything that only existed for it, so no code can ever write a split the old way
-- again, and three live functions stop reading a table that can only ever be empty.
--
-- WHY IT IS SAFE NOW.
--   * The table is empty (checked below before the DROP, not assumed) and has refused every insert
--     since 0289. The archive keeps every row it ever held and stays.
--   * No app code names it: tests/no-time-allocations.test.ts and the ci.yml grep gate, and since
--     this change neither exempts the DB test harness any more. PostgREST fails the whole query when
--     a select embeds a missing table, which is why the code went a deploy first.
--   * The live catalog was swept (2026-09-24, read-only) for everything that references it:
--     functions by source (every schema), triggers, views and materialized views, policies,
--     indexes, foreign keys in and out, grants, publication membership, event triggers and
--     pg_depend. What it found is exactly what this file handles:
--       functions naming it     guard_billed_time_entry (0261), guard_invoice_item_claim (0260),
--                               split_time_entry (0288), guard_time_allocation (0288),
--                               carve_legacy_allocations (0289)
--       functions serving it    guard_billed_time_allocation (0289), refuse_time_allocation_insert
--                               (0289), replace_time_allocations (0289: always raises)
--       triggers on it          stamp_org_time_allocations (0010, set_org_id is shared and stays),
--                               guard_time_allocation (0154), time_allocations_billed_hours_stay
--                               (0261), aa_time_allocations_frozen (0289)
--       policy                  time_allocations_all (0010, ALL, own-org + own-shift-or-staff)
--       indexes                 time_allocations_entry_idx (0010), time_allocations_job_idx (0090);
--                               the primary key and its three foreign keys (time_entries, jobs,
--                               organizations) belong to the table and go with it
--       nothing else            no view, no materialized view, no foreign key pointing AT it, no
--                               function taking or returning its row type, not in supabase_realtime,
--                               nothing in auth or storage, no cron. The other time-entry guards
--                               (0154, 0169, 0248, 0288's job and split-link guards) never read it.
--
-- THE THREE FUNCTIONS THAT STAY, REWRITTEN. Each is its LIVE definition (pg_get_functiondef,
-- 2026-09-24), not an older migration's text, with the time_allocations read taken out and nothing
-- else touched. For time entries each behaves exactly as it does today, because today the read
-- always finds an empty table:
--   * guard_billed_time_entry: a shift may not be deleted while a non-void invoice claims it. It
--     also looked for claims on the shift's allocation ids, because deleting the entry cascaded
--     the allocations away. There are no allocations and no cascade left. A retired allocation id
--     that a sent or paid line still holds sits on a line that also holds the entry that took its
--     hours (0289 proved that for every live line), so the entry's own id still finds the claim.
--   * guard_invoice_item_claim: names a double-billed row "hours", "materials" or "work". An
--     allocation id counted as hours; there are none, so only a time entry id does.
--   * split_time_entry: refused a shift that "still has an old-style split". None can.
--
-- ORDER FOLLOWED
--   1. Snapshot what must not move (the INV-078 claim line, the converted entries), for the check.
--   2. CREATE OR REPLACE the three survivors, so nothing live reads the table when it goes.
--   3. DROP, dependency order, plain DROP with no CASCADE so anything unexpected fails loudly:
--      the four triggers on the table, then the five functions that only served it, the policy,
--      the two indexes, and the table (asserted empty first).
--   4. Check: the table is gone, no public function names it and no comment in public describes
--      it as live (invoice_items.source_ids is rewritten just before), the archive still holds 20
--      rows, the guards that stay exist and are enabled, and the snapshot in 1 is unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. WHAT MUST NOT MOVE ─────────────────────────────────────────────────────────────────────
-- ET Electric's draft INV-078 labor line (the only invoice line 0289 wrote) and the entries 0289
-- built from old splits. This file writes neither; the check at the bottom proves it by count.
-- A plain session temp table, dropped after the check, NOT `on commit drop`: at the top level
-- that clause would drop it the moment its own statement committed if the file were ever run
-- without a wrapping transaction, and the check would then fail on a missing table instead of
-- saying what it found.
create temp table _drop_before as
select
  (select count(*) from public.invoice_items x
     join public.invoices i on i.id = x.invoice_id
    where x.id = '72c2c363-5f49-41d7-9846-baa07cc0c767'
      and i.org_id = '60195593-2e18-4230-bc8e-7a32d36d038d'
      and i.invoice_number = 'INV-078') as inv078_line,
  (select count(*) from public.invoice_items x
    where x.id = '72c2c363-5f49-41d7-9846-baa07cc0c767'
      and x.org_id = '60195593-2e18-4230-bc8e-7a32d36d038d'
      and x.quantity = 50.50
      and cardinality(x.source_ids) = 14) as inv078_same,
  (select count(*) from public.time_entries
    where org_id = '60195593-2e18-4230-bc8e-7a32d36d038d' and split_how = 'converted') as converted,
  (select count(*) from public.time_entries
    where org_id = '60195593-2e18-4230-bc8e-7a32d36d038d'
      and id in (select became from archive.time_allocations
                  where org_id = '60195593-2e18-4230-bc8e-7a32d36d038d')) as carriers;

-- ── 2. THE SURVIVORS STOP READING IT ──────────────────────────────────────────────────────────
-- guard_billed_time_entry (0261): the allocation-id lookup is gone; the entry's own id is the claim.
CREATE OR REPLACE FUNCTION public.guard_billed_time_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_holder text;
begin
  v_holder := public.invoice_holding_claim(array[old.id], old.org_id);
  if v_holder is null then
    return old;
  end if;

  raise exception '% already bills this shift', v_holder
    using errcode = 'P0001',
          hint = 'Void or adjust ' || v_holder || ' before deleting the shift. Nothing was changed.';
end $function$;

comment on function public.guard_billed_time_entry() is
  'BEFORE DELETE on time_entries (0261; 0290 dropped the allocation lookup with the table): a shift a non-void invoice claims may not be deleted, or its hours would be free for a second invoice. Raises "INV-0xx already bills this shift".';

-- guard_invoice_item_claim (0258, serialized 0260): "hours" is a time entry id and nothing else now.
CREATE OR REPLACE FUNCTION public.guard_invoice_item_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_added uuid[];
  v_org   uuid;
  v_hit   record;
  v_what  text;
begin
  -- What this write ADDS (see 0258's header for why an edit's existing claims are not re-judged).
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

  -- The org is the invoice's, never new.org_id: the column is what the writer said, the invoice is
  -- what the row is attached to. Scoping the lookup to the org also means the invoice number in
  -- the sentence is always one of the caller's own (0173 — never another tenant's).
  select org_id into v_org from public.invoices where id = new.invoice_id;

  -- THE LOCK (0260). Everything below this line is a read, and a read cannot refuse a row that is
  -- not committed yet: without this, two drafts built in the same second each find the hours free
  -- and each keep them. One key for the whole org, because the read below spans the whole org and
  -- every job. Same key as guard_invoice_unvoid, so an import and an un-void racing each other
  -- contend instead of passing in the dark.
  --
  -- The coalesce is not decoration. pg_advisory_xact_lock is STRICT: a null key takes no lock at
  -- all, silently, and the guard would be a convention again. An invoice with no org falls back to
  -- its own id — the same fallback guard_invoice_unvoid uses, so the two still meet on one key.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(v_org::text, new.invoice_id::text)));

  -- The earliest OTHER non-void invoice holding any of these ids, and which ids it holds.
  select xi.invoice_number,
         (select array_agg(s) from unnest(x.source_ids) as s where s = any (v_added)) as ids
    into v_hit
    from public.invoice_items x
    join public.invoices xi on xi.id = x.invoice_id
   where x.invoice_id <> new.invoice_id
     and xi.status <> 'void'
     and xi.org_id is not distinct from v_org
     and x.source_ids && v_added
   order by xi.created_at, xi.id
   limit 1;
  if not found then
    return new;
  end if;

  -- Name the thing in the office's word for it: a time row is hours, a bill or order is
  -- materials, anything else (a change order, an estimate line) is work.
  v_what := case
    when exists (select 1 from public.time_entries te where te.id = any (v_hit.ids)) then 'hours'
    when exists (select 1 from public.bills b where b.id = any (v_hit.ids))
      or exists (select 1 from public.purchase_orders p where p.id = any (v_hit.ids)) then 'materials'
    else 'work'
  end;
  raise exception '% already billed on %', v_what, coalesce(v_hit.invoice_number, 'another invoice')
    using errcode = 'P0001',
          hint = 'A row is billed on one invoice at a time. Void or adjust that invoice first.';
end $function$;

-- split_time_entry (0288): the "still has an old-style split" refusal is gone; no shift can have one.
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

  -- The same job: the new piece carries the hours the invoice already bills, so it carries the
  -- claim too. Every line holding the parent, void lines included (an un-void must not re-bill).
  --
  -- VOID LINES FIRST, IN THEIR OWN STATEMENT. guard_invoice_item_claim runs per row and sees the
  -- rows this command already wrote: in one statement, a void line reached after the live line
  -- would find the live invoice already holding the new id and refuse ("hours already billed"),
  -- so the split would work or fail on row order. Void first, the live line's check then skips
  -- the void holders, as it always has.
  if v_same_job then
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

-- ── 3. THE DROP, IN DEPENDENCY ORDER ──────────────────────────────────────────────────────────
-- Triggers first: each one depends on its function.
drop trigger aa_time_allocations_frozen on public.time_allocations;
drop trigger guard_time_allocation on public.time_allocations;
drop trigger time_allocations_billed_hours_stay on public.time_allocations;
drop trigger stamp_org_time_allocations on public.time_allocations;

-- The functions that only served the table. set_org_id and invoice_holding_claim are shared and stay.
drop function public.refuse_time_allocation_insert();
drop function public.guard_time_allocation();
drop function public.guard_billed_time_allocation();
drop function public.replace_time_allocations(uuid, jsonb);
drop function public.carve_legacy_allocations(boolean, uuid[], jsonb);

drop policy time_allocations_all on public.time_allocations;

drop index public.time_allocations_job_idx;
drop index public.time_allocations_entry_idx;

do $$
begin
  if exists (select 1 from public.time_allocations) then
    raise exception '0290: public.time_allocations has rows again. It was frozen by 0289; find out how before dropping it. Nothing was changed.';
  end if;
end $$;

drop table public.time_allocations;

comment on table archive.time_allocations is
  'Every time_allocations row as it stood when 0289 converted the old splits into ordinary time entries; public.time_allocations was dropped by 0290. Not exposed to PostgREST. became = the time entry that carries its hours now (null when that entry was an empty punch 0289 deleted).';

-- The column comment 0255 wrote still called allocation ids a live kind of labor claim.
comment on column public.invoice_items.source_ids is
  'The source rows this imported line bills — time_entry ids on a labor line; bill, purchase_order, change_order or quote_line_item ids on the others. A row is billed on at most ONE non-void invoice: the importers skip ids claimed elsewhere on the job. Empty on hand-typed lines. 0255; since 0290 only a time entry id counts as hours (an older line may still carry a retired id from archive.time_allocations beside the entry that took its hours).';

-- ── 4. THE CHECK ──────────────────────────────────────────────────────────────────────────────
do $$
declare
  b        record;
  v_names  text;
  v_n      bigint;
begin
  if to_regclass('public.time_allocations') is not null then
    raise exception '0290: public.time_allocations still exists. Nothing was changed.';
  end if;

  select string_agg(p.proname, ', ' order by p.proname) into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ilike '%time_allocations%';
  if v_names is not null then
    raise exception '0290: these functions still name time_allocations: %. Nothing was changed.', v_names;
  end if;

  select string_agg(p.proname, ', ' order by p.proname) into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('refuse_time_allocation_insert', 'guard_time_allocation', 'guard_billed_time_allocation',
                       'replace_time_allocations', 'carve_legacy_allocations');
  if v_names is not null then
    raise exception '0290: these functions should be gone: %. Nothing was changed.', v_names;
  end if;

  -- No comment on anything in public still describes the table as live. A mention is allowed only
  -- when it names the archive, or on time_entries.split_how, whose 'converted' says where those
  -- pieces came from (history, not a live table).
  select string_agg(coalesce(c.relname || coalesce('.' || a.attname, ''), pr.proname), ', ') into v_names
    from pg_description d
    left join pg_class c      on d.classoid = 'pg_class'::regclass and c.oid = d.objoid
    left join pg_attribute a  on a.attrelid = c.oid and a.attnum = d.objsubid and d.objsubid > 0
    left join pg_proc pr      on d.classoid = 'pg_proc'::regclass and pr.oid = d.objoid
   where coalesce(c.relnamespace, pr.pronamespace) = 'public'::regnamespace
     and d.description ilike '%time_allocation%'
     and d.description not ilike '%archive.time_allocations%'
     and not (c.relname = 'time_entries' and a.attname = 'split_how');
  if v_names is not null then
    raise exception '0290: these comments still describe time_allocations as live: %. Nothing was changed.', v_names;
  end if;

  select count(*) into v_n from archive.time_allocations;
  if v_n <> 20 then
    raise exception '0290: archive.time_allocations holds % rows, not the 20 0289 archived. Nothing was changed.', v_n;
  end if;

  -- The guards that stay: present, on the right table, calling the right function, and enabled.
  select string_agg(w.tbl || '.' || w.tg, ', ') into v_names
    from (values
      ('time_entries',  'time_entries_billed_hours_stay',    'guard_billed_time_entry'),
      ('time_entries',  'time_entries_billed_job_stays',     'guard_billed_time_entry_job'),
      ('time_entries',  'guard_time_entry_split_link',       'guard_time_entry_split_link'),
      ('time_entries',  'guard_paid_time_entry',             'guard_paid_time_entry'),
      ('time_entries',  'zz_guard_time_entry_sanity',        'guard_time_entry_sanity'),
      ('time_entries',  'refuse_pay_rate_on_owner_entry',    'refuse_pay_rate_on_owner_entry'),
      ('invoice_items', 'invoice_items_claim_is_a_boundary', 'guard_invoice_item_claim')
    ) as w(tbl, tg, fn)
   where not exists (
     select 1 from pg_trigger t
      where t.tgrelid = to_regclass('public.' || w.tbl)
        and t.tgname = w.tg
        and t.tgfoid = to_regprocedure('public.' || w.fn || '()')
        and t.tgenabled <> 'D');
  if v_names is not null then
    raise exception '0290: these guards are missing or disabled: %. Nothing was changed.', v_names;
  end if;
  if to_regprocedure('public.split_time_entry(uuid, timestamptz, uuid, text, text, text)') is null then
    raise exception '0290: split_time_entry is missing. Nothing was changed.';
  end if;

  -- Nothing this file does touches invoice lines or entries; the counts say so.
  select * into b from _drop_before;
  if b.inv078_line <> (select count(*) from public.invoice_items x
                         join public.invoices i on i.id = x.invoice_id
                        where x.id = '72c2c363-5f49-41d7-9846-baa07cc0c767'
                          and i.org_id = '60195593-2e18-4230-bc8e-7a32d36d038d'
                          and i.invoice_number = 'INV-078')
     or b.inv078_same <> (select count(*) from public.invoice_items x
                           where x.id = '72c2c363-5f49-41d7-9846-baa07cc0c767'
                             and x.org_id = '60195593-2e18-4230-bc8e-7a32d36d038d'
                             and x.quantity = 50.50
                             and cardinality(x.source_ids) = 14)
     or b.converted <> (select count(*) from public.time_entries
                         where org_id = '60195593-2e18-4230-bc8e-7a32d36d038d' and split_how = 'converted')
     or b.carriers <> (select count(*) from public.time_entries
                        where org_id = '60195593-2e18-4230-bc8e-7a32d36d038d'
                          and id in (select became from archive.time_allocations
                                      where org_id = '60195593-2e18-4230-bc8e-7a32d36d038d')) then
    raise exception '0290: the INV-078 claim line or the converted entries changed. Nothing was changed.';
  end if;

  raise notice '0290: time_allocations dropped; archive 20 rows; INV-078 line % / %, converted entries %, carriers %.',
    b.inv078_line, b.inv078_same, b.converted, b.carriers;
end $$;

drop table _drop_before;
