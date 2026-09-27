-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0360: one person, one place at a time
--
-- Erik, 2026-09-26, on the same work landing twice on his crew's timecards: "yes remove the
-- duplicates and track down the problem causing that please".
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────
--
-- The same hours were recorded twice, in seven pairs at ET (Brian 6/30, 8/18 x3, 9/11; Erik 9/1,
-- 9/11). Four of them follow one path: a clock punch goes in with NO JOB (the punch could not tell
-- which job it was on), nothing ever asks, the job's labor never sees it, and days later the office
-- types the same day again on the job so it reaches the invoice. The rest are a hand entry sent
-- twice. Payroll sums every row it is handed, so each pair was earned and owed twice.
--
-- Every pair was written on or before 2026-09-19. 0278 (cn-v967) put an overlap refusal under
-- time_entries the day after, inside guard_time_entry_sanity, and none has been written since. It
-- still leaves four holes, and each is a way back to the same place:
--
--   1. A RUNNING SHIFT IS NEVER CHECKED. The overlap test runs only when the row has both a start
--      and an end, and only against rows that have an end. So a clock-in back-dated over hours
--      already recorded (a staff "I forgot to clock in at 10", an offline punch delivered late)
--      lands open on top of them. Nothing refuses it until clock-out, and then the refusal falls on
--      the person holding the phone: a tech cannot edit entries, so he stays clocked in until the
--      office clears the other row. The same blind spot lets the office type hours into a day a
--      clock is still running across.
--   2. NO LOCK. The check reads the table and then the insert happens. Two saves of the same hours
--      at the same moment (two tabs, two phones, a double tap on a slow connection) both read a
--      clear day and both land.
--   3. HANDING A SHIFT TO SOMEONE ELSE IS NOT CHECKED. The trigger fires on UPDATE OF clock_in,
--      clock_out only; the function's own gate already names profile_id, but a reassign that keeps
--      the times never reaches it. Moving Brian's 8-to-4 onto Erik's card, when Erik already has
--      8-to-4, is the same afternoon paid twice.
--   4. THE SENTENCE IS WRONG FOR ANY OTHER COMPANY AND SAYS TOO LITTLE. The clash times are written
--      in America/Los_Angeles whatever the company's own timezone is, and the sentence does not
--      say whose shift it is or what job it is on, so the office cannot tell a no-job punch (put it
--      on the job) from real work on another job (edit it).
--
-- ── THE FIX ────────────────────────────────────────────────────────────────────────────────
--
-- ONE BOUNDARY, NOT TWO. guard_time_entry_sanity already is the "one person cannot be on two jobs
-- at once" rule; a second trigger beside it would be two copies of one rule answering the same save
-- in two voices. So this replaces its body, from the LIVE body (pg_get_functiondef read on
-- production and on the test database, 2026-09-26: md5 04c588a8e41cba34ea5b407850b1fa7d, which is
-- 0291's text), and re-points its trigger at one more column. What changes:
--
--   A. A MISSING END IS NOW. A running shift counts as running until now() on both sides of the
--      test: a new or changed row may not cover hours a clock is still running across, and a clock
--      may not open (back-dated) over hours already recorded. A live punch opens at now(), so it
--      covers nothing and always passes; so does Switch Job's new piece, which opens at the instant
--      the old one closed (0288 closes first, then inserts).
--      TWO RUNNING CLOCKS ARE NOT THIS RULE'S. one_open_entry_per_user already refuses a second open
--      row with "You're already clocked in.", and a stale one (18 h+) is closed at zero first by
--      close_stale_before_punch (0193, which runs earlier in name order); this guard steps aside for
--      open-against-open so that sentence, not this one, is what a double tap reads.
--   B. ONE PERSON'S TIME WRITES TAKE TURNS. pg_advisory_xact_lock on the person, before the read, so
--      the second of two simultaneous saves waits for the first and then sees it. Held to the end of
--      the writing transaction, only when a time actually moves, keyed on the person (never the
--      table), so nobody else's punch ever waits on it.
--   C. THE TRIGGER ALSO FIRES ON profile_id, so handing a shift to someone else is checked against
--      that person's card. Their gate (v_times_changed) already asked for it.
--   D. THE SENTENCE NAMES THE SHIFT: whose, which day, from and to in THE COMPANY'S timezone
--      (split_org_tz, 0288: organizations.settings.timezone, the app's own default when unset), and
--      the job it is on or "no job", with the advice that fits: a shift on no job and no code is put
--      on the job; a shift on a job, or filed under a code with no job (SHOP, PTO: the company's own
--      time), is edited; a running clock is stopped first. The words "overlap a shift
--      already recorded" stay in every one of them, because clockOut and stopShift recognise the
--      refusal by them. DETAIL carries "time_entry:<id>" so a door can link to the shift it names.
--
-- Everything else is 0291's body word for word: the exact-duplicate refusal, the one-minute slack,
-- the 18-hour ceiling, the negative-span refusal, and the v_times_changed gate (0217) that lets a
-- note, job or mileage fix save on a row that already overlaps another. The seven existing pairs
-- stay editable and are not touched.
--
-- NOT A CONSTRAINT: an exclusion constraint (tstzrange && per person) would refuse to build over
-- the seven pairs already in the ledger, and would also refuse the note fix on them.
--
-- WHAT STILL PASSES, AND THE DB SUITE PROVES EACH (one-place-at-a-time.integration.test.ts): a live
-- punch; a tech's punch right after his clock-out; Switch Job (cut and re-point); Clock Out and the
-- office's Stop The Clock at a stated time; an offline punch delivered late onto a clear day, and
-- its clock-out; split, Move The Split (0288 shrinks one piece before growing the other) and Join
-- Back; a stale clock zero-closed by the next punch; the same hours for two different people.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────────────────────
--   CREATE OR REPLACE FUNCTION: no table lock. CREATE OR REPLACE TRIGGER on time_entries: SHARE
--   ROW EXCLUSIVE for an instant (writes wait, reads do not). lock_timeout 3s, statement_timeout
--   15s: queued behind a long transaction, this gives up in 3 seconds instead of stalling the clock.
--
-- ── ORDER ──────────────────────────────────────────────────────────────────────────────────
--   After 0291 (the body it replaces) and 0288 (split_org_tz, split_job_label). Independent of
--   0357-0359. The app side (cn fix/duplicate-punches) reads the new DETAIL when it is there and
--   works without it, so code and migration may ship in either order.
--
-- ── SAFE TO RE-RUN ─────────────────────────────────────────────────────────────────────────
--   Yes: create or replace, and the checks at the end raise "Nothing was changed." if any part is
--   missing. Writes no data. One transaction (apply-migration.cjs wraps it in begin/commit).

set local lock_timeout = '3s';
set local statement_timeout = '15s';

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
  v_now timestamptz := now();
  v_new_end timestamptz;
  v_tz text;
  v_who text;
  v_where text;
begin
  v_times_changed := tg_op = 'INSERT'
    or new.clock_in is distinct from old.clock_in
    or new.clock_out is distinct from old.clock_out
    or new.profile_id is distinct from old.profile_id;

  if not v_times_changed then
    return new;
  end if;

  -- ONE PERSON, ONE PLACE AT A TIME (0360). A person cannot be on two jobs at once, and payroll pays
  -- for both when they are.
  if new.clock_in is not null and new.profile_id is not null then
    -- One person's time writes take turns, so two saves of the same hours cannot both read a clear
    -- day. Keyed on the person: nobody else's punch waits on it.
    perform pg_advisory_xact_lock(hashtextextended('cn.time_entries.person:' || new.profile_id::text, 0));

    if new.clock_out is not null then
      select t.id
        into v_clash
        from public.time_entries t
       where t.profile_id = new.profile_id
         and t.id is distinct from new.id
         and t.clock_in = new.clock_in
         and t.clock_out = new.clock_out
       limit 1;
      if found then
        raise exception 'Those exact times are already recorded for this person on another entry. Change the times, or edit that entry instead.'
          using errcode = 'P0001', detail = 'time_entry:' || v_clash.id::text;
      end if;
    end if;

    -- A running shift runs until now, on both sides. Two running shifts are one_open_entry_per_user's.
    v_new_end := coalesce(new.clock_out, v_now);
    select t.id, t.clock_in, t.clock_out, t.job_id, t.job_code
      into v_clash
      from public.time_entries t
     where t.profile_id = new.profile_id
       and t.id is distinct from new.id
       and not (t.clock_out is null and new.clock_out is null)
       and t.clock_in < v_new_end
       and new.clock_in < coalesce(t.clock_out, v_now)
       and least(coalesce(t.clock_out, v_now), v_new_end) - greatest(t.clock_in, new.clock_in) > interval '1 minute'
     order by t.clock_in
     limit 1;

    if found then
      v_tz := public.split_org_tz(coalesce(new.org_id, (select p.org_id from public.profiles p where p.id = new.profile_id)));
      v_who := coalesce(nullif(btrim((select p.full_name from public.profiles p where p.id = new.profile_id)), ''), 'this person');
      v_where := case
        when v_clash.job_id is null and nullif(btrim(coalesce(v_clash.job_code, '')), '') is null then 'on no job'
        else 'on ' || public.split_job_label(v_clash.job_id, v_clash.job_code)
      end;
      if v_clash.clock_out is null then
        raise exception 'Those hours overlap a shift already recorded for %: a clock running since % %, %. Stop that clock at the time the shift really ended first.',
          v_who,
          to_char(v_clash.clock_in at time zone v_tz, 'Dy Mon FMDD,'),
          to_char(v_clash.clock_in at time zone v_tz, 'FMHH12:MI AM'),
          v_where
          using errcode = 'P0001', detail = 'time_entry:' || v_clash.id::text;
      -- On no job AND no code: a punch nobody placed, which goes on the job. A coded one (SHOP, PTO)
      -- is the company's own time filed on purpose, and is edited like any other shift.
      elsif v_clash.job_id is null and nullif(btrim(coalesce(v_clash.job_code, '')), '') is null then
        raise exception 'Those hours overlap a shift already recorded for %: % % to %, %. Put that shift on the job instead of adding the hours again, or move these times clear of it.',
          v_who,
          to_char(v_clash.clock_in at time zone v_tz, 'Dy Mon FMDD,'),
          to_char(v_clash.clock_in at time zone v_tz, 'FMHH12:MI AM'),
          to_char(v_clash.clock_out at time zone v_tz, 'FMHH12:MI AM'),
          v_where
          using errcode = 'P0001', detail = 'time_entry:' || v_clash.id::text;
      else
        raise exception 'Those hours overlap a shift already recorded for %: % % to %, %. Edit that shift instead, or move these times clear of it.',
          v_who,
          to_char(v_clash.clock_in at time zone v_tz, 'Dy Mon FMDD,'),
          to_char(v_clash.clock_in at time zone v_tz, 'FMHH12:MI AM'),
          to_char(v_clash.clock_out at time zone v_tz, 'FMHH12:MI AM'),
          v_where
          using errcode = 'P0001', detail = 'time_entry:' || v_clash.id::text;
      end if;
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

comment on function public.guard_time_entry_sanity() is
  'ONE PERSON, ONE PLACE AT A TIME (0360, from 0278/0281/0291). Refuses a new or changed time entry whose hours overlap another entry of the same person by more than a minute, a running shift counting as running until now on both sides (two running shifts are left to one_open_entry_per_user); refuses exact duplicates, spans over 18 hours without an auto_closed_reason, and negative spans. Takes a per-person advisory lock first so simultaneous saves take turns. Fires only when clock_in, clock_out or profile_id actually changes (0217), so a note or job fix on an existing overlap always saves. The sentence names the person, the other shift''s day and times in the company''s timezone and its job; DETAIL is time_entry:<id>.';

-- The trigger also fires when a shift is handed to someone else.
create or replace trigger zz_guard_time_entry_sanity
  before insert or update of clock_in, clock_out, profile_id on public.time_entries
  for each row execute function public.guard_time_entry_sanity();

-- ── THE CHECK ───────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_src text;
  v_names text;
begin
  select prosrc into v_src from pg_proc where oid = 'public.guard_time_entry_sanity()'::regprocedure;
  if v_src not ilike '%pg_advisory_xact_lock%' then
    raise exception '0360: guard_time_entry_sanity takes no per-person lock. Nothing was changed.';
  end if;
  if v_src not ilike '%coalesce(t.clock_out, v_now)%' then
    raise exception '0360: guard_time_entry_sanity still skips running shifts. Nothing was changed.';
  end if;
  if v_src ilike '%America/Los_Angeles%' then
    raise exception '0360: guard_time_entry_sanity still writes one company''s timezone into every sentence. Nothing was changed.';
  end if;
  if v_src ilike '%add a note%' then
    raise exception '0360: guard_time_entry_sanity offers the note escape 0291 removed. Nothing was changed.';
  end if;

  -- The two helpers the sentence reads (0288).
  if to_regprocedure('public.split_org_tz(uuid)') is null or to_regprocedure('public.split_job_label(uuid, text)') is null then
    raise exception '0360: split_org_tz or split_job_label (0288) is missing. Nothing was changed.';
  end if;

  -- The trigger: bound to the function, enabled, BEFORE, row-level, INSERT and UPDATE, and its
  -- column list holds clock_in, clock_out and profile_id.
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.time_entries'::regclass
       and t.tgname = 'zz_guard_time_entry_sanity'
       and t.tgfoid = 'public.guard_time_entry_sanity()'::regprocedure
       and t.tgenabled <> 'D'
       and (t.tgtype & 1) = 1      -- row
       and (t.tgtype & 2) = 2      -- before
       and (t.tgtype & 4) = 4      -- insert
       and (t.tgtype & 16) = 16    -- update
       and (select array_agg(a.attname::text order by a.attname)
              from unnest(t.tgattr::int2[]) as k(attnum)
              join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k.attnum)
           = array['clock_in', 'clock_out', 'profile_id']
  ) then
    raise exception '0360: zz_guard_time_entry_sanity is not a BEFORE INSERT OR UPDATE OF clock_in, clock_out, profile_id row trigger on time_entries. Nothing was changed.';
  end if;

  -- 0290's roster of the guards that stay, re-run (0291 re-ran it too): nothing here disturbed it.
  select string_agg(w.tbl || '.' || w.tg, ', ') into v_names
    from (values
      ('time_entries',  'time_entries_billed_hours_stay',    'guard_billed_time_entry'),
      ('time_entries',  'time_entries_billed_job_stays',     'guard_billed_time_entry_job'),
      ('time_entries',  'guard_time_entry_split_link',       'guard_time_entry_split_link'),
      ('time_entries',  'guard_paid_time_entry',             'guard_paid_time_entry'),
      ('time_entries',  'guard_time_entry_close_in_time',    'guard_time_entry_close_in_time'),
      ('time_entries',  'close_stale_before_punch',          'close_stale_open_entry'),
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
    raise exception '0360: these guards are missing or disabled: %. Nothing was changed.', v_names;
  end if;

  -- Two open rows for one person stay the unique index's to refuse.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'time_entries' and indexname = 'one_open_entry_per_user') then
    raise exception '0360: one_open_entry_per_user is missing, and this guard leaves two running clocks to it. Nothing was changed.';
  end if;
end $$;
