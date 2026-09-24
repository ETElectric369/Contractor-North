-- 0289 - THE OLD SPLITS BECOME ORDINARY ENTRIES, AND THE OLD TABLE STOPS TAKING ROWS.
--
-- ORDER: after 0288 (split_from / split_how, the job guard, split_time_entry). Apply while nobody is
-- clocked in, then deploy the code that no longer reads time_allocations. Everything below is ONE
-- transaction (scripts/run-one-migration.mjs wraps the file): any failed proof rolls ALL of it back,
-- the conversion, the deletes and the freeze together.
--
-- WHAT IT DOES
--   1. archive.time_allocations: a copy of every old row, in a schema PostgREST does not expose (a
--      new public table would get the anon/authenticated default grants).
--   2. carve_legacy_allocations(p_dry, p_entry_ids, p_order): turns an old split into touching time
--      entries. The scoped form (p_entry_ids given) never TRUNCATEs, so CI, which runs against the
--      production database, never takes an ACCESS EXCLUSIVE lock on the live table.
--   3. THE REAL RUN, with Erik's answers (2026-09-24) as the order, every proof raising on failure.
--   4. Two empty job-less punches deleted, each only if it is still what Erik saw.
--   5. The freeze: time_allocations refuses every INSERT; replace_time_allocations says why.
--
-- HOW AN OLD SPLIT IS CARVED
--   * Rows with the same resolved job/code and the same claim holders merge when they sit next to
--     each other. An unlabeled row (no job, no code) resolves to the entry's own job and code; a
--     code-only row (Drive, Shop...) stays job-less, because that is what it was: paid, not billed.
--   * HOME is the group on the entry's own job. It keeps the entry id, its lunch, miles, notes and
--     locks, and its span is widened by the lunch. Every other group becomes a new entry whose id IS
--     the allocation's uuid, so every invoice line that already bills that row keeps billing the
--     same hours with no invoice write at all.
--   * Groups are laid end to end from clock_in, in Erik's order where he gave one and the old
--     sort_order otherwise, each as long as its recorded hours; home takes whatever the clock says
--     is left. The recorded rows are the only record of where the time went (they drive today's job
--     cost). They are not what customers paid for: INV-051 bills a flat 1 x $150 against 3.8 h, and
--     INV-048's labor line was hand-set to 26 h against about 43 h claimed.
--   * No home group: if the rows cover the clock to within a minute, the last group takes the entry
--     id (its job and code with it); otherwise the uncovered time stays on the entry's job as home.
--   * Zero-hour rows carve nothing; they are archived.
--   * An UNCLAIMED, UNPAID split whose rows add up to more than the clock is carved with the clock as
--     the ceiling (the last non-home piece gives way, as the C7 trim does). A claimed or paid one
--     that disagrees with its clock by more than 36 s (0.01 h) stops the whole run, naming it.
--   * Claims: for each home row, the entry id is appended to every draft or void line holding it
--     (void too, so an un-void can never double-bill); the retired row ids come off DRAFT lines
--     only. Sent and paid lines are never written.
--
-- THE PROOFS (each raises, and a raise here rolls back the entire migration)
--   * per entry, and per person per org-local day per rate/paid lock: worked SECONDS identical;
--   * a paid shift keeps its day and its rounded hours (hoursBetween rounds each entry to 0.01 h);
--   * every sent/paid invoice line hashes identically (id, invoice, quantity, unit price,
--     description, source ids);
--   * per job and person, the hours labor billing would bill match the old rules within 0.01 h per
--     piece;
--   * every retired row id a live line still holds either became an entry, or sits on a line that
--     also holds the entry that took its hours;
--   * and for ET, the exact result Erik approved (below), including that exactly ONE invoice line
--     changes: draft INV-078 line 72c2c363, whose 50.5 h quantity does not.

-- ── 1. THE ARCHIVE ──────────────────────────────────────────────────────────────────────────────
create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated, service_role;

create table if not exists archive.time_allocations (
  id            uuid primary key,
  time_entry_id uuid not null,
  org_id        uuid,
  job_id        uuid,
  job_code      text,
  hours         numeric(6,2) not null,
  description   text,
  sort_order    integer not null,
  created_at    timestamptz not null,
  archived_at   timestamptz not null default now(),
  -- The time entry that carries these hours now: the row's own id when it became an entry, the
  -- entry it was merged into otherwise; null for a 0 h row whose entry this migration deleted
  -- (the two empty punches, section 5).
  became        uuid,
  -- piece | merged | home | absorbed | trimmed | zero | zero, entry deleted (see carve_legacy_allocations)
  carve_note    text
);
alter table archive.time_allocations enable row level security;
revoke all on archive.time_allocations from public, anon, authenticated, service_role;
comment on table archive.time_allocations is
  'Every time_allocations row as it stood when 0289 converted the old splits into ordinary time entries. Not exposed to PostgREST. became = the time entry that carries its hours now (null when that entry was an empty punch 0289 deleted).';

-- ── 2. THE CARVE MAY REMOVE A CLAIMED ROW (ONLY THE CARVE) ──────────────────────────────────────
-- 0261/0263's guard, unchanged but for one door: the scoped carve deletes the rows it has just
-- turned into entries, and a row a paid line still names (its hours now on the entry that line
-- also names) must be allowed to go. cn.carving is set transaction-locally by
-- carve_legacy_allocations alone, which no client can execute; the real run TRUNCATEs instead,
-- which fires no row trigger.
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
  if tg_op = 'DELETE' and coalesce(current_setting('cn.carving', true), '') = 'on' then
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.time_entry_id is not distinct from old.time_entry_id
       and new.job_id is not distinct from old.job_id then
      return new;
    end if;
    if new.time_entry_id is not distinct from old.time_entry_id
       and new.job_id is null
       and old.job_id is not null
       and not exists (select 1 from public.jobs j where j.id = old.job_id) then
      return new;
    end if;
    v_verb := case
      when new.time_entry_id is distinct from old.time_entry_id then 'moving them to another shift'
      when new.job_id is null then 'taking them off the job'
      else 'moving them to another job'
    end;
  else
    v_verb := 'removing them from the split';
  end if;

  v_holder := public.invoice_holding_claim(array[old.id], old.org_id);
  if v_holder is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception '% already bills these hours', v_holder
    using errcode = 'P0001',
          hint = 'Void or adjust ' || v_holder || ' before ' || v_verb || '. Nothing was changed.';
end $$;

-- ── 3. carve_legacy_allocations ─────────────────────────────────────────────────────────────────
-- p_dry      true: do everything, prove everything, report, then roll it all back.
-- p_entry_ids null: every entry that has rows (the real run; the old table is TRUNCATEd).
--            given: only those entries (tests; their rows are DELETEd, never a TRUNCATE).
-- p_order    {"<entry id>": ["<allocation id>", ...]}: the order the rows' time was worked in.
--            Rows it does not list follow, in their old sort_order.
create or replace function public.carve_legacy_allocations(
  p_dry       boolean,
  p_entry_ids uuid[] default null,
  p_order     jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_global   boolean := p_entry_ids is null;
  v_report   jsonb;
  ent        record;
  rrow       record;
  seg        record;
  v_bad      record;
  v_k        text;
  v_v        jsonb;
  v_sum      numeric;
  v_claimed  boolean;
  v_paid     boolean;
  v_segno    integer;
  v_key      text;
  v_prev     text;
  v_home     integer;
  v_absorbs  boolean;
  v_rem      numeric;
  v_nonhome  numeric;
  v_deficit  numeric;
  v_cut      numeric;
  v_t        timestamptz;
  v_span     numeric;
  v_first    integer;
  v_last     integer;
  v_n        integer;
  v_scope    integer;
begin
  begin -- everything inside this block is undone by a dry run
    if v_global then
      -- Nobody adds a row while the table is being carved and emptied.
      lock table public.time_allocations in exclusive mode;
    end if;

    perform 1
       from public.time_entries te
      where te.id in (select a.time_entry_id from public.time_allocations a
                       where v_global or a.time_entry_id = any (p_entry_ids))
      order by te.id
        for update;

    drop table if exists _carve_e, _carve_r, _carve_s, _carve_map, _carve_pay_before, _carve_pay_after,
                         _carve_lines_before, _carve_lw, _carve_bill_before;

    create temp table _carve_e on commit drop as
    select te.*,
           extract(epoch from (te.clock_out - te.clock_in)) - coalesce(te.lunch_minutes, 0) * 60 as worked_s,
           public.split_org_tz(te.org_id) as tz,
           exists (select 1 from public.profiles pr where pr.id = te.profile_id and pr.role = 'owner') as is_owner
      from public.time_entries te
     where te.id in (select a.time_entry_id from public.time_allocations a
                      where v_global or a.time_entry_id = any (p_entry_ids));
    select count(*) into v_scope from _carve_e;

    -- ── p_order is Erik's word; a wrong id in it is a stop, not a guess ──
    if p_order is not null then
      if jsonb_typeof(p_order) <> 'object' then
        raise exception 'carve: p_order must be {"<entry id>": ["<allocation id>", ...]}';
      end if;
      for v_k, v_v in select key, value from jsonb_each(p_order) loop
        if not exists (select 1 from _carve_e where id::text = v_k) then
          raise exception 'carve: p_order names entry %, which has no old-style split in this run', v_k;
        end if;
        if jsonb_typeof(v_v) <> 'array' then
          raise exception 'carve: p_order for entry % must be a list of allocation ids', v_k;
        end if;
        if exists (select 1 from jsonb_array_elements_text(v_v) x
                    where not exists (select 1 from public.time_allocations a
                                       where a.id::text = x and a.time_entry_id::text = v_k)) then
          raise exception 'carve: p_order for entry % names a row that is not on that entry', v_k;
        end if;
      end loop;
    end if;

    -- ── the rows, resolved ──
    create temp table _carve_r on commit drop as
    select a.id as alloc_id, a.time_entry_id as entry_id, e.org_id, a.job_id as a_job, a.job_code as a_code,
           a.hours, a.description, a.sort_order, a.created_at,
           case when a.job_id is null and a.job_code is null then e.job_id else a.job_id end as rjob,
           case when a.job_id is null and a.job_code is null then e.job_code else a.job_code end as rcode,
           round(coalesce(a.hours, 0) * 3600) as secs,
           coalesce((select array_agg(it.id order by it.id) from public.invoice_items it
                      where it.source_ids && array[a.id]), '{}'::uuid[]) as holders,
           coalesce(o.pos, 1000000 + row_number() over (partition by a.time_entry_id
                                                        order by a.sort_order, a.created_at, a.id)) as seq,
           null::integer as segno
      from public.time_allocations a
      join _carve_e e on e.id = a.time_entry_id
      left join lateral (
        select x.ord as pos
          from jsonb_array_elements_text(coalesce(p_order -> a.time_entry_id::text, '[]'::jsonb)) with ordinality as x(val, ord)
         where x.val = a.id::text
         limit 1
      ) o on true;

    -- ── pre-flight: anything we cannot carve honestly stops the whole run ──
    for ent in select * from _carve_e order by clock_in, id loop
      if ent.status <> 'closed' or ent.clock_out is null then
        raise exception 'carve: entry % is still open, so its split cannot be carved. Close it first; nothing was changed.', ent.id;
      end if;

      select t.id, t.clock_in, t.clock_out into v_bad
        from public.time_entries t
       where t.profile_id = ent.profile_id
         and t.id <> ent.id
         and t.clock_in < ent.clock_out
         and ent.clock_in < coalesce(t.clock_out, now())
         and least(coalesce(t.clock_out, now()), ent.clock_out) - greatest(t.clock_in, ent.clock_in) > interval '1 minute'
       limit 1;
      if found then
        raise exception 'carve: entry % overlaps entry % by more than a minute. Fix the overlap first; nothing was changed.', ent.id, v_bad.id;
      end if;

      if ent.is_owner and coalesce(ent.rate_override, 0) > 0 then
        raise exception 'carve: entry % is an owner''s shift carrying a pay rate (0286 refuses one on a new piece). Clear it first; nothing was changed.', ent.id;
      end if;

      select coalesce(sum(secs), 0) into v_sum from _carve_r where entry_id = ent.id;
      v_claimed := exists (
        select 1 from public.invoice_items it join public.invoices i on i.id = it.invoice_id
         where i.status <> 'void'
           and it.source_ids && (array[ent.id] || coalesce((select array_agg(alloc_id) from _carve_r where entry_id = ent.id), '{}'::uuid[])));
      v_paid := ent.paid_at is not null or ent.mileage_paid_at is not null;
      if (v_claimed or v_paid) and abs(v_sum - ent.worked_s) > 36 then
        raise exception 'carve: entry % worked % h but its split rows total % h, and it is %. Fix the rows by hand first; nothing was changed.',
          ent.id, round(ent.worked_s / 3600.0, 4), round(v_sum / 3600.0, 4),
          case when v_claimed and v_paid then 'billed and paid' when v_paid then 'paid' else 'billed' end;
      end if;
    end loop;

    -- ── group neighbouring rows that are the same job/code with the same claim holders ──
    for ent in select id from _carve_e loop
      v_segno := 0;
      v_prev := null;
      for rrow in select * from _carve_r where entry_id = ent.id and secs > 0 order by seq, alloc_id loop
        v_key := coalesce(rrow.rjob::text, '-') || '|' || coalesce(rrow.rcode, '-') || '|' || rrow.holders::text;
        if v_prev is null or v_key <> v_prev then
          v_segno := v_segno + 1;
        end if;
        v_prev := v_key;
        update _carve_r set segno = v_segno where alloc_id = rrow.alloc_id;
      end loop;
    end loop;

    create temp table _carve_s on commit drop as
    select entry_id, segno, rjob, rcode, holders,
           sum(secs) as secs,
           array_agg(alloc_id order by seq, alloc_id) as alloc_ids,
           (array_agg(alloc_id order by seq, alloc_id))[1] as first_alloc,
           false as is_home, false as absorbs, false as is_virtual, false as dropped, 0::numeric as trimmed,
           null::timestamptz as start_at, null::timestamptz as end_at
      from _carve_r
     where segno is not null
     group by entry_id, segno, rjob, rcode, holders;

    -- ── home, seconds, layout ──
    for ent in select * from _carve_e order by clock_in, id loop
      if not exists (select 1 from _carve_s where entry_id = ent.id) then
        continue; -- only zero-hour rows: nothing to carve
      end if;

      v_home := null;
      v_absorbs := false;
      select s.segno into v_home
        from _carve_s s
       where s.entry_id = ent.id
         and s.rjob is not distinct from ent.job_id
         and (ent.job_id is not null or s.rcode is not distinct from ent.job_code)
       order by (s.rcode is not distinct from ent.job_code) desc, s.segno
       limit 1;

      if v_home is null then
        select ent.worked_s - coalesce(sum(s.secs), 0) into v_rem from _carve_s s where s.entry_id = ent.id;
        if v_rem > 60 then
          -- The rows leave real time uncovered: it stays on the entry's own job, after them.
          insert into _carve_s (entry_id, segno, rjob, rcode, holders, secs, alloc_ids, first_alloc,
                                is_home, absorbs, is_virtual, dropped, trimmed)
          select ent.id, max(segno) + 1, ent.job_id, ent.job_code, '{}'::uuid[], 0, '{}'::uuid[], null,
                 true, false, true, false, 0
            from _carve_s where entry_id = ent.id;
        else
          -- The rows cover the clock: the last group takes the entry id, its job and code with it.
          select max(segno) into v_home from _carve_s where entry_id = ent.id;
          v_absorbs := true;
        end if;
      end if;
      if v_home is not null then
        update _carve_s set is_home = true, absorbs = v_absorbs where entry_id = ent.id and segno = v_home;
      end if;

      -- Home is whatever the clock says is left once the other pieces have their recorded hours.
      -- Rows over the clock by more than the 36 s rounding slack (only ever unclaimed and unpaid by
      -- here: pre-flight stopped the others) give the excess back from the LAST non-home piece
      -- first, the C7 trim; within the slack, home simply absorbs it.
      select coalesce(sum(secs), 0) into v_nonhome from _carve_s where entry_id = ent.id and not is_home;
      select coalesce(sum(secs), 0) into v_sum from _carve_r where entry_id = ent.id;
      v_deficit := greatest(
        case when v_sum > ent.worked_s + 36 then v_sum - ent.worked_s else 0 end,
        v_nonhome - greatest(ent.worked_s, 0),
        0);
      if v_deficit > 0 and v_nonhome > 0 then
        v_claimed := exists (
          select 1 from public.invoice_items it join public.invoices i on i.id = it.invoice_id
           where i.status <> 'void'
             and it.source_ids && (array[ent.id] || coalesce((select array_agg(alloc_id) from _carve_r where entry_id = ent.id), '{}'::uuid[])));
        if v_claimed or ent.paid_at is not null or ent.mileage_paid_at is not null then
          raise exception 'carve: entry % would need its split trimmed to fit the clock, and it is billed or paid. Fix the rows by hand first; nothing was changed.', ent.id;
        end if;
        for seg in select * from _carve_s where entry_id = ent.id and not is_home order by segno desc loop
          exit when v_deficit <= 0;
          v_cut := least(seg.secs, v_deficit);
          update _carve_s
             set secs = secs - v_cut, trimmed = trimmed + v_cut, dropped = (secs - v_cut) <= 0
           where entry_id = ent.id and segno = seg.segno;
          v_deficit := v_deficit - v_cut;
        end loop;
      end if;
      update _carve_s s
         set secs = ent.worked_s - coalesce((select sum(x.secs) from _carve_s x
                                            where x.entry_id = ent.id and not x.is_home and not x.dropped), 0)
       where s.entry_id = ent.id and s.is_home;

      -- End to end from clock_in. The last piece ends exactly at clock_out.
      select min(segno), max(segno) into v_first, v_last from _carve_s where entry_id = ent.id and not dropped;
      v_t := ent.clock_in;
      for seg in select * from _carve_s where entry_id = ent.id and not dropped order by segno loop
        v_span := seg.secs + case when seg.is_home then greatest(coalesce(ent.lunch_minutes, 0), 0) * 60 else 0 end;
        update _carve_s
           set start_at = v_t,
               end_at = case when seg.segno = v_last then ent.clock_out
                             else v_t + make_interval(secs => v_span::double precision) end
         where entry_id = ent.id and segno = seg.segno;
        select end_at into v_t from _carve_s where entry_id = ent.id and segno = seg.segno;
      end loop;

      if exists (select 1 from _carve_s where entry_id = ent.id and not dropped and end_at < start_at) then
        raise exception 'carve: entry % lays out a piece that ends before it starts. Nothing was changed.', ent.id;
      end if;

      -- A PAID shift keeps its day and its rounded hours.
      if ent.paid_at is not null or ent.mileage_paid_at is not null then
        if exists (select 1 from _carve_s s where s.entry_id = ent.id and not s.dropped
                      and (s.start_at at time zone ent.tz)::date <> (ent.clock_in at time zone ent.tz)::date) then
          raise exception 'carve: entry % is paid, and a piece of it would land on another day. Nothing was changed.', ent.id;
        end if;
      end if;
      if ent.paid_at is not null then
        if (select sum(round(greatest(extract(epoch from (s.end_at - s.start_at))
                                      - case when s.is_home then coalesce(ent.lunch_minutes, 0) * 60 else 0 end, 0) / 3600.0, 2))
              from _carve_s s where s.entry_id = ent.id and not s.dropped)
           <> round(greatest(ent.worked_s, 0) / 3600.0, 2) then
          raise exception 'carve: entry % is paid, and its pieces would round to different paid hours. Nothing was changed.', ent.id;
        end if;
      end if;
    end loop;

    -- ── where each old row's hours live now ──
    create temp table _carve_map on commit drop as
    select r.alloc_id, r.entry_id,
           case
             when r.segno is null then r.entry_id
             when s.is_home then r.entry_id
             when s.dropped then r.entry_id
             else s.first_alloc
           end as absorber,
           case
             when r.segno is null then 'zero'
             when s.is_home and s.absorbs then 'absorbed'
             when s.is_home then 'home'
             when s.dropped then 'trimmed'
             when r.alloc_id = s.first_alloc then 'piece'
             else 'merged'
           end as note
      from _carve_r r
      left join _carve_s s on s.entry_id = r.entry_id and s.segno = r.segno;

    -- ── snapshots, before a single write ──
    create temp table _carve_pay_before on commit drop as
    select t.profile_id, (t.clock_in at time zone public.split_org_tz(t.org_id))::date as day,
           t.rate_override, t.paid_at, t.mileage_paid_at,
           sum(extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60) as secs,
           sum(t.miles) as miles
      from public.time_entries t
     where t.profile_id in (select profile_id from _carve_e)
       and t.clock_out is not null
     group by 1, 2, 3, 4, 5;

    create temp table _carve_lines_before on commit drop as
    select it.id, it.invoice_id, i.invoice_number, i.status::text as status,
           md5(concat_ws('|', it.invoice_id::text, it.quantity::text, it.unit_price::text, it.description,
                         it.source_ids::text)) as h,
           it.source_ids
      from public.invoice_items it
      join public.invoices i on i.id = it.invoice_id
     where i.org_id in (select org_id from _carve_e);

    -- What labor billing would bill off these entries under the OLD rules (labor-billing.ts):
    -- (1) a row on a job, unless its code is non-billable; (2) an unlabeled row, on the entry's job;
    -- a code-only row never. Less whatever the C7 trim above gave back to the clock: that is the one
    -- change to billable hours this run makes on purpose (an unclaimed over-split billed hours the
    -- clock never saw), and the proof must not mistake it for a layout error.
    create temp table _carve_bill_before on commit drop as
    select job_id, profile_id, sum(hours) as hours
      from (
        select case when r.a_job is not null then r.a_job else e.job_id end as job_id, e.profile_id, r.hours
          from _carve_r r
          join _carve_e e on e.id = r.entry_id
         where r.hours > 0
           and (r.a_job is not null or r.a_code is null)
           and (case when r.a_job is not null then r.a_job else e.job_id end) is not null
           and not (r.a_job is not null and r.a_code is not null and exists (
                 select 1 from public.job_codes jc
                  where jc.org_id = e.org_id and jc.code = btrim(r.a_code) and jc.billable = false))
        union all
        select s.rjob, e.profile_id, -(s.trimmed / 3600.0)
          from _carve_s s
          join _carve_e e on e.id = s.entry_id
         where s.trimmed > 0
           and s.rjob is not null
           and not (s.rcode is not null and exists (
                 select 1 from public.job_codes jc
                  where jc.org_id = e.org_id and jc.code = btrim(s.rcode) and jc.billable = false))
      ) x
     group by job_id, profile_id;

    -- ── writes: shorten each parent to its home piece, then insert the others ──
    for ent in select * from _carve_e order by clock_in, id loop
      select * into seg from _carve_s where entry_id = ent.id and is_home and not dropped;
      if found then
        select min(segno) into v_first from _carve_s where entry_id = ent.id and not dropped;
        update public.time_entries t
           set clock_in = seg.start_at,
               clock_out = seg.end_at,
               job_id = case when seg.absorbs then seg.rjob else t.job_id end,
               job_code = case when seg.absorbs then seg.rcode else t.job_code end,
               gps_in = case when seg.segno = v_first then t.gps_in end,
               gps_out = case when seg.end_at = ent.clock_out then t.gps_out end,
               auto_closed_reason = case when seg.end_at = ent.clock_out or seg.end_at - seg.start_at > interval '18 hours'
                                         then t.auto_closed_reason end,
               -- NOTHING SILENT: an entry whose rows covered its clock takes the last row's job or
               -- code, and no piece is inserted, so no "Rebuilt From An Old Split" label can say so.
               -- The notes do, in the words the timecard shows.
               notes = case
                         when seg.absorbs
                              and (seg.rjob is distinct from t.job_id or seg.rcode is distinct from t.job_code)
                         then concat_ws(E'\n', nullif(btrim(t.notes), ''),
                                '[Rebuilt from an old split: this time was recorded on '
                                || public.split_job_label(seg.rjob, seg.rcode)
                                || case when t.job_id is null and nullif(btrim(t.job_code), '') is null
                                        then ', and the shift had no job before.]'
                                        else ', not ' || public.split_job_label(t.job_id, t.job_code) || '.]' end)
                         else t.notes
                       end
         where t.id = ent.id
           and (t.clock_in, t.clock_out, t.job_id, t.job_code)
               is distinct from (seg.start_at, seg.end_at,
                                 case when seg.absorbs then seg.rjob else t.job_id end,
                                 case when seg.absorbs then seg.rcode else t.job_code end);
      end if;

      select min(segno) into v_first from _carve_s where entry_id = ent.id and not dropped;
      insert into public.time_entries (
        id, profile_id, org_id, job_id, job_code, clock_in, clock_out, lunch_minutes, miles,
        gps_in, gps_out, notes, status, source, rate_override, paid_at, mileage_paid_at,
        auto_closed_reason, split_from, split_how)
      select s.first_alloc, ent.profile_id, ent.org_id, s.rjob, s.rcode, s.start_at, s.end_at, 0, 0,
             case when s.segno = v_first then ent.gps_in end,
             case when s.end_at = ent.clock_out then ent.gps_out end,
             null, 'closed', ent.source,
             case when ent.is_owner then null else ent.rate_override end,
             ent.paid_at, ent.mileage_paid_at,
             case when s.end_at = ent.clock_out or s.end_at - s.start_at > interval '18 hours' then ent.auto_closed_reason end,
             coalesce(ent.split_from, ent.id), 'converted'
        from _carve_s s
       where s.entry_id = ent.id and not s.is_home and not s.dropped
       order by s.segno;
    end loop;

    -- ── claims: follow the hours ──
    create temp table _carve_lw on commit drop as
    with retired as (
      select alloc_id, absorber from _carve_map where absorber <> alloc_id
    ),
    need as (
      select b.id as line_id, b.invoice_number, b.status, it.source_ids,
             coalesce((select array_agg(distinct r.absorber) from retired r
                        where r.alloc_id = any (it.source_ids)
                          and not (r.absorber = any (it.source_ids))), '{}'::uuid[]) as adds,
             coalesce((select array_agg(r.alloc_id) from retired r
                        where r.alloc_id = any (it.source_ids)), '{}'::uuid[]) as orphans
        from _carve_lines_before b
        join public.invoice_items it on it.id = b.id
       where it.source_ids && (select coalesce(array_agg(alloc_id), '{}'::uuid[]) from retired)
    )
    select line_id, invoice_number, status,
           case when status in ('draft', 'void') then adds else '{}'::uuid[] end as added,
           case when status = 'draft' then orphans else '{}'::uuid[] end as removed
      from need;

    -- VOID LINES FIRST, THEN THE REST, in two statements: guard_invoice_item_claim runs per row and
    -- sees what this command already wrote, so in one statement a void line reached after a draft
    -- line would find the draft already holding the id and refuse, on row order alone.
    update public.invoice_items it
       set source_ids = coalesce((select array_agg(u.s order by u.o)
                                    from unnest(it.source_ids) with ordinality as u(s, o)
                                   where not (u.s = any (w.removed))), '{}'::uuid[])
                        || w.added
      from _carve_lw w
     where it.id = w.line_id
       and w.status = 'void'
       and (cardinality(w.added) > 0 or cardinality(w.removed) > 0);
    update public.invoice_items it
       set source_ids = coalesce((select array_agg(u.s order by u.o)
                                    from unnest(it.source_ids) with ordinality as u(s, o)
                                   where not (u.s = any (w.removed))), '{}'::uuid[])
                        || w.added
      from _carve_lw w
     where it.id = w.line_id
       and w.status <> 'void'
       and (cardinality(w.added) > 0 or cardinality(w.removed) > 0);

    -- ── the old rows: archived, then gone ──
    insert into archive.time_allocations (id, time_entry_id, org_id, job_id, job_code, hours, description,
                                          sort_order, created_at, became, carve_note)
    select a.id, a.time_entry_id, a.org_id, a.job_id, a.job_code, a.hours, a.description,
           a.sort_order, a.created_at, m.absorber, m.note
      from public.time_allocations a
      join _carve_map m on m.alloc_id = a.id;
    get diagnostics v_n = row_count;
    if v_n <> (select count(*) from _carve_r) then
      raise exception 'carve: archived % rows but carved %. Nothing was changed.', v_n, (select count(*) from _carve_r);
    end if;

    if v_global then
      if (select count(*) from public.time_allocations) <> v_n then
        raise exception 'carve: time_allocations holds rows this run did not carve. Nothing was changed.';
      end if;
      truncate table public.time_allocations;
    else
      perform set_config('cn.carving', 'on', true);
      delete from public.time_allocations where time_entry_id in (select id from _carve_e);
      perform set_config('cn.carving', '', true);
    end if;
    if exists (select 1 from public.time_allocations a where a.time_entry_id in (select id from _carve_e)) then
      raise exception 'carve: rows are still on a carved entry. Nothing was changed.';
    end if;

    -- ── PROOFS ──
    -- (a) per entry: the pieces are the shift, to the second.
    select e.id, e.worked_s,
           (select sum(extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60)
              from public.time_entries t
             where t.id = e.id
                or t.id in (select s.first_alloc from _carve_s s
                             where s.entry_id = e.id and not s.is_home and not s.dropped)) as after_s
      into v_bad
      from _carve_e e
     where e.worked_s is distinct from
           (select sum(extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60)
              from public.time_entries t
             where t.id = e.id
                or t.id in (select s.first_alloc from _carve_s s
                             where s.entry_id = e.id and not s.is_home and not s.dropped))
     limit 1;
    if found then
      raise exception 'carve proof: entry % worked % s before and % s after. Nothing was changed.', v_bad.id, v_bad.worked_s, v_bad.after_s;
    end if;

    -- (b) pay: per person, per org-local day, per rate and lock: the same seconds and miles.
    create temp table _carve_pay_after on commit drop as
    select t.profile_id, (t.clock_in at time zone public.split_org_tz(t.org_id))::date as day,
           t.rate_override, t.paid_at, t.mileage_paid_at,
           sum(extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60) as secs,
           sum(t.miles) as miles
      from public.time_entries t
     where t.profile_id in (select profile_id from _carve_e)
       and t.clock_out is not null
     group by 1, 2, 3, 4, 5;
    select coalesce(b.profile_id, a.profile_id) as profile_id, coalesce(b.day, a.day) as day,
           b.secs as before_s, a.secs as after_s
      into v_bad
      from _carve_pay_before b
      full join _carve_pay_after a
        on a.profile_id = b.profile_id and a.day = b.day
       and a.rate_override is not distinct from b.rate_override
       and a.paid_at is not distinct from b.paid_at
       and a.mileage_paid_at is not distinct from b.mileage_paid_at
     where a.secs is distinct from b.secs or a.miles is distinct from b.miles
     limit 1;
    if found then
      raise exception 'carve proof: pay for person % on % moved (% s before, % s after). Nothing was changed.',
        v_bad.profile_id, v_bad.day, v_bad.before_s, v_bad.after_s;
    end if;

    -- (c) no sent or paid line moved by a byte.
    select b.invoice_number, b.id into v_bad
      from _carve_lines_before b
      left join public.invoice_items it on it.id = b.id
     where b.status not in ('draft', 'void')
       and (it.id is null
            or md5(concat_ws('|', it.invoice_id::text, it.quantity::text, it.unit_price::text, it.description,
                             it.source_ids::text)) <> b.h)
     limit 1;
    if found then
      raise exception 'carve proof: % line % changed, and it is not a draft. Nothing was changed.', v_bad.invoice_number, v_bad.id;
    end if;

    -- (d) what labor billing would bill, per job and person, within 0.01 h per piece.
    select coalesce(b.job_id, a.job_id) as job_id, coalesce(b.profile_id, a.profile_id) as profile_id,
           b.hours as before_h, a.hours as after_h
      into v_bad
      from _carve_bill_before b
      full join (
        select t.job_id, t.profile_id,
               sum(greatest(extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60, 0) / 3600.0) as hours,
               count(*) as pieces
          from public.time_entries t
         where (t.id in (select id from _carve_e)
                or t.id in (select s.first_alloc from _carve_s s where not s.is_home and not s.dropped))
           and t.job_id is not null
           and not (t.job_code is not null and exists (
                 select 1 from public.job_codes jc
                  where jc.org_id = t.org_id and jc.code = btrim(t.job_code) and jc.billable = false))
         group by t.job_id, t.profile_id
      ) a on a.job_id = b.job_id and a.profile_id = b.profile_id
     where abs(coalesce(a.hours, 0) - coalesce(b.hours, 0)) > 0.01 * greatest(coalesce(a.pieces, 0), 1)
     limit 1;
    if found then
      raise exception 'carve proof: billable hours on job % for person % would move from % to %. Nothing was changed.',
        v_bad.job_id, v_bad.profile_id, round(coalesce(v_bad.before_h, 0), 4), round(coalesce(v_bad.after_h, 0), 4);
    end if;

    -- (e) every retired row id a live line still holds is covered by the entry that took its hours.
    select m.alloc_id, i.invoice_number into v_bad
      from _carve_map m
      join public.invoice_items it on it.source_ids && array[m.alloc_id]
      join public.invoices i on i.id = it.invoice_id and i.status <> 'void'
     where not exists (select 1 from public.time_entries t where t.id = m.alloc_id)
       and not (m.absorber = any (it.source_ids))
     limit 1;
    if found then
      raise exception 'carve proof: % still bills old row % and nothing that carries its hours. Nothing was changed.', v_bad.invoice_number, v_bad.alloc_id;
    end if;

    -- ── the report ──
    select jsonb_build_object(
      'dry', false,
      'entries', v_scope,
      'pieces', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'entry_id', t.id,
                 'parent_id', e.id,
                 'org_id', e.org_id,
                 'kind', case when t.id = e.id then 'kept' else 'new' end,
                 'first_name', split_part(coalesce(pr.full_name, ''), ' ', 1),
                 'job_number', j.job_number,
                 'job_code', t.job_code,
                 'start_local', to_char(t.clock_in at time zone e.tz, 'YYYY-MM-DD HH24:MI'),
                 'end_local', to_char(t.clock_out at time zone e.tz, 'HH24:MI'),
                 'lunch_minutes', t.lunch_minutes,
                 'hours', round(greatest(extract(epoch from (t.clock_out - t.clock_in)) - coalesce(t.lunch_minutes, 0) * 60, 0) / 3600.0, 4),
                 'paid', t.paid_at is not null)
               order by e.clock_in, e.id, t.clock_in)
          from _carve_e e
          join public.time_entries t
            on t.id = e.id
            or t.id in (select s.first_alloc from _carve_s s where s.entry_id = e.id and not s.is_home and not s.dropped)
          left join public.profiles pr on pr.id = t.profile_id
          left join public.jobs j on j.id = t.job_id), '[]'::jsonb),
      'line_writes', coalesce((
        select jsonb_agg(jsonb_build_object('line_id', w.line_id, 'invoice_number', w.invoice_number,
                                            'status', w.status, 'added', to_jsonb(w.added), 'removed', to_jsonb(w.removed)))
          from _carve_lw w where cardinality(w.added) > 0 or cardinality(w.removed) > 0), '[]'::jsonb),
      'trims', coalesce((
        select jsonb_agg(jsonb_build_object('entry_id', s.entry_id, 'piece', s.first_alloc,
                                            'trimmed_seconds', s.trimmed, 'dropped', s.dropped))
          from _carve_s s where s.trimmed > 0), '[]'::jsonb),
      'by_org', coalesce((
        select jsonb_object_agg(o.org_id::text, o.c)
          from (
            select e.org_id, jsonb_build_object(
                     'entries', count(*),
                     'pieces_inserted', (select count(*) from _carve_s s join _carve_e x on x.id = s.entry_id
                                          where x.org_id = e.org_id and not s.is_home and not s.dropped),
                     'entries_left_whole', count(*) filter (
                        where not exists (select 1 from _carve_s s where s.entry_id = e.id and not s.is_home and not s.dropped)),
                     -- Splits whose rows ran past the clock and were TRIMMED to it (the C7 trim). A
                     -- row total over the clock with nothing to trim (a 0 h row) is not one.
                     'over_splits_trimmed', count(*) filter (
                        where exists (select 1 from _carve_s s where s.entry_id = e.id and s.trimmed > 0)),
                     -- Entries whose lunch is longer than their clock (worked time below zero). The
                     -- carve leaves them as they were; they are the office's to fix by hand.
                     'negative_worked_entries', count(*) filter (where e.worked_s < 0),
                     'moved_to_a_row_job', (select count(*) from _carve_s s join _carve_e x on x.id = s.entry_id
                                             where x.org_id = e.org_id and s.absorbs
                                               and (s.rjob is distinct from x.job_id or s.rcode is distinct from x.job_code)),
                     'rows_archived', (select count(*) from _carve_r r where r.org_id = e.org_id),
                     'lines_written', (select count(*) from _carve_lw w
                                        join _carve_lines_before b on b.id = w.line_id
                                        join public.invoices i on i.id = b.invoice_id
                                       where i.org_id = e.org_id
                                         and (cardinality(w.added) > 0 or cardinality(w.removed) > 0))) as c
              from _carve_e e
             group by e.org_id
          ) o), '{}'::jsonb))
      into v_report;

    if p_dry then
      raise exception using errcode = 'CNDRY', message = 'carve dry run: rolled back';
    end if;
    return v_report;
  exception
    when sqlstate 'CNDRY' then
      return v_report || jsonb_build_object('dry', true);
  end;
end $$;

revoke all on function public.carve_legacy_allocations(boolean, uuid[], jsonb) from public, anon, authenticated, service_role;
comment on function public.carve_legacy_allocations(boolean, uuid[], jsonb) is
  '0289: converts old time_allocations splits into ordinary touching time entries (see the migration header for the rules and proofs). p_dry rolls everything back and returns the report; p_entry_ids scopes the run and DELETEs instead of TRUNCATE; p_order = {"entry": [allocation ids in worked order]}. Database-owner only.';

-- ── 4. THE REAL RUN ─────────────────────────────────────────────────────────────────────────────
-- Erik's answers, 2026-09-24:
--   1. Jul 14 (0c7fae89): the J-011 hour was the LAST hour. J-033 11:30-16:30 with the lunch,
--      J-011 16:30-17:30 (the piece takes the old row's id, 2f468f0d, which draft INV-078 holds).
--   2. Jun 25 (0bc53134 Brian, 65e608c7 Erik): J-016 first, then J-013.
--   3. Aug 5 (02547c5c) merges back into one whole J-011 entry (both rows resolve to it), and the two
--      empty job-less punches go (below).
-- Jul 31 (592cb827) is listed too, in its recorded order (J-036 first), so every ET split runs in
-- an order a person said out loud. The other org's six run in their recorded order.
do $$
declare
  v_et     constant uuid := '60195593-2e18-4230-bc8e-7a32d36d038d';
  v_report jsonb;
  v_p      jsonb;
  v_org    record;
  v_bad    record;
  v_n      integer;
  v_line   record;
  g        record;
begin
  -- Applied twice (a re-run of this file): the conversion already happened; say so and move on.
  if not exists (select 1 from public.time_allocations)
     and exists (select 1 from archive.time_allocations) then
    raise notice '0289: the old splits were already converted (% rows archived). Nothing to carve.',
      (select count(*) from archive.time_allocations);
    return;
  end if;

  create temp table _mig_lines_before on commit drop as
  select it.id, md5(concat_ws('|', it.invoice_id::text, it.quantity::text, it.unit_price::text, it.description,
                              it.source_ids::text)) as h
    from public.invoice_items it;

  v_report := public.carve_legacy_allocations(false, null, jsonb_build_object(
    -- Jul 14: J-033 (fbbc563f) then J-011 (2f468f0d)
    '0c7fae89-7aa0-40ed-b2aa-d75a89e1cef7', jsonb_build_array('fbbc563f-a8b4-4bdf-8317-3148387ee80a', '2f468f0d-e010-4623-a785-c671e8651ee6'),
    -- Jun 25 Brian: J-016 (6bd5380f) then J-013 (4115ade9)
    '0bc53134-a368-457a-a50d-124893f16bb5', jsonb_build_array('6bd5380f-82cd-4f42-9858-62d69dc14ee3', '4115ade9-cde5-4bfe-9a86-7326e0a9b8d2'),
    -- Jun 25 Erik: J-016 (bcf29e88) then J-013 (b0c70aec)
    '65e608c7-8adf-4c19-866f-eb4d00dd6f80', jsonb_build_array('bcf29e88-a68b-49fb-80aa-eacb7f6f655d', 'b0c70aec-b3a6-4e72-9bc9-c5e5a80b74a6'),
    -- Jul 31: J-036 (af197448) then J-011 (1d4c211b)
    '592cb827-2b25-442f-b919-073b3ba6c090', jsonb_build_array('af197448-6f7d-43a3-beb0-39fd87096ca2', '1d4c211b-0bad-4477-a7f2-b38761b35e35'),
    -- Aug 5: both J-011; they merge
    '02547c5c-d7da-425b-ae2c-429389fae767', jsonb_build_array('fe406deb-afc3-4b99-a1cb-95e5424898d8', '03547be8-9a59-47d3-b757-1fe228ceee2c')
  ));

  -- What ET's timecards read now, piece by piece.
  for v_p in select value from jsonb_array_elements(v_report -> 'pieces')
              where (value ->> 'org_id')::uuid = v_et
              order by value ->> 'start_local', value ->> 'entry_id' loop
    raise notice '0289 ET: % % % % %-% % h%',
      left(v_p ->> 'entry_id', 8), v_p ->> 'kind', v_p ->> 'first_name',
      coalesce(v_p ->> 'job_number', v_p ->> 'job_code', 'no job'),
      v_p ->> 'start_local', v_p ->> 'end_local', round((v_p ->> 'hours')::numeric, 2),
      case when (v_p ->> 'lunch_minutes')::int > 0 then ' (' || (v_p ->> 'lunch_minutes') || ' min lunch)' else '' end
      || case when (v_p ->> 'entry_id') in ('6ebbe3ca-730f-48fd-ab96-2611d2945d8e', '1a284909-2f20-402f-bd7c-8765f673c950')
              then ' (empty punch, deleted below)' else '' end;
  end loop;
  for v_p in select value from jsonb_array_elements(v_report -> 'line_writes') loop
    raise notice '0289 line %: % added %, removed %', left(v_p ->> 'line_id', 8), v_p ->> 'invoice_number',
      v_p -> 'added', v_p -> 'removed';
  end loop;
  -- Any other org: counts only.
  for v_org in select key, value from jsonb_each(v_report -> 'by_org') where key::uuid <> v_et loop
    raise notice '0289 other org %: %', left(v_org.key, 8), v_org.value;
  end loop;

  -- ── THE RESULT ERIK APPROVED, EXACTLY ──
  select x.id, x.want
    into v_bad
    from (values
      ('0bc53134-a368-457a-a50d-124893f16bb5'::uuid, 'J-016 2026-06-25 12:30-13:30 lunch 0'),
      ('4115ade9-cde5-4bfe-9a86-7326e0a9b8d2'::uuid, 'J-013 2026-06-25 13:30-16:00 lunch 0'),
      ('65e608c7-8adf-4c19-866f-eb4d00dd6f80'::uuid, 'J-016 2026-06-25 12:30-14:00 lunch 30'),
      ('b0c70aec-b3a6-4e72-9bc9-c5e5a80b74a6'::uuid, 'J-013 2026-06-25 14:00-17:00 lunch 0'),
      ('0c7fae89-7aa0-40ed-b2aa-d75a89e1cef7'::uuid, 'J-033 2026-07-14 11:30-16:30 lunch 30'),
      ('2f468f0d-e010-4623-a785-c671e8651ee6'::uuid, 'J-011 2026-07-14 16:30-17:30 lunch 0'),
      ('af197448-6f7d-43a3-beb0-39fd87096ca2'::uuid, 'J-036 2026-07-31 10:14-14:02 lunch 0'),
      ('592cb827-2b25-442f-b919-073b3ba6c090'::uuid, 'J-011 2026-07-31 14:02-17:32 lunch 30'),
      ('02547c5c-d7da-425b-ae2c-429389fae767'::uuid, 'J-011 2026-08-05 15:00-18:30 lunch 0')
    ) as x(id, want)
    left join public.time_entries t on t.id = x.id
    left join public.jobs j on j.id = t.job_id
   where t.id is null
      or t.org_id <> v_et
      or concat(j.job_number, ' ', to_char(t.clock_in at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI'),
                '-', to_char(t.clock_out at time zone 'America/Los_Angeles', 'HH24:MI'), ' lunch ', t.lunch_minutes) <> x.want
   limit 1;
  if found then
    raise exception '0289: entry % is not "%" after the carve. Nothing was changed.', v_bad.id, v_bad.want;
  end if;

  -- Brian's paid piece is paid exactly as the shift was: same lock, same $40 override.
  if not exists (
       select 1 from public.time_entries n join public.time_entries p on p.id = '0bc53134-a368-457a-a50d-124893f16bb5'
        where n.id = '4115ade9-cde5-4bfe-9a86-7326e0a9b8d2'
          and n.paid_at = p.paid_at and n.paid_at is not null
          and n.rate_override = 40 and p.rate_override = 40
          and n.split_from = p.id and n.split_how = 'converted') then
    raise exception '0289: Brian''s Jun 25 piece did not keep the shift''s pay lock and rate. Nothing was changed.';
  end if;
  -- Erik's pieces carry no pay rate (0286).
  if exists (select 1 from public.time_entries
              where id in ('b0c70aec-b3a6-4e72-9bc9-c5e5a80b74a6', '2f468f0d-e010-4623-a785-c671e8651ee6',
                           'af197448-6f7d-43a3-beb0-39fd87096ca2')
                and (rate_override is not null or paid_at is not null)) then
    raise exception '0289: an owner piece carries a pay rate or a pay lock. Nothing was changed.';
  end if;

  -- Exactly ONE invoice line changed anywhere: draft INV-078's labor line, and only its claim.
  select count(*) into v_n
    from public.invoice_items it
    join _mig_lines_before b on b.id = it.id
   where md5(concat_ws('|', it.invoice_id::text, it.quantity::text, it.unit_price::text, it.description,
                       it.source_ids::text)) <> b.h;
  if v_n <> 1 or (select count(*) from public.invoice_items) <> (select count(*) from _mig_lines_before) then
    raise exception '0289: % invoice lines changed; exactly one (INV-078 line 72c2c363) was expected. Nothing was changed.', v_n;
  end if;
  select it.quantity, it.source_ids, i.status::text as status, i.invoice_number
    into v_line
    from public.invoice_items it join public.invoices i on i.id = it.invoice_id
   where it.id = '72c2c363-5f49-41d7-9846-baa07cc0c767';
  if not found
     or v_line.status <> 'draft'
     or v_line.quantity <> 50.50
     or not (v_line.source_ids @> array['592cb827-2b25-442f-b919-073b3ba6c090', '02547c5c-d7da-425b-ae2c-429389fae767',
                                        '2f468f0d-e010-4623-a785-c671e8651ee6']::uuid[])
     or v_line.source_ids && array['1d4c211b-0bad-4477-a7f2-b38761b35e35', 'fe406deb-afc3-4b99-a1cb-95e5424898d8',
                                   '03547be8-9a59-47d3-b757-1fe228ceee2c']::uuid[] then
    raise exception '0289: INV-078 line 72c2c363 is not what was approved (quantity %, status %). Nothing was changed.',
      v_line.quantity, v_line.status;
  end if;
  raise notice '0289: the only invoice line written is % line 72c2c363 (draft, % h, unchanged).', v_line.invoice_number, v_line.quantity;

  -- ── 5. THE TWO EMPTY PUNCHES (Erik, decision 3) ──
  -- Seconds long, no job, nothing billed, nothing paid. Each is deleted only if that is still true.
  for g in select * from (values
             ('6ebbe3ca-730f-48fd-ab96-2611d2945d8e'::uuid, 'Jul 2'),
             ('1a284909-2f20-402f-bd7c-8765f673c950'::uuid, 'Aug 5')) as x(id, day) loop
    if not exists (select 1 from public.time_entries where id = g.id) then
      raise notice '0289: the % empty punch % is already gone.', g.day, left(g.id::text, 8);
      continue;
    end if;
    if not exists (
         select 1 from public.time_entries t
          where t.id = g.id
            and t.org_id = v_et
            and t.job_id is null
            and t.status = 'closed'
            and t.clock_out is not null
            and t.clock_out - t.clock_in < interval '1 minute'
            and t.paid_at is null and t.mileage_paid_at is null) then
      raise exception '0289: the % punch % is no longer an empty, unpaid, job-less punch under a minute long. Nothing was changed.',
        g.day, g.id;
    end if;
    if exists (select 1 from public.invoice_items it where it.source_ids && array[g.id]) then
      raise exception '0289: an invoice line names the % punch %, so it stays. Nothing was changed.', g.day, g.id;
    end if;
    delete from public.time_entries where id = g.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception '0289: the % punch % did not delete. Nothing was changed.', g.day, g.id;
    end if;
    -- The archive's became names the entry that carries a row's hours now; this one is gone, and a
    -- 0 h row's hours are carried by nothing.
    update archive.time_allocations
       set became = null, carve_note = 'zero, entry deleted'
     where became = g.id;
    raise notice '0289: deleted the % empty punch %.', g.day, left(g.id::text, 8);
  end loop;

  if exists (select 1 from public.time_allocations) then
    raise exception '0289: time_allocations is not empty after the carve. Nothing was changed.';
  end if;
end $$;

-- ── 6. THE FREEZE ───────────────────────────────────────────────────────────────────────────────
-- A split is an ordinary entry now. The table stays (0290 drops it at least one deploy later, once
-- nothing reads it) but takes no new rows, so old and new splits are never live together.
--
-- cn.legacy_fixture exists for the database tests alone: they run against production inside a
-- transaction that always rolls back, and need an old-style row to carve. It is honoured only on a
-- direct database connection (no request claims at all), which could disable this trigger outright
-- anyway; no PostgREST caller, service role included, can reach it.
create or replace function public.refuse_time_allocation_insert()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('cn.legacy_fixture', true), '') = 'on'
     and coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = '' then
    return new;
  end if;
  raise exception 'Splits are ordinary entries now. Use Split This Shift on the timecard instead.'
    using errcode = 'P0001';
end $$;

revoke execute on function public.refuse_time_allocation_insert() from public, anon;

drop trigger if exists aa_time_allocations_frozen on public.time_allocations;
create trigger aa_time_allocations_frozen
  before insert on public.time_allocations
  for each row execute function public.refuse_time_allocation_insert();

create or replace function public.replace_time_allocations(p_entry uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
begin
  raise exception 'Splits are ordinary entries now. Use Split This Shift on the timecard instead.'
    using errcode = 'P0001';
end;
$$;

comment on function public.replace_time_allocations(uuid, jsonb) is
  'Frozen by 0289: a split is ordinary time entries now (split_time_entry). Always raises.';
comment on table public.time_allocations is
  'FROZEN (0289). Every row was converted into ordinary time entries and archived to archive.time_allocations; the table refuses inserts and is dropped by 0290.';
