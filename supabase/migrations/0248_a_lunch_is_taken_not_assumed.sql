-- 0248 — A LUNCH IS TAKEN, NOT ASSUMED (Erik 2026-09-08: "remove the auto deduct 30 min lunch
-- and change it to a checkbox as an option but default to 0").
--
-- guard_paid_time_entry carried the app rule's twin: closing a shift over five gross hours with
-- fewer than 30 lunch minutes was REFUSED outright. That existed so a crafted PATCH couldn't skip
-- a deduction the app applied everywhere. The deduction is gone — every close now STATES its
-- minutes and 0 is the ordinary answer — so the floor has become the opposite of a guard: it
-- rejects the honest punch of a tech who worked straight through, with an error message
-- ("A shift over five hours carries a 30-minute lunch") that no UI can act on any more.
--
-- Everything else in the trigger is untouched, including the one that still matters here: on a
-- CLOSED shift a tech may still only RAISE lunch, never lower it, because lowering it adds paid
-- hours after the fact. The office keeps the free minutes field on Timecards.
--
-- Body below is the CURRENT shipped definition read from pg_get_functiondef, with ONLY the
-- >5h floor block removed.

CREATE OR REPLACE FUNCTION public.guard_paid_time_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  max_backdate interval;
begin
  -- ═══ INSERT: a member may only punch themselves IN ═══
  if tg_op = 'INSERT' then
    if not public.is_org_staff() and not public.is_privileged_writer() then
      if new.rate_override is not null then
        raise exception 'Only office staff can set a pay rate.';
      end if;
      if new.paid_at is not null or new.mileage_paid_at is not null then
        raise exception 'Only office staff can set payroll locks.';
      end if;
      if coalesce(new.status, 'open') <> 'open' or new.clock_out is not null then
        raise exception 'Ask the office to add a finished shift.';
      end if;
      if new.clock_in > now() + interval '5 minutes' then
        raise exception 'A shift cannot start in the future.';
      end if;

      -- HOW FAR BACK, honestly. 31 days was never a real bound for a self-punch — it was room for
      -- a picker that no longer exists on this path. A live punch may round back to the last half
      -- hour (45 min of slack for clock skew and a slow tap). An OFFLINE punch gets the length of
      -- a working shift, because that is the whole point of the queue, and no more: past that, the
      -- office enters it, which is what the client is already told to say.
      max_backdate := case when new.source = 'offline'
                           then interval '4 hours 15 minutes'
                           else interval '45 minutes' end;
      if new.clock_in < now() - max_backdate then
        raise exception 'That start time is too far back — ask the office to add it.';
      end if;

      -- NO OVERLAPPING SHIFTS. one_open_entry_per_user stops two OPEN rows, but nothing stopped a
      -- fabricated span from being laid on top of a shift already recorded and closed — which is
      -- how a backdated punch turns into hours paid twice.
      -- One minute of tolerance, deliberately: clocking out at 16:30 and straight back in for a
      -- second job must not be refused over boundary rounding. Fraud is measured in HOURS, so a
      -- minute costs nothing to allow — and a false refusal here means a tech cannot clock in at
      -- all, which is a work stoppage and strictly worse than the thing being prevented.
      if exists (
        select 1 from public.time_entries t
        where t.profile_id = new.profile_id
          and t.id is distinct from new.id
          and coalesce(t.clock_out, now()) > new.clock_in + interval '1 minute'
      ) then
        raise exception 'That start time overlaps a shift you already recorded — ask the office to sort it out.';
      end if;

      if coalesce(new.miles, 0) < 0 then
        raise exception 'Miles cannot be negative.';
      end if;
    end if;
    return new;
  end if;

  if not public.is_org_staff() and not public.is_privileged_writer() then
    -- ── 0095, unchanged: a settled row is frozen, and the locks are staff-only ──
    if old.paid_at is not null or old.mileage_paid_at is not null then
      raise exception 'Entry is in a paid period — ask the office to undo it on Payroll first.';
    end if;
    if new.paid_at is distinct from old.paid_at
       or new.mileage_paid_at is distinct from old.mileage_paid_at then
      raise exception 'Only office staff can change payroll locks.';
    end if;

    -- ── HOW A PUNCH WAS RECORDED IS NOT THE PUNCHER'S TO REWRITE (0169) ───────
    -- One carve-out, and only one: the geofence auto-clock-out legitimately promotes the tech's
    -- OWN still-open punch to 'auto_gps' under his own session. Everything else is frozen, so the
    -- 'offline' stamp survives to be seen on the timecard.
    if new.source is distinct from old.source
       and not (old.status <> 'closed'
                and new.source = 'auto_gps'
                and old.source in ('app', 'manual', 'offline')) then
      raise exception 'Only office staff can change how a punch was recorded.';
    end if;

    -- ── 0143, unchanged: pay-relevant columns on an UNPAID row ────────────────
    if new.clock_in is distinct from old.clock_in then
      raise exception 'Only office staff can change a shift start.';
    end if;
    if new.rate_override is distinct from old.rate_override then
      raise exception 'Only office staff can set a pay rate.';
    end if;
    if new.profile_id is distinct from old.profile_id
       or new.org_id is distinct from old.org_id then
      raise exception 'Only office staff can reassign a time entry.';
    end if;

    -- ── A SHIFT LONGER THAN A DAY IS A MISTAKE, NOT A SHIFT (0169) ────────────
    -- The open-row branch below caps clock_out at now+5min but never capped the SPAN, so an old
    -- open row could be closed into hundreds of paid hours in one PATCH.
    if new.status = 'closed' and new.clock_out is not null
       and new.clock_out - new.clock_in > interval '18 hours' then
      raise exception 'That shift is longer than a day — ask the office to close it.';
    end if;

    if old.status = 'closed' then
      if new.status is distinct from old.status then
        raise exception 'Ask the office to reopen a finished shift.';
      end if;
      if new.clock_out is distinct from old.clock_out then
        raise exception 'Ask the office to correct a finished shift.';
      end if;
      if new.miles is distinct from old.miles then
        raise exception 'Ask the office to correct the miles on a finished shift.';
      end if;
      -- Lunch may only grow (the auto-close catch-up prompt's after-the-fact answer raises it;
      -- lowering it would ADD paid hours). UNCHANGED by 0248 — this is the guard that matters.
      if coalesce(new.lunch_minutes, 0) < coalesce(old.lunch_minutes, 0) then
        raise exception 'Only office staff can lower the lunch on a finished shift.';
      end if;
    else
      -- ── open row being closed ──
      if new.clock_out is not null and new.clock_out > now() + interval '5 minutes' then
        raise exception 'A shift cannot end in the future.';
      end if;
      if new.clock_out is not null and new.clock_out < new.clock_in then
        raise exception 'A shift cannot end before it started.';
      end if;
      if coalesce(new.miles, 0) < 0 then
        raise exception 'Miles cannot be negative.';
      end if;
      -- 0248: the >5h / 30-minute lunch FLOOR that used to live here is gone. Lunch is opt-in;
      -- a shift closed with 0 minutes is a shift nobody took a lunch on, not a rule dodge.
    end if;
  end if;

  return new;
end;
$function$;
