-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0368: a visit can wait for a day
--
-- Wave 1 round 2, lane 6 (the job page lane owns the visit page's Unschedule this round). 0367 is
-- lane 5's; this is the only other migration in the round.
--
-- ═══ APPLY ORDER ═══════════════════════════════════════════════════════════════════════════
--   Any time. It only RELAXES a column: no reader or writer on main breaks when it lands, before or
--   after the release (every reader already treats a missing start as "waiting for a day", below).
--   Until it lands, the visit page's Clear The Date says in words that it needs this update (the
--   action reads Postgres' 23502), instead of failing with a raw database error.
--   NEVER PRACTICE IT ON PRODUCTION: ALTER TABLE takes an ACCESS EXCLUSIVE lock on appointments for
--   the moment it runs (catalog only, no rewrite, no scan), and a practice inside BEGIN ... ROLLBACK
--   holds it until the rollback, while My Day, the schedule and every visit page wait on it.
--   THE TEST DATABASE: src/lib/dateless-visit.integration.test.ts applies this file inside its own
--   rolled-back transaction when the database doesn't have it yet; CI's check-test-db wants the
--   file applied to the test database (scripts/test-db/rebuild.cjs, or the integrator's apply).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- THE DEAD DOOR (found on production, 2026-09-27). The visit page's Unschedule ("Clear the date",
-- appointments/unschedule-button.tsx → unscheduleAppointment) writes starts_at = null so a visit
-- whose customer said "we'll get back to you" waits on the schedule's rail under Waiting For A Day,
-- placeable with one tap. But 0042 made appointments.starts_at NOT NULL and no migration ever relaxed
-- it (0052 relaxed schedule_proposals.job_id, not this), so every press failed with a database error.
--
-- WHY THE COLUMN, NOT THE DOOR. Every reader was already written for a dateless booking:
--   · the schedule's rail reads `starts_at is null` visits (schedule/page.tsx "a booking with no time
--     on it yet") and places them with rescheduleAppointment (placeAppointmentOnDay);
--   · calendar-sync pushes only a visit with a start (`Boolean(appt.starts_at)`): no start is a Google
--     delete; the story, the visit page, the edit form (toLocal), Nort's spokenWhen ("no time set"),
--     the link offer and the lead/visit city readers all guard a null start;
--   · My Day, the schedule calendar, the crew board, Needs You, the reminders and Nort's schedule
--     overview read a date RANGE, which a null start never falls in, so a waiting visit is never
--     drawn on a day it doesn't have;
--   · 0229 (how long will it take) already filters `starts_at is not null`.
-- The two lists that sorted by start with no range (the walk-throughs list, search) now put a
-- dateless visit last. So the column is relaxed, and the door works as it was written to.
--
-- ONE TRANSACTION. apply-migration.cjs (production) and scripts/test-db/rebuild.cjs (the test
-- database) wrap the file in begin/commit; the file holds none of its own, so a suite can run it
-- inside its own rolled-back transaction. lock_timeout 5s: queued behind a long transaction on
-- appointments, it gives up and changes nothing instead of stalling the app.
--
-- SAFE TO RUN TWICE: dropping NOT NULL from a nullable column is a no-op. It writes no company data
-- and backfills nothing.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '15s';

alter table public.appointments alter column starts_at drop not null;

comment on column public.appointments.starts_at is
  'When the visit starts. Null = waiting for a day (0368): the customer will call back; the schedule''s rail lists it under Waiting For A Day and placing it sets the start. Range readers (My Day, the calendar) never draw it.';

-- ── THE CHECK ───────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'appointments' and c.column_name = 'starts_at' and c.is_nullable = 'NO'
  ) then
    raise exception '0368: appointments.starts_at is still NOT NULL. Nothing was changed.';
  end if;
end
$chk$;
