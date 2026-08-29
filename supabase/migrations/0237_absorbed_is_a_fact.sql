-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0237: "absorbed into its job" is a FACT, not a per-surface guess
--
-- The audit confirmed the same defect from five angles: the rule "a work-type appointment with a
-- job_id is superseded" lived as an INFERENCE re-implemented in the calendar grid — and nowhere
-- else. My Day still listed the ghost beside its job, the inbox still nagged it, Google Calendar
-- still pushed it, reminder emails still fired from it. Worse, the inference was WRONG for a
-- service call deliberately created ON a job (a return visit): same shape, not a conversion —
-- and the calendar hid a real confirmed visit entirely.
--
-- The tenant-isolation law, generalized: a rule at one read path is a convention, not a boundary.
-- So the conversion now WRITES the fact, and every surface reads the column.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.appointments add column if not exists absorbed boolean not null default false;

comment on column public.appointments.absorbed is
  'This booking was converted INTO the job it links — the job is now the work''s one calendar '
  'presence, and every surface (calendar, My Day, inbox, gcal push, reminders) skips absorbed '
  'rows. A visit merely ATTACHED to a job (a return trip, an inspection) is NOT absorbed and '
  'stays fully live.';

-- Backfill: exactly the set the old inference hid — conversions, where the appointment and its
-- job are the same piece of work.
update public.appointments set absorbed = true
 where job_id is not null and type in ('job', 'service_call');
