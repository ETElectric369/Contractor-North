-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0143: a tech may not rewrite their OWN entry's pay-relevant columns.
--
-- THE HOLE. 0004's time_entries_update policy is
--   using (org_id = auth_org_id() and (profile_id = auth.uid() or is_org_staff()))
-- with no column restriction, and 0095's guard_paid_time_entry() only raises when
-- the row is ALREADY settled (paid_at / mileage_paid_at) or when the locks
-- themselves move. An UNPAID row owned by the caller therefore passes through with
-- clock_in, clock_out, lunch_minutes, miles and rate_override all writable.
--
-- The staff-only rule lives entirely in the server action (requireStaff in
-- updateTimeEntry), and a direct PostgREST PATCH with the session token skips it:
--   PATCH /rest/v1/time_entries?id=eq.<own open entry>  {"clock_in":"…T05:00:00Z"}
-- moves ten unpaid starts back two hours, /payroll totals 100h instead of 80h,
-- markPeriodPaid snapshots the inflated gross into payroll_runs, and the accountant
-- export carries it. Nothing in the app flags it. Same reasoning as 0139: RLS is
-- the real write boundary, so the invariant is enforced HERE, not just in the action.
--
-- Column-level GRANTs can't express this (they're role-wide, and staff actions use
-- the same `authenticated` role via the user JWT), so the trigger grows the rule.
--
-- THE LEGITIMATE TECH WRITE-PATHS ALL STILL PASS — verified one by one:
--   clockIn            INSERT (this trigger is UPDATE-only)
--   clockOut           updates an OPEN row: clock_out/lunch_minutes/miles/status
--   switchJob          job_id, job_code, notes, gps_in
--   adoptGeofenceAnchor gps_in on an open row
--   saveEntryNotes     notes, translated_notes
--   completeAutoClockOut lunch_minutes on a CLOSED row — allowed only UPWARD (more
--                      unpaid lunch = fewer paid hours; it can never inflate pay)
--   updateTimeEntry / createManualEntry / payroll — staff, whole branch skipped
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.guard_paid_time_entry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_org_staff() then
    -- ── 0095, unchanged: a settled row is frozen, and the locks are staff-only ──
    if old.paid_at is not null or old.mileage_paid_at is not null then
      raise exception 'Entry is in a paid period — ask the office to undo it on Payroll first.';
    end if;
    if new.paid_at is distinct from old.paid_at
       or new.mileage_paid_at is distinct from old.mileage_paid_at then
      raise exception 'Only office staff can change payroll locks.';
    end if;

    -- ── new: pay-relevant columns on an UNPAID row ────────────────────────────
    -- A shift start is set once, by the punch. Nothing a tech does afterwards moves it.
    if new.clock_in is distinct from old.clock_in then
      raise exception 'Only office staff can change a shift start.';
    end if;
    -- The pay rate is an office decision (payroll-math reads rate_override ahead of
    -- the profile rate, so a self-set override IS a self-set wage).
    if new.rate_override is distinct from old.rate_override then
      raise exception 'Only office staff can set a pay rate.';
    end if;
    -- Whose shift it is, and which org's books it lands in, are never self-service.
    if new.profile_id is distinct from old.profile_id
       or new.org_id is distinct from old.org_id then
      raise exception 'Only office staff can reassign a time entry.';
    end if;

    if old.status = 'closed' then
      -- Reopening a finished shift would hand back the open-row allowances below.
      if new.status is distinct from old.status then
        raise exception 'Ask the office to reopen a finished shift.';
      end if;
      -- clock_out and miles are fixed once the shift is closed.
      if new.clock_out is distinct from old.clock_out then
        raise exception 'Ask the office to correct a finished shift.';
      end if;
      if new.miles is distinct from old.miles then
        raise exception 'Ask the office to correct the miles on a finished shift.';
      end if;
      -- Lunch may only grow. completeAutoClockOut (the after-the-fact "did you take
      -- lunch?" answer) needs to raise it; lowering it would ADD paid hours, which is
      -- an office correction.
      if coalesce(new.lunch_minutes, 0) < coalesce(old.lunch_minutes, 0) then
        raise exception 'Ask the office to reduce the lunch on a finished shift.';
      end if;
    end if;
  end if;
  return new;
end $$;

-- Recreate the trigger so a redeployed function is definitely the one bound.
drop trigger if exists guard_paid_time_entry on public.time_entries;
create trigger guard_paid_time_entry before update on public.time_entries
  for each row execute function public.guard_paid_time_entry();

comment on function public.guard_paid_time_entry() is
  'Non-staff write guard on time_entries. Settled rows are frozen (0095); on unpaid '
  'rows a member may not move clock_in, rate_override, profile_id/org_id, and — once '
  'the shift is closed — clock_out, miles or status, and may only INCREASE lunch. '
  'Mirrors the requireStaff gate in updateTimeEntry at the real write boundary (0143).';
