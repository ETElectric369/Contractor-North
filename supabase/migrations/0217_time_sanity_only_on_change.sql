-- 0217 — 0214's guards must judge the CHANGE, not the row.
--
-- Caught by the adversarial review of 0214 itself, within hours of shipping it. Both defects
-- have the same root: the trigger is BEFORE INSERT OR UPDATE OF clock_in, clock_out, and
-- Postgres fires "UPDATE OF" on column MENTION, not on value change. updateTimeEntry — the one
-- canonical office write path, used by the timecards modal and by Nort's time.update — always
-- sends clock_in and clock_out (they are required params), so the guards re-ran on every save
-- even when the times were untouched:
--
--   1. THE 18-HOUR CEILING HAD NO REACHABLE ESCAPE. 0214's comment promised the office could
--      "record and annotate a known-bad row" because a row carrying auto_closed_reason is an
--      acknowledged correction. That path does not exist in the app: updateTimeEntry sets
--      auto_closed_reason: null unconditionally ("the flag has done its job and comes off"),
--      and no UI writes it. So the guard saw NULL on every office save and refused — which
--      LOCKED the exact rows this audit flagged: Chris Taylor's 216.99h forgotten punch could
--      no longer be corrected by anyone.
--
--   2. THE DUPLICATE GUARD FROZE AN EXISTING PAIR. Brian Taylor's two byte-identical
--      2026-08-18 entries (18:30→20:00, on DIFFERENT jobs) are still live. Opening either one
--      to fix its job, lunch, miles or split re-sent the same times, the guard found its twin,
--      and refused — with advice that reads backwards when you ARE editing the existing one.
--
-- The guards' real purpose is to stop a bad shift being CREATED or a good one being STRETCHED
-- into a bad one. Neither needs to fire on a correction that leaves the times where they are.

create or replace function public.guard_time_entry_sanity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_span interval;
  v_times_changed boolean;
begin
  -- The whole point: judge the CHANGE. On INSERT everything is new; on UPDATE, only act when
  -- a time actually moved. An allocation, job, note, mileage or rate correction rides free.
  v_times_changed := tg_op = 'INSERT'
    or new.clock_in is distinct from old.clock_in
    or new.clock_out is distinct from old.clock_out;

  if not v_times_changed then
    return new;
  end if;

  -- ── 1. NEVER TWO IDENTICAL ENTRIES ──────────────────────────────────────────────────────
  if new.clock_in is not null and new.clock_out is not null then
    if exists (
      select 1 from public.time_entries t
       where t.profile_id = new.profile_id
         and t.id is distinct from new.id
         and t.clock_in = new.clock_in
         and t.clock_out = new.clock_out
    ) then
      raise exception 'Those exact times are already recorded for this person on another entry — change the times, or edit that entry instead.';
    end if;
  end if;

  -- ── 2. A SHIFT LONGER THAN 18 HOURS IS A FORGOTTEN PUNCH, WHOEVER RECORDED IT ────────────
  -- The escape stays (a row carrying a stated reason is an acknowledged correction), but it is
  -- no longer the ONLY way through: correcting the times of a bad row now passes on its own,
  -- because shortening a 216-hour span to a real one is exactly what we want to encourage.
  if new.clock_in is not null and new.clock_out is not null then
    v_span := new.clock_out - new.clock_in;
    if v_span > interval '18 hours' and coalesce(new.auto_closed_reason, '') = '' then
      raise exception 'That shift is % hours long — a punch was probably forgotten. Fix the times, or add a note saying what happened.',
        round(extract(epoch from v_span) / 3600.0, 1);
    end if;
    if v_span < interval '0' then
      raise exception 'That shift ends before it starts.';
    end if;
  end if;

  return new;
end
$function$;

comment on function public.guard_time_entry_sanity() is
  'Role-independent time-entry sanity (0214, narrowed in 0217 to fire only when clock_in/clock_out actually change): no NEW byte-identical duplicate, no >18h span created or extended without a stated reason, no negative span. Corrections that leave the times alone always pass.';
