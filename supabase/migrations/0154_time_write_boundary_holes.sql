-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0154: close the three holes the 2026-07-25 audit found around 0143.
--
-- 0143 shut the door on a tech rewriting their own entry's pay columns — but only
-- on UPDATE, only on time_entries, and only once the row is closed. Three ways
-- through remained, all reachable with the session token + the anon key that ships
-- in the client bundle (RLS is the real write boundary — the server actions' staff
-- gates are skipped entirely by a direct PostgREST call):
--
--   (A) INSERT was never guarded. 0143's own header says "this trigger is UPDATE-only".
--       POST /rest/v1/time_entries {"profile_id":"<self>","status":"closed",
--       "clock_in":…,"clock_out":…+12h,"lunch_minutes":0,"rate_override":150}
--       fabricates a 12h shift at a self-chosen wage. markPeriodPaid snapshots it.
--
--   (B) An OPEN row's clock_out/miles/lunch were unbounded, because the closed-row
--       branch only runs when old.status = 'closed'. A tech closing their own open
--       row could write clock_out = clock_in + 17h with lunch 0 and 180 miles.
--
--   (C) time_allocations had no guard at all. Allocations don't touch pay, but they
--       decide what the CUSTOMER is billed and which job carries the cost: a tech
--       could POST 40 hours against another job on a settled entry and the next
--       T&M invoice would bill hours nobody worked.
--
-- Legitimate paths re-verified against each rule below.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── (A) + (B): one trigger, now on INSERT as well ──────────────────────────
-- Trusted server contexts must never be caught by a guard aimed at a tech's browser:
-- the service role (cron/webhook code that already bypasses RLS by design) and the
-- superuser a migration or data-repair script runs as. Without this, an ops fix like
-- "restore the allocation that got wiped" fails with a message written for a tech.
-- NB: must NOT key on current_user — these guards are SECURITY DEFINER, so inside them
-- current_user is the function OWNER (postgres) for every caller, which would exempt
-- everyone and silently disable the guard. Key on the REQUEST instead: PostgREST always
-- sets request.jwt.claims, so an absent claim means a direct database connection (a
-- migration or ops repair script), and an explicit service_role claim is trusted server code.
create or replace function public.is_privileged_writer()
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
      or coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') = 'service_role';
$$;

create or replace function public.guard_paid_time_entry()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  gross_hours numeric;
begin
  -- ═══ INSERT: a member may only punch themselves IN ═══
  -- Legitimate tech insert path is clockIn() alone: status 'open', no clock_out, no
  -- rate, no payroll locks, clock_in within its own picker window (up to 31 days back,
  -- never the future). createManualEntry and duplicateTimeEntry are staff-only.
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
      if new.clock_in < now() - interval '31 days' then
        raise exception 'That start time is too far back — ask the office to add it.';
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
      -- Lunch may only grow (completeAutoClockOut's after-the-fact answer raises it;
      -- lowering it would ADD paid hours).
      if coalesce(new.lunch_minutes, 0) < coalesce(old.lunch_minutes, 0) then
        raise exception 'Ask the office to reduce the lunch on a finished shift.';
      end if;
    else
      -- ── (B) NEW: bounds while the row is still OPEN ────────────────────────
      -- clockOut/geoClockOut write clock_out ≈ now. Anything meaningfully ahead of
      -- now is a fabricated shift, not a punch.
      if new.clock_out is not null and new.clock_out > now() + interval '5 minutes' then
        raise exception 'A shift cannot end in the future.';
      end if;
      if new.clock_out is not null and new.clock_out <= new.clock_in then
        raise exception 'A shift must end after it starts.';
      end if;
      if coalesce(new.miles, 0) < 0 then
        raise exception 'Miles cannot be negative.';
      end if;
      -- THE lunch rule (lib/lunch-rule.ts) is unconditional since cn-v537: a shift over
      -- 5 gross hours carries a 30-minute unpaid lunch. Enforce the FLOOR here so a
      -- crafted close can't skip it — the app already sends 30, so this is a no-op for
      -- every real punch. Staff (the branch above) may still set 0 for a worked-through
      -- lunch, which is the documented office correction.
      if new.status = 'closed' and new.clock_out is not null then
        gross_hours := extract(epoch from (new.clock_out - new.clock_in)) / 3600.0;
        if gross_hours > 5 then
          new.lunch_minutes := greatest(coalesce(new.lunch_minutes, 0), 30);
        end if;
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_paid_time_entry on public.time_entries;
create trigger guard_paid_time_entry before insert or update on public.time_entries
  for each row execute function public.guard_paid_time_entry();

comment on function public.guard_paid_time_entry() is
  'Non-staff write guard on time_entries. INSERT: punch-in only (status open, no '
  'clock_out/rate_override/payroll locks, clock_in within the picker window). UPDATE: '
  'settled rows frozen (0095); clock_in, rate_override, profile_id/org_id never move '
  '(0143); a closed row''s clock_out/miles/status are fixed and lunch may only grow; an '
  'open row''s clock_out is bounded to now and the >5h auto-lunch floor is applied (0154).';

-- ── (C) time_allocations: billing/cost integrity at the write boundary ──────
create or replace function public.guard_time_allocation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ent           record;
  worked_hours  numeric;
  other_hours   numeric;
  this_hours    numeric;
begin
  if public.is_org_staff() or public.is_privileged_writer() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select clock_in, clock_out, lunch_minutes, paid_at, mileage_paid_at, status
    into ent
    from public.time_entries
   where id = coalesce(new.time_entry_id, old.time_entry_id);
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- A settled shift's split is history: changing it re-bills a customer (or moves cost
  -- off a job) for hours that were already paid and reconciled.
  if ent.paid_at is not null or ent.mileage_paid_at is not null then
    raise exception 'That shift is in a paid period — ask the office to undo it on Payroll first.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if coalesce(new.hours, 0) < 0 then
    raise exception 'Allocated hours cannot be negative.';
  end if;

  -- THE no-over-bill law (C7), enforced where it cannot be bypassed: the split may never
  -- total more than the shift actually worked. Mirrors clampAllocationHours in the server
  -- actions, which a direct PostgREST insert skips entirely.
  if ent.clock_out is not null then
    worked_hours := extract(epoch from (ent.clock_out - ent.clock_in)) / 3600.0
                    - coalesce(ent.lunch_minutes, 0) / 60.0;
    select coalesce(sum(hours), 0) into other_hours
      from public.time_allocations
     where time_entry_id = new.time_entry_id
       and (tg_op = 'INSERT' or id <> new.id);
    this_hours := coalesce(new.hours, 0);
    -- 0.01h slack matches the app's rounding tolerance.
    if other_hours + this_hours > worked_hours + 0.01 then
      raise exception 'That split adds up to more hours than the shift worked.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_time_allocation on public.time_allocations;
create trigger guard_time_allocation before insert or update or delete on public.time_allocations
  for each row execute function public.guard_time_allocation();

comment on function public.guard_time_allocation() is
  'Non-staff write guard on time_allocations (0154). Allocations decide what the CUSTOMER '
  'is billed and which job carries the cost, so: a settled shift''s split is frozen, hours '
  'are non-negative, and a split may never exceed the entry''s worked hours (the C7 '
  'no-over-bill law, enforced at the write boundary rather than only in the server action).';
