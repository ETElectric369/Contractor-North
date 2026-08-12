-- 0193 — A FORGOTTEN CLOCK-OUT STOPS LOCKING SOMEBODY OUT OF THEIR OWN TIMECARD.
--
-- Audit 6. 0169 added a ceiling: a shift longer than 18 hours cannot be closed by the person who
-- worked it. That ceiling is RIGHT and it stays — without it, an unnoticed close writes the full
-- span into payroll, and 71 hours is not a shift.
--
-- What it accidentally built is a trap. Brian clocks in Friday 07:00 and forgets to clock out (no
-- geofence anchor, or GPS permission never granted, so nothing auto-closes it). Monday 06:45:
--
--   · he taps Clock Out  → the guard refuses: "That shift is longer than a day."
--   · he taps Clock In   → one_open_entry_per_user refuses: "You're already clocked in."
--
-- He cannot record ANY time until somebody at a desk notices. On a Monday morning, in a truck,
-- that is a work stoppage — and every hour he works while stuck is an hour nobody is recording.
--
-- ── WHY NOT JUST CAP THE CLOSE AT 18 HOURS ──────────────────────────────────────────────────
--
-- Because that writes ~17.5 PAID HOURS for a shift that was really 8. The database would be
-- inventing payroll, which is exactly what 0143 and 0169 exist to stop, and it converts a loud
-- recoverable stoppage into a quiet overpayment nobody sees unless they read the card. Under this
-- project's own money laws that is strictly worse than the bug.
--
-- ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────────────────────
--
-- The harm is the BLOCKED NEXT PUNCH, so the fix belongs on the INSERT, not the close. When a
-- non-staff punch-in finds the caller already holds an open row older than the ceiling, that stale
-- row is closed first at the only time nobody has to invent: `clock_out = clock_in`. A ZERO-hour
-- closed row.
--
-- Zero is the only honest default. It can never overpay, it cannot be mistaken for real work, and
-- the office restores the true hours from the same screen it already uses. `source` is left intact
-- and `auto_closed_reason` records why, so the card says what happened rather than presenting a
-- mystery.
--
-- IT LIVES IN THE DATABASE, not in clockInInner. 0169's own header is the argument: a tech holding
-- the anon key can POST straight to PostgREST past every line of TypeScript. A rule that only the
-- app applies is a convention.

-- The row has to SAY why it is zero, or it is a mystery on somebody's timecard — and a mystery on
-- a timecard is how a real day quietly goes unpaid. No index: it is read with the row it explains.
alter table public.time_entries
  add column if not exists auto_closed_reason text;

comment on column public.time_entries.auto_closed_reason is
  'Why this shift was closed by the system rather than by the person. Set by 0193 when a forgotten punch is zero-closed to unblock the next one; null on every ordinary shift.';

create or replace function public.close_stale_open_entry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ceiling constant interval := interval '18 hours';
begin
  -- Only a genuine new OPEN punch by this person triggers the sweep.
  if new.status is distinct from 'open' then
    return new;
  end if;

  update public.time_entries
     set status = 'closed',
         -- The one time that is not a guess. Never now(), never clock_in + 18h.
         clock_out = clock_in,
         lunch_minutes = 0,
         auto_closed_reason = 'forgotten — closed at zero hours so the next punch could start; office to correct'
   where profile_id = new.profile_id
     and org_id = new.org_id
     and status = 'open'
     and id is distinct from new.id
     and now() - clock_in > v_ceiling;

  return new;
end
$function$;

drop trigger if exists close_stale_before_punch on public.time_entries;
create trigger close_stale_before_punch
  before insert on public.time_entries
  for each row execute function public.close_stale_open_entry();

comment on function public.close_stale_open_entry() is
  'A punch-in closes the caller''s own forgotten shift (older than 18h) at ZERO hours first, so 0169''s ceiling stops locking somebody out of their own timecard. Zero because it is the only time nobody has to invent — it can never overpay, and the office restores the real hours (0193).';
