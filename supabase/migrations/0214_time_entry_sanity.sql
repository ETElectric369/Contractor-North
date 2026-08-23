-- 0214 — two role-independent sanity guards on time_entries, from the v800 audit's forensics
-- lens, which found BOTH of these already in production.
--
-- 0169's overlap and span guards live inside `if not is_org_staff() and not
-- is_privileged_writer()`, so every office-entered timecard bypasses them entirely. What the
-- live data showed:
--   · Brian Taylor, 2026-08-18 — two byte-identical manual entries (18:30→20:00) plus an app
--     punch across the same window: 4.65 h recorded for a 1.82 h span.
--   · Chris Taylor (owner), 2026-07-28 → 2026-08-06 — a 9-day forgotten punch closed as a
--     216.99 h shift, carrying a 215.80 h labor allocation on a live job. Unbilled, but worth
--     $23,738 the moment anyone imported labor from that job.
-- A 216-hour shift is a mistake regardless of who recorded it, and nobody ever needs two
-- byte-identical entries. These guards are added as a SEPARATE trigger rather than by rewriting
-- guard_paid_time_entry, so 0169/0095's carefully-tuned role logic is left exactly as it stands.

create or replace function public.guard_time_entry_sanity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_span interval;
begin
  -- ── 1. NEVER TWO IDENTICAL ENTRIES ──────────────────────────────────────────────────────
  -- Unambiguous: a correction is an EDIT, and a second job on the same day has different
  -- times. This cannot refuse legitimate office work, so it applies to everyone.
  if new.clock_in is not null and new.clock_out is not null then
    if exists (
      select 1 from public.time_entries t
       where t.profile_id = new.profile_id
         and t.id is distinct from new.id
         and t.clock_in = new.clock_in
         and t.clock_out = new.clock_out
    ) then
      raise exception 'That exact shift is already recorded for this person — edit the existing one instead of adding a copy.';
    end if;
  end if;

  -- ── 2. A SHIFT LONGER THAN 18 HOURS IS A FORGOTTEN PUNCH, WHOEVER RECORDED IT ────────────
  -- The escape hatch is honesty, not role: an entry that CARRIES A REASON is an acknowledged
  -- correction (that is what auto_closed_reason means everywhere else in this schema), so the
  -- office can still record and annotate a known-bad row — and can always fix the times, which
  -- brings the span back under the ceiling anyway.
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
  'Role-independent time-entry sanity (0214): no byte-identical duplicates, no >18h span without a stated reason, no negative span. 0169s guards only cover non-staff.';

-- zz_ so it sorts after stamp_org_time_entries and the existing guards; it reads only columns
-- present on the incoming row, so order is not load-bearing — the name just makes that explicit.
drop trigger if exists zz_guard_time_entry_sanity on public.time_entries;
create trigger zz_guard_time_entry_sanity
  before insert or update of clock_in, clock_out on public.time_entries
  for each row execute function public.guard_time_entry_sanity();
