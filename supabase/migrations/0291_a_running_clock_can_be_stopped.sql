-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0291: a running clock can be stopped
--
-- Erik, 2026-09-24: "Let's fix the time clock problem, Brian did it the other day too and I had no
-- way to stop it to set the time for the invoice".
--
-- A crew member forgot to clock out. The office could SEE the clock running and had no door that
-- stopped it at the time the work really ended: the editor refused an open row, and every other
-- door closed it at "now". The app side of the fix is a Stop The Clock sheet (stopShift) that closes
-- an open row at a STATED time and writes who did it. This file is the part underneath it:
--
--   a) time_entries.long_shift_nudged_at: the hourly long-shift job claims a row by setting it
--      before it sends anything, so two overlapping runs never ask the same man twice.
--   b) guard_time_entry_close_in_time: NOBODY closes a shift in the future. 0248's "A shift cannot
--      end in the future" lives in guard_paid_time_entry, which skips staff, so the office editor or
--      Nort's time.fixEntry ("close Brian's open entry at 5") could close a live shift at 5 PM while
--      it was 4:30 PM, and payroll would pay the half hour nobody had worked yet.
--   c) guard_time_entry_sanity: the 18-hour refusal stops offering an escape that never worked.
--      "or add a note saying what happened" could not pass: the only exemption keys on
--      auto_closed_reason, and updateTimeEntry nulls that column on every save.
--   d) a self-check that raises "Nothing was changed." if any of it did not land.
--
-- ORDER: after 0290. Safe before or after the code that uses it: the code reads the new column
-- only in the cron (which tolerates its absence by failing that one run loudly) and the triggers
-- only refuse writes no honest door makes.
--
-- ONE TRANSACTION, AND ONLY IF THE RUNNER MAKES IT ONE (0290's note applies): scripts/
-- run-one-migration.mjs, `psql -1 -f`, or the Supabase SQL editor. Writes no data. Re-runnable.
--
-- Read-only check 2026-09-24: 0 rows in any org have clock_out > now() + 5 minutes, so the new
-- guard traps nothing already stored, and it only fires when clock_out MOVES (the 0217 lesson: a
-- notes or job fix on an old row must always save).

-- ── a) THE NUDGE'S CLAIM ────────────────────────────────────────────────────────────────────────
alter table public.time_entries add column if not exists long_shift_nudged_at timestamptz;

comment on column public.time_entries.long_shift_nudged_at is
  'When the hourly long-shift job (/api/timeclock/long-shift) asked this person whether they forgot to clock out. Set once, claimed before the push is sent, so a shift is asked about at most once. Never read by pay math. 0291.';

-- ── b) NOBODY CLOSES A SHIFT IN THE FUTURE ──────────────────────────────────────────────────────
-- Five minutes of slack: a phone clock a little ahead of the server is not an invented half hour.
-- A privileged writer (a migration, an ops repair, the service role) is not judged here, the same
-- exemption every time guard uses (0154).
--
-- The NAME MATTERS. BEFORE-row triggers fire in name order, and this one must run before
-- zz_guard_time_entry_sanity, whose overlap and 18-hour sentences would otherwise answer a close at
-- "tomorrow" with the wrong complaint. It must never be renamed zz_…: 0290's roster names the
-- guards that stay, and this is a new one beside them.
create or replace function public.guard_time_entry_close_in_time()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.clock_out is not null
     and (tg_op = 'INSERT' or new.clock_out is distinct from old.clock_out)
     and new.clock_out > now() + interval '5 minutes'
     and not public.is_privileged_writer() then
    raise exception 'A shift cannot end in the future. Pick the time it really stopped.';
  end if;
  return new;
end $$;

comment on function public.guard_time_entry_close_in_time() is
  'A shift may not be closed (or inserted closed) at a time that has not happened yet, for ANY session caller, staff included; 5 minutes of clock slack. Fires only when clock_out moves. Privileged writers are exempt. 0291.';

drop trigger if exists guard_time_entry_close_in_time on public.time_entries;
create trigger guard_time_entry_close_in_time
  before insert or update on public.time_entries
  for each row execute function public.guard_time_entry_close_in_time();

-- ── c) THE 18-HOUR SENTENCE SAYS WHAT WILL ACTUALLY WORK ────────────────────────────────────────
-- 0281's body, verbatim, with one sentence changed.
create or replace function public.guard_time_entry_sanity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_span interval;
  v_times_changed boolean;
  v_clash record;
begin
  v_times_changed := tg_op = 'INSERT'
    or new.clock_in is distinct from old.clock_in
    or new.clock_out is distinct from old.clock_out
    or new.profile_id is distinct from old.profile_id;

  if not v_times_changed then
    return new;
  end if;

  if new.clock_in is not null and new.clock_out is not null then
    if exists (
      select 1 from public.time_entries t
       where t.profile_id = new.profile_id
         and t.id is distinct from new.id
         and t.clock_in = new.clock_in
         and t.clock_out = new.clock_out
    ) then
      raise exception 'Those exact times are already recorded for this person on another entry. Change the times, or edit that entry instead.';
    end if;

    -- A person cannot be on two jobs at once, and payroll pays for both when they are.
    select t.id, t.clock_in, t.clock_out
      into v_clash
      from public.time_entries t
     where t.profile_id = new.profile_id
       and t.id is distinct from new.id
       and t.clock_out is not null
       and t.clock_in < new.clock_out
       and new.clock_in < t.clock_out
       and least(t.clock_out, new.clock_out) - greatest(t.clock_in, new.clock_in) > interval '1 minute'
     order by t.clock_in
     limit 1;

    if found then
      raise exception 'Those hours overlap a shift already recorded for this person on % (% to %). Edit that entry instead, or move these times clear of it.',
        to_char(v_clash.clock_in at time zone 'America/Los_Angeles', 'Mon FMDD'),
        to_char(v_clash.clock_in at time zone 'America/Los_Angeles', 'FMHH12:MIam'),
        to_char(v_clash.clock_out at time zone 'America/Los_Angeles', 'FMHH12:MIam');
    end if;
  end if;

  if new.clock_in is not null and new.clock_out is not null then
    v_span := new.clock_out - new.clock_in;
    if v_span > interval '18 hours' and coalesce(new.auto_closed_reason, '') = '' then
      raise exception 'That shift is % hours long, so a punch was probably forgotten. Change the end to when it really stopped.',
        round(extract(epoch from v_span) / 3600.0, 1);
    end if;
    if v_span < interval '0' then
      raise exception 'That shift ends before it starts.';
    end if;
  end if;

  return new;
end $$;

-- ── d) THE CHECK ────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_names text;
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.time_entries'::regclass
       and attname = 'long_shift_nudged_at'
       and not attisdropped
  ) then
    raise exception '0291: time_entries.long_shift_nudged_at is missing. Nothing was changed.';
  end if;

  -- Both guards this file touches, bound to time_entries, calling the right function, enabled.
  select string_agg(w.tg, ', ') into v_names
    from (values
      ('guard_time_entry_close_in_time', 'guard_time_entry_close_in_time'),
      ('zz_guard_time_entry_sanity',     'guard_time_entry_sanity')
    ) as w(tg, fn)
   where not exists (
     select 1 from pg_trigger t
      where t.tgrelid = 'public.time_entries'::regclass
        and t.tgname = w.tg
        and t.tgfoid = to_regprocedure('public.' || w.fn || '()')
        and t.tgenabled <> 'D');
  if v_names is not null then
    raise exception '0291: these guards are missing or disabled: %. Nothing was changed.', v_names;
  end if;

  if (select prosrc from pg_proc where oid = 'public.guard_time_entry_sanity()'::regprocedure) ilike '%add a note%' then
    raise exception '0291: guard_time_entry_sanity still offers the note escape. Nothing was changed.';
  end if;

  -- 0290's roster of the guards that stay, re-run: nothing here may have disturbed it.
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
    raise exception '0291: these guards are missing or disabled: %. Nothing was changed.', v_names;
  end if;
end $$;
