-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0321: the office's bell is not the crew's to silence (audit v994 TL3)
--
-- 0291 gave time_entries two claims for the hourly long-shift job: long_shift_warned_at (the
-- office's bell line at 10 hours) and long_shift_nudged_at (the question and the office's buzz at
-- 12). They were ordinary columns. RLS lets a crew member update his own rows, the authenticated
-- role has column UPDATE and INSERT on them, and guard_paid_time_entry's crew branch freezes
-- clock_in, rate_override, profile_id, source and paid_at, but not these two. The job skips a row
-- whose claims are both set. So a tech could PATCH his running row with both set to now (or clock
-- in with them preset), and the office would get no 10-hour bell and no 12-hour buzz while the clock
-- ran to the 18-hour ceiling. 0169's lesson, again: a control its subject can switch off is not a
-- control.
--
-- A small BEFORE trigger of its own (guard_paid_time_entry is not re-created, so nothing else in it
-- can drift): for a session caller who is not office staff, an INSERT may not set either claim, and
-- an UPDATE may not change either. The job runs as the service role, which is_privileged_writer
-- exempts; the office's own writes are unaffected. Switch Job (0288, security invoker) inserts the
-- next piece with both claims empty, so it passes.
--
-- The NAME MATTERS: BEFORE-row triggers fire in name order, and this one belongs with the other
-- guards before zz_guard_time_entry_sanity. It is not in 0290's roster of guards that stay; the
-- check below names it on its own.
--
-- Read-only check 2026-09-24 (ET Electric, TAHOE DECK, Vivian Builders): 0 crew rows carry either
-- claim, and nothing is open, so this traps nothing already stored.
--
-- ORDER: after 0291. ONE TRANSACTION, AND ONLY IF THE RUNNER MAKES IT ONE (0290's note applies):
-- scripts/run-one-migration.mjs, `psql -1 -f`, or the Supabase SQL editor. Writes no data.
-- Re-runnable.

create or replace function public.guard_time_entry_long_shift_claims()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_org_staff() or public.is_privileged_writer() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.long_shift_warned_at is not null or new.long_shift_nudged_at is not null then
      raise exception 'Only the office''s long-shift check can mark a shift as asked about.';
    end if;
  elsif new.long_shift_warned_at is distinct from old.long_shift_warned_at
     or new.long_shift_nudged_at is distinct from old.long_shift_nudged_at then
    raise exception 'Only the office''s long-shift check can mark a shift as asked about.';
  end if;
  return new;
end $$;

revoke execute on function public.guard_time_entry_long_shift_claims() from public, anon;

comment on function public.guard_time_entry_long_shift_claims() is
  'A crew member''s own session may not set or change long_shift_warned_at / long_shift_nudged_at (the hourly long-shift job''s claims): otherwise he could switch off the office''s 10-hour bell and 12-hour buzz on his own running clock. Office staff and the service role (the job) are exempt. 0321.';

drop trigger if exists guard_time_entry_long_shift_claims on public.time_entries;
create trigger guard_time_entry_long_shift_claims
  before insert or update of long_shift_warned_at, long_shift_nudged_at on public.time_entries
  for each row execute function public.guard_time_entry_long_shift_claims();

-- ── THE CHECK ───────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_cols text;
begin
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.time_entries'::regclass
       and t.tgname = 'guard_time_entry_long_shift_claims'
       and t.tgfoid = to_regprocedure('public.guard_time_entry_long_shift_claims()')
       and t.tgenabled <> 'D') then
    raise exception '0321: guard_time_entry_long_shift_claims is missing or disabled. Nothing was changed.';
  end if;

  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_trigger t
    join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
   where t.tgrelid = 'public.time_entries'::regclass
     and t.tgname = 'guard_time_entry_long_shift_claims';
  if v_cols is distinct from 'long_shift_nudged_at,long_shift_warned_at' then
    raise exception '0321: the long-shift claim guard fires on (%), not on both claims. Nothing was changed.', v_cols;
  end if;
end $$;
