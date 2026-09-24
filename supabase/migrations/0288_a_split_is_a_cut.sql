-- 0288 - A SPLIT IS A CUT, NOT A SECOND LEDGER (Erik, 2026-09-24: "i think it will be better if a
-- shift is split to create multiple timecard entries instead of trying to do this complicated thing
-- whatever it is it doesnt work very well").
--
-- WHAT WAS WRONG WITH THE OLD SPLIT. A split shift kept its clock times on time_entries and wrote a
-- second, free-standing list of HOURS into time_allocations. Nothing tied the two together except a
-- per-row check that ran for techs only, so the office could add hours the clock never saw. It did,
-- once, on Jul 14: entry 0c7fae89 was clocked 11:30-17:30 with lunch (5.5 h), billed as one shift on
-- paid INV-048, and ten days later a lone staff insert added a 1 h J-011 row beside the 4.5 h J-033
-- row. Draft INV-078 then claimed that hour too. Every reader (labor billing, job cost, the
-- job hub, analytics, the end-of-day sweep) had to re-derive which hours belonged where from two
-- tables, and each re-derivation was another place for them to disagree.
--
-- THE NEW SHAPE. A split CUTS a closed entry at a clock time into ordinary, touching time entries,
-- one job (or time code) each. The pieces partition the parent's span, so they cannot add up to more
-- than the shift, and every reader already knows how to read a time entry. This file is the tools;
-- 0289 converts the old splits and freezes the old table.
--
--   split_time_entry     one cut per call (a three-job day is two calls). Office only.
--   join_time_entries    the Undo after a split, and "Join Back Into One Shift". Office only.
--   move_time_entry_cut  slides the boundary between two touching pieces. Never reorders. Office only.
--   switch_job           the live Switch Job button: closes the running entry now and opens the next.
--
-- AND TWO BOUNDARIES THAT WERE CONVENTIONS:
--   * a job_id change on an entry an invoice claims is refused here, not only in updateTimeEntry
--     (0261's header named it "still a convention"; RLS lets a tech PATCH his own rows);
--   * until 0289 empties it, a staff or server INSERT into time_allocations obeys the worked-hours
--     ceiling too. The Jul 14 row was exactly that insert.
--
-- MONEY LAWS EVERY FUNCTION BELOW ASSERTS, NOT ASSUMES:
--   * worked SECONDS before = after, exactly (a split cannot create hours);
--   * one hour, one claim: a same-job piece inherits the parent's claim by an appended id, a
--     cross-job cut of a shift a live invoice bills is refused and names that invoice;
--   * pay does not move: rate_override, paid_at and mileage_paid_at are copied, a paid shift keeps
--     its org-local day and its rounded hours, and miles are never divided;
--   * no sent or paid invoice line changes except by appending (split) or removing (join) exactly
--     the id of a piece that carries the same hours.
--
-- Idempotent: add column if not exists / create or replace / drop ... if exists throughout.

-- ── 1. WHERE A PIECE CAME FROM ──────────────────────────────────────────────────────────────────
-- split_from points at the FIRST entry of the family (the one that kept the original id), so every
-- piece of one shift groups under one row however many cuts it took. split_how says how the piece
-- was made: 'live' (Switch Job), 'after' (split on Timecards), 'converted' (0289, "Rebuilt From An
-- Old Split"). The kept first entry carries neither; its children say it was split.
alter table public.time_entries
  add column if not exists split_from uuid references public.time_entries(id) on delete set null;
alter table public.time_entries
  add column if not exists split_how text;
alter table public.time_entries drop constraint if exists time_entries_split_how_check;
alter table public.time_entries
  add constraint time_entries_split_how_check check (split_how in ('live', 'after', 'converted'));
create index if not exists time_entries_split_from_idx
  on public.time_entries (split_from) where split_from is not null;

comment on column public.time_entries.split_from is
  'The first entry of the shift this piece was cut from (0288). Every piece of one split shift points at the same row. Null on an ordinary entry and on that first entry itself.';
comment on column public.time_entries.split_how is
  'How this piece was made: live (Switch Job), after (split on Timecards), converted (0289, rebuilt from an old time_allocations split).';

-- A tech's PATCH may not rewrite the link (RLS lets him update his own rows), and nobody may point a
-- piece at another person's shift: the Timecards bracket groups by it.
create or replace function public.guard_time_entry_split_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.split_from is not distinct from old.split_from
     and new.split_how is not distinct from old.split_how then
    return new;
  end if;

  -- The FK's own ON DELETE SET NULL, when the first entry is joined away or deleted: always fine.
  if tg_op = 'UPDATE' and new.split_from is null and old.split_from is not null
     and new.split_how is not distinct from old.split_how
     and not exists (select 1 from public.time_entries t where t.id = old.split_from) then
    return new;
  end if;

  if new.split_from is not null and not exists (
       select 1 from public.time_entries t
        where t.id = new.split_from
          and t.profile_id = new.profile_id
          and t.org_id = new.org_id) then
    raise exception 'A split piece has to come from the same person''s shift.';
  end if;

  if not public.is_org_staff() and not public.is_privileged_writer() then
    if tg_op = 'UPDATE' then
      raise exception 'Only office staff can change how a shift was split.';
    end if;
    -- A tech's only door is Switch Job, which opens the next piece as 'live'.
    if new.split_how is distinct from 'live' and (new.split_how is not null or new.split_from is not null) then
      raise exception 'Only office staff can split a shift after the fact.';
    end if;
  end if;
  return new;
end $$;

revoke execute on function public.guard_time_entry_split_link() from public, anon;

drop trigger if exists guard_time_entry_split_link on public.time_entries;
create trigger guard_time_entry_split_link
  before insert or update of split_from, split_how on public.time_entries
  for each row execute function public.guard_time_entry_split_link();

-- ── 2. A SHIFT AN INVOICE BILLS STAYS ON ITS JOB ────────────────────────────────────────────────
-- The claim is by id and survives a move, so moving a billed shift is not a double bill; it is an
-- invoice that says the hours were worked on a job the timecard no longer says. updateTimeEntry
-- refuses it (claimedMoveRefusal); this is the boundary under it. After 0289 the pieces that paid
-- INV-051 and draft INV-078 bill by their own ids would otherwise be re-pointable by a direct PATCH.
-- Same exemption as 0263: when the job itself is deleted, ON DELETE SET NULL nulls job_id, and the
-- job row is already gone by then.
create or replace function public.guard_billed_time_entry_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_holder text;
  v_job    text;
begin
  if new.job_id is not distinct from old.job_id then
    return new;
  end if;
  if new.job_id is null and old.job_id is not null
     and not exists (select 1 from public.jobs j where j.id = old.job_id) then
    return new;
  end if;

  v_holder := public.invoice_holding_claim(array[old.id], old.org_id);
  if v_holder is null then
    return new;
  end if;

  select coalesce(nullif(btrim(j.name), ''), nullif(btrim(j.job_number), ''), 'its job')
    into v_job
    from public.jobs j
   where j.id = old.job_id;
  raise exception '% already bills this shift on %', v_holder, coalesce(v_job, 'its job')
    using errcode = 'P0001',
          hint = 'Void or adjust ' || v_holder || ' before moving the shift to another job. Nothing was changed.';
end $$;

revoke execute on function public.guard_billed_time_entry_job() from public, anon;
comment on function public.guard_billed_time_entry_job() is
  'BEFORE UPDATE OF job_id on time_entries (0288): an entry a non-void invoice claims by its own id may not move to another job or lose its job, except through the job-delete cascade (the job row is already gone). Raises "INV-0xx already bills this shift on <job>".';

drop trigger if exists time_entries_billed_job_stays on public.time_entries;
create trigger time_entries_billed_job_stays
  before update of job_id on public.time_entries
  for each row execute function public.guard_billed_time_entry_job();

-- ── 3. SMALL SHARED WORDS ───────────────────────────────────────────────────────────────────────
-- Private helpers for the functions below (and 0289). Not callable by clients.
create or replace function public.split_org_tz(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif((select o.settings ->> 'timezone' from public.organizations o where o.id = p_org), ''),
                  'America/Los_Angeles');
$$;

-- 1 -> "1", 1.5 -> "1.5", 0.25 -> "0.25", 10 -> "10".
create or replace function public.split_hours_text(p_hours numeric)
returns text
language sql
immutable
as $$
  select regexp_replace(to_char(round(coalesce(p_hours, 0), 2), 'FM999999990.99'), '\.$', '');
$$;

-- The name a person knows the job by (schedule-options.ts jobLabel), or the time code.
create or replace function public.split_job_label(p_job uuid, p_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(nullif(btrim(j.name), ''), nullif(btrim(j.job_number), '')) from public.jobs j where j.id = p_job),
    nullif(btrim(p_code), ''),
    'no job');
$$;

revoke execute on function public.split_org_tz(uuid) from public, anon, authenticated;
revoke execute on function public.split_hours_text(numeric) from public, anon, authenticated;
revoke execute on function public.split_job_label(uuid, text) from public, anon, authenticated;

-- ── 4. split_time_entry: ONE CUT ────────────────────────────────────────────────────────────────
-- The parent keeps its id and becomes the LEFT piece (so every claim, note and payroll link that
-- names it still names the start of the shift); the RIGHT piece is inserted.
--
-- p_lunch_on / p_miles_on: 'left' or 'right'. A null lunch side means "the longer piece" (the sheet's
-- default); a null miles side means the left piece. Lunch and miles move whole, never divided.
create or replace function public.split_time_entry(
  p_entry      uuid,
  p_at         timestamptz,
  p_right_job  uuid,
  p_right_code text,
  p_lunch_on   text default null,
  p_miles_on   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if p.status <> 'closed' or p.clock_out is null then
    raise exception 'That shift is still running. Use Switch Job to start the next part now.';
  end if;
  if p.clock_out <= p.clock_in then
    raise exception 'That shift has no length, so there is nothing to split.';
  end if;
  if exists (select 1 from public.time_allocations a where a.time_entry_id = p.id) then
    raise exception 'This shift still has an old-style split. It is being converted; split it after that.';
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
    if round(greatest(v_span_l - case when v_lunch_left then v_lunch_s else 0 end, 0) / 3600.0, 2)
       + round(greatest(v_span_r - case when v_lunch_left then 0 else v_lunch_s end, 0) / 3600.0, 2)
       <> round(greatest(extract(epoch from (p.clock_out - p.clock_in)) - v_lunch_s, 0) / 3600.0, 2) then
      raise exception 'That split would change the paid hours on this shift by a rounding cent. Move the split time by a minute.';
    end if;
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
         auto_closed_reason = null
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
  if v_same_job then
    with carried as (
      update public.invoice_items it
         set source_ids = it.source_ids || v_right_id
        from public.invoices i
       where i.id = it.invoice_id
         and i.org_id = p.org_id
         and it.source_ids && array[p.id]
         and not (v_right_id = any (it.source_ids))
      returning i.id, i.invoice_number, i.status::text as status
    )
    select coalesce(jsonb_agg(distinct jsonb_build_object(
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
end $$;

revoke execute on function public.split_time_entry(uuid, timestamptz, uuid, text, text, text) from public, anon;
grant execute on function public.split_time_entry(uuid, timestamptz, uuid, text, text, text) to authenticated, service_role;
comment on function public.split_time_entry(uuid, timestamptz, uuid, text, text, text) is
  'Office only (0288). Cuts one closed entry at p_at: the entry keeps its id as the left piece, a right piece is inserted on p_right_job / p_right_code. Worked seconds are asserted equal; lunch and miles move whole; rate_override, paid_at and mileage_paid_at are copied (never an override onto an owner); a paid shift keeps its day and rounded hours. A same-job piece inherits the parent''s claim by an appended id; a cross-job cut of a shift a live invoice bills is refused, naming it (detail invoice:<id>).';

-- ── 5. join_time_entries: UNDO, AND "JOIN BACK INTO ONE SHIFT" ──────────────────────────────────
-- The left piece is kept (it is the one that kept the original id when the shift was cut) and
-- widened over the right one; the right piece is deleted.
create or replace function public.join_time_entries(p_left uuid, p_right uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if l.paid_at is distinct from r.paid_at or l.mileage_paid_at is distinct from r.mileage_paid_at then
    raise exception 'One of these is in a paid period and the other is not, so joining them would change what was paid.';
  end if;
  if l.rate_override is distinct from r.rate_override then
    raise exception 'These two are paid at different rates, so joining them would change the pay.';
  end if;

  -- SAME CLAIM HOLDERS, OR NO JOIN. Joining an unbilled piece into a billed one would make hours no
  -- invoice ever billed look billed (and the reverse would hand billed hours back to the importer).
  select coalesce(array_agg(it.id order by it.id), '{}') into v_l_lines
    from public.invoice_items it where it.source_ids && array[l.id];
  select coalesce(array_agg(it.id order by it.id), '{}') into v_r_lines
    from public.invoice_items it where it.source_ids && array[r.id];
  if v_l_lines is distinct from v_r_lines then
    select i.invoice_number, (it.source_ids && array[l.id]) as bills_first
      into v_odd
      from public.invoice_items it
      join public.invoices i on i.id = it.invoice_id
     where it.id = any (v_l_lines || v_r_lines)
       and not (it.id = any (v_l_lines) and it.id = any (v_r_lines))
     order by i.created_at, i.id
     limit 1;
    raise exception '% bills the % part and not the %, so joining them would make unbilled hours look billed.',
      coalesce(v_odd.invoice_number, 'An invoice'),
      case when v_odd.bills_first then 'first' else 'second' end,
      case when v_odd.bills_first then 'second' else 'first' end
      using errcode = 'P0001',
            hint = 'Take the part off ' || coalesce(v_odd.invoice_number, 'that invoice') || ' first, or leave them split.';
  end if;

  v_before := extract(epoch from (l.clock_out - l.clock_in)) - coalesce(l.lunch_minutes, 0) * 60
            + extract(epoch from (r.clock_out - r.clock_in)) - coalesce(r.lunch_minutes, 0) * 60;

  -- The claim leaves with the piece: exactly the absorbed id, from every line (all of which also
  -- hold the kept id, checked above). Then 0261's delete guard has nothing to refuse.
  with released as (
    update public.invoice_items it
       set source_ids = array_remove(it.source_ids, r.id)
      from public.invoices i
     where i.id = it.invoice_id
       and it.source_ids && array[r.id]
    returning i.invoice_number
  )
  select coalesce(jsonb_agg(distinct invoice_number), '[]'::jsonb) into v_released from released;

  update public.time_entries
     set split_from = coalesce(l.split_from, l.id)
   where split_from = r.id;

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
end $$;

revoke execute on function public.join_time_entries(uuid, uuid) from public, anon;
grant execute on function public.join_time_entries(uuid, uuid) to authenticated, service_role;
comment on function public.join_time_entries(uuid, uuid) is
  'Office only (0288). Joins two touching closed pieces of one person back into the left one. Refused unless both have the same claim holders, paid_at, mileage_paid_at and rate_override. Removes exactly the absorbed id from the lines that hold it, deletes it, and widens the kept piece; lunch and miles add. Worked seconds are asserted equal.';

-- ── 6. move_time_entry_cut: SLIDE THE BOUNDARY ──────────────────────────────────────────────────
-- Only the shared boundary moves; the order never changes (a swap would pass through an overlap).
-- Claimed pieces may move: 0261 C7, "hours on a claimed row stay editable; the invoice keeps its
-- figure". The answer names every invoice whose piece changed length, so the office is told.
create or replace function public.move_time_entry_cut(p_left uuid, p_right uuid, p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    if l.paid_at is not null
       and round(greatest(v_l_new - coalesce(l.lunch_minutes, 0) * 60, 0) / 3600.0, 2)
         + round(greatest(v_r_new - coalesce(r.lunch_minutes, 0) * 60, 0) / 3600.0, 2)
         <> round(greatest(extract(epoch from (l.clock_out - l.clock_in)) - coalesce(l.lunch_minutes, 0) * 60, 0) / 3600.0, 2)
          + round(greatest(extract(epoch from (r.clock_out - r.clock_in)) - coalesce(r.lunch_minutes, 0) * 60, 0) / 3600.0, 2) then
      raise exception 'That would change the paid hours by a rounding cent. Move the split time by a minute.';
    end if;
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
end $$;

revoke execute on function public.move_time_entry_cut(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.move_time_entry_cut(uuid, uuid, timestamptz) to authenticated, service_role;
comment on function public.move_time_entry_cut(uuid, uuid, timestamptz) is
  'Office only (0288). Slides the boundary between two touching closed pieces of one person to p_at, never reordering them. Refused across a paid/unpaid or rate difference, off a paid day, or when the paid rounded hours would change. Returns every live invoice billing a piece whose length changed (billed[]).';

-- ── 7. switch_job: THE LIVE BUTTON ──────────────────────────────────────────────────────────────
-- Runs AS THE CALLER (security invoker): RLS and the tech guards judge both writes exactly as they
-- judge a clock-out and a clock-in, which is what this is.
--
--  (a) The running entry has NO job and no code, or started under 2 minutes ago: re-point it and cut
--      nothing. A job-less stretch has always billed to the job you switch to, and a 28-second
--      piece (the Aug 5 artifact) helps nobody.
--  (b) Otherwise close it now, and open the next piece at the same instant on the new job.
create or replace function public.switch_job(p_entry uuid, p_job_id uuid, p_job_code text, p_gps jsonb default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_now    timestamptz := now();
  v_code   text := nullif(btrim(p_job_code), '');
  v_gps    jsonb := case when jsonb_typeof(p_gps) = 'object' then p_gps end;
  e        record;
  v_new    uuid := gen_random_uuid();
  v_staff  boolean := public.is_org_staff();
  v_owner  boolean;
  v_rate   numeric;
  v_n      integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  select t.id, t.profile_id, t.org_id, t.job_id, t.job_code, t.clock_in, t.status, t.rate_override, t.split_from
    into e
    from public.time_entries t
   where t.id = p_entry and t.status = 'open'
   for update;
  if not found then
    raise exception 'No open shift to switch.';
  end if;
  if not (e.profile_id = v_uid or (v_staff and e.org_id = public.auth_org_id())) then
    raise exception 'That is not your shift.';
  end if;

  if p_job_id is null and v_code is null then
    raise exception 'Pick a job or a time code to switch to.';
  end if;
  if p_job_id is not null and not exists (
       select 1 from public.jobs j where j.id = p_job_id and j.org_id = e.org_id) then
    raise exception 'That job isn''t available.';
  end if;
  if p_job_id is not distinct from e.job_id and v_code is not distinct from e.job_code then
    raise exception 'You''re already clocked into that job.';
  end if;

  -- (a) RE-POINT.
  if (e.job_id is null and e.job_code is null) or v_now - e.clock_in < interval '2 minutes' then
    update public.time_entries
       set job_id = p_job_id,
           job_code = v_code,
           gps_in = coalesce(v_gps, gps_in)
     where id = e.id and status = 'open';
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'The switch did not save. Try again.';
    end if;
    return jsonb_build_object('mode', 'repointed', 'entry_id', e.id, 'closed_id', null, 'closed_hours', 0,
                              'rate_left_behind', false);
  end if;

  -- (b) CUT. Close first (one open entry per person), then open the next piece at the same instant.
  update public.time_entries
     set status = 'closed',
         clock_out = v_now,
         gps_out = v_gps
   where id = e.id and status = 'open';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'The switch did not save. Try again.';
  end if;

  -- The pay rate travels only when the office switches: a tech's own insert may not carry one
  -- (0154), and an owner's shift never has one (0286). The answer says when it stayed behind.
  v_owner := exists (select 1 from public.profiles pr where pr.id = e.profile_id and pr.role = 'owner');
  v_rate := case when v_staff and not v_owner then e.rate_override end;

  insert into public.time_entries (
    id, profile_id, org_id, job_id, job_code, clock_in, status, source, gps_in, rate_override,
    split_from, split_how)
  values (
    v_new, e.profile_id, e.org_id, p_job_id, v_code, v_now, 'open', 'app', v_gps, v_rate,
    coalesce(e.split_from, e.id), 'live');

  return jsonb_build_object(
    'mode', 'cut',
    'entry_id', v_new,
    'closed_id', e.id,
    'closed_hours', round(extract(epoch from (v_now - e.clock_in)) / 3600.0, 2),
    'rate_left_behind', e.rate_override is not null and v_rate is null and not v_owner);
end $$;

revoke execute on function public.switch_job(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.switch_job(uuid, uuid, text, jsonb) to authenticated, service_role;
comment on function public.switch_job(uuid, uuid, text, jsonb) is
  'Switch Job (0288), security invoker. A running entry with no job and no code, or under 2 minutes old, is re-pointed to the new job (mode repointed). Otherwise it is closed now with gps_out and a new open entry starts at the same instant with gps_in, source app, split_how live (mode cut, entry_id = the new open entry). The running note stays on the closed piece; miles are never divided.';

-- ── 8. THE OLD TABLE, UNTIL 0289 EMPTIES IT ────────────────────────────────────────────────────
-- 0154's guard returned early for staff and server writers, so a staff INSERT could add hours the
-- clock never saw: the Jul 14 J-011 row (created 07-24 20:00, 51 minutes after the J-033
-- row, 5.5 h shift, 6.5 h of rows once it landed). The ceiling now holds for every INSERT.
-- Per-row UPDATE by staff stays exempt on purpose: updateTimeEntry trims rows in place one at a
-- time, and a 4 + 4 split on a 6 h shift passes through 3 + 4 on the way down.
-- Body otherwise unchanged from 0154.
create or replace function public.guard_time_allocation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ent           record;
  worked_hours  numeric;
  other_hours   numeric;
  this_hours    numeric;
begin
  if public.is_org_staff() or public.is_privileged_writer() then
    if tg_op <> 'INSERT' then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    -- 0288: the no-over-bill ceiling holds for EVERY insert.
    select clock_in, clock_out, lunch_minutes into ent
      from public.time_entries where id = new.time_entry_id;
    if found and ent.clock_out is not null then
      worked_hours := extract(epoch from (ent.clock_out - ent.clock_in)) / 3600.0
                      - coalesce(ent.lunch_minutes, 0) / 60.0;
      select coalesce(sum(hours), 0) into other_hours
        from public.time_allocations where time_entry_id = new.time_entry_id;
      if other_hours + coalesce(new.hours, 0) > worked_hours + 0.01 then
        raise exception 'That split adds up to more hours than the shift worked.';
      end if;
    end if;
    return new;
  end if;

  select clock_in, clock_out, lunch_minutes, paid_at, mileage_paid_at, status
    into ent
    from public.time_entries
   where id = coalesce(new.time_entry_id, old.time_entry_id);
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if ent.paid_at is not null or ent.mileage_paid_at is not null then
    raise exception 'That shift is in a paid period — ask the office to undo it on Payroll first.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if coalesce(new.hours, 0) < 0 then
    raise exception 'Allocated hours cannot be negative.';
  end if;

  if ent.clock_out is not null then
    worked_hours := extract(epoch from (ent.clock_out - ent.clock_in)) / 3600.0
                    - coalesce(ent.lunch_minutes, 0) / 60.0;
    select coalesce(sum(hours), 0) into other_hours
      from public.time_allocations
     where time_entry_id = new.time_entry_id
       and (tg_op = 'INSERT' or id <> new.id);
    this_hours := coalesce(new.hours, 0);
    if other_hours + this_hours > worked_hours + 0.01 then
      raise exception 'That split adds up to more hours than the shift worked.';
    end if;
  end if;
  return new;
end $$;

comment on function public.guard_time_allocation() is
  'Write guard on time_allocations (0154; 0288 made the worked-hours ceiling hold for staff and server INSERTs too). A settled shift''s split is frozen for non-staff, hours are non-negative, and a split may never exceed the entry''s worked hours. Frozen outright by 0289.';

-- ── PROVE IT (by hand; everything rolls back) ───────────────────────────────────────────────────
--   begin;
--     select set_config('request.jwt.claims', json_build_object('sub', '<office profile>', 'role', 'authenticated')::text, true);
--     select public.split_time_entry('<a closed unbilled entry>', '<a time inside it>', '<another job>', null);
--     -- -> {"left_id": ..., "right_id": ..., "carried": []}
--     select public.join_time_entries('<left_id>', '<right_id>');   -- -> back to one entry
--     update public.time_entries set job_id = '<another job>' where id = '<an entry a live invoice claims>';
--     -- -> ERROR: INV-0xx already bills this shift on <job>
--   rollback;
